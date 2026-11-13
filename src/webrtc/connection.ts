// The connection and channel classes behind `createWebRTC`, and their drive of the stack. What they
// promise a caller is written on the interfaces in ./index, which is the entry's whole surface.
import type * as api from './index'

export interface Stack {
  memory: WebAssembly.Memory
  _initialize(): void
  rtc_alloc(length: number): number
  rtc_free(pointer: number, length: number): void
  rtc_new(
    certificate: number,
    certificateLength: number,
    key: number,
    keyLength: number,
    ip: number,
    port: number,
    maxMessageSize: number,
    sendBufferSize: number,
  ): number
  rtc_delete(connection: number): void
  rtc_open(connection: number, label: number, length: number): number
  rtc_accept_offer(connection: number, sdp: number, length: number): number
  rtc_accept_answer(connection: number, sdp: number, length: number): number
  rtc_accepts(connection: number, ip: number, port: number, data: number, length: number): number
  rtc_receive(connection: number, ip: number, port: number, data: number, length: number): number
  rtc_timeout(connection: number): number
  rtc_poll(connection: number): number
  rtc_write(connection: number, channel: number, binary: number, data: number, length: number): number
  rtc_buffered(connection: number, channel: number): number
  rtc_close_channel(connection: number, channel: number): void
  rtc_close(connection: number): void
  rtc_out_ptr(connection: number): number
  rtc_out_len(connection: number): number
  rtc_arg(connection: number): number
  rtc_port(connection: number): number
}

// what rtc_poll answers, as in webrtc/src/lib.rs
const TIMEOUT = 0
const TRANSMIT = 1
const OPEN = 2
const BINARY = 3
const TEXT = 4
const CHANNEL_CLOSED = 5
const CONNECTED = 6
const UNREACHABLE = 7
const CLOSED = 8

/** Chromium's two numbers: the largest message it sends, and the queue at which `send` throws. */
export const MAX_MESSAGE_SIZE = 262144
const SEND_QUEUE_LIMIT = 16 * 1024 * 1024

/**
 * Datagrams a socket is handed each time the count starts again, which is once in a task and
 * once in a millisecond at most: 128 in a task, and 256 within a millisecond when two counts
 * meet. A window that opens all at once, on a write into an idle connection or on a
 * retransmission timeout, is about a thousand datagrams once the send buffer is 1 MiB or more,
 * and a socket puts what one task hands it on the wire together. libtorrent 2.1 ends a
 * connection on reading 1000 datagrams with its socket never empty: with the send buffer at
 * 4 MiB, 11 of 35 uploads of 256 MiB over a 50 ms round trip ended that way, and none of 66
 * with this bound. At the default send buffer a window is some 220 datagrams.
 */
const MAX_BURST = 128

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ignore = () => {}

export const ipv4 = (text: string) => {
  const parts = text.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined
  return parts.reduce((ip, part) => ip * 256 + Number(part), 0)
}

const dotted = (ip: number) => `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`

/**
 * An address a relay sends to. The ranges are the ones a relay refuses: private, loopback,
 * link-local, shared, IETF protocol, documentation, benchmark, multicast and reserved.
 */
const isPublic = (ip: number) => {
  const a = ip >>> 24
  const b = (ip >>> 16) & 255
  const c = (ip >>> 8) & 255
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
}

/** `a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ ...` */
const publicCandidatesOnly = (sdp: string) =>
  sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true
      const ip = ipv4(line.split(' ')[4] ?? '')
      return ip !== undefined && isPublic(ip)
    })
    .join('\r\n')

/**
 * Gives a class the platform's `on` handlers for `types`. A handler is a listener, in the place
 * its first one was set: it sees an event as any listener does, and what it throws is reported
 * by the dispatch and never unwinds the stack's drain.
 */
function handlers(target: { prototype: EventTarget }, ...types: string[]) {
  for (const type of types) {
    const handler = Symbol(`on${type}`)
    Object.defineProperty(target.prototype, `on${type}`, {
      get() {
        return this[handler] ?? null
      },
      set(value) {
        if (!(handler in this)) this.addEventListener(type, (event: Event) => this[handler]?.call(this, event))
        this[handler] = typeof value === 'function' ? value : null
      },
    })
  }
}

const failure = (message: string) => new DOMException(message, 'OperationError')

type Description = { readonly type: 'offer' | 'answer'; readonly sdp: string }
type Message = { bytes: Uint8Array; binary: boolean }

/** One factory: the wasm instance, the socket, and which connection each remote address belongs to. */
export class Host {
  readonly connections = new Set<Connection>()
  readonly routes = new Map<string, { connection: Connection; ip: number }>()
  dropped = 0
  closed = false
  /** Datagrams handed to the socket since `#turned`, on the clock of `performance.now()`. */
  #burst = 0
  #turned = 0
  /**
   * The socket has been handed a datagram and the microtasks have not run since. They run when
   * a task's own code is over, so this is "in this task" for a socket that delivers its
   * datagrams from a task, as node's and @fkn/lib's do.
   */
  #spent = false
  /** Datagrams that wait for a later millisecond, oldest first: at most what the stack has in flight. */
  #held: [Uint8Array, number, string][] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #scratch = 0
  #scratchLength = 0

  constructor(
    readonly x: Stack,
    readonly socket: api.DatagramSocket,
    readonly ip: number,
    readonly port: number,
    readonly allowPrivateCandidates: boolean,
    readonly sendBufferSize: number,
    readonly certificate: Uint8Array,
    readonly key: Uint8Array,
    /** What the stack wrote to standard error, which it does only when it panics. */
    readonly panic: { text: string },
  ) {
    socket.on('message', this.receive)
    socket.on('error', this.fail)
    socket.on('close', this.fail)
  }

  /**
   * Hands the socket a datagram, or holds it once MAX_BURST have gone out in this millisecond.
   * A closing factory holds nothing: the last words of every connection go out, however many.
   */
  transmit(data: Uint8Array, port: number, address: string) {
    if (this.closed || this.#burst < MAX_BURST) {
      this.#burst++
      if (!this.#spent) {
        this.#spent = true
        queueMicrotask(() => {
          this.#spent = false
        })
      }
      this.socket.send(data, port, address, ignore)
    } else {
      this.#held.push([data, port, address])
      this.#wait()
    }
  }

  /** What is held goes out on the next arrival, or on this timer when nothing arrives. */
  #wait() {
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#turn()
    }, 1)
  }

  /**
   * Starts the next millisecond once this one is over, with what was held first. Only in a task
   * that has handed the socket nothing yet, on a datagram's arrival or on the timer: what one
   * task hands a socket can leave together, the clock also moves inside a task, and a socket
   * may deliver any number of datagrams in one (@fkn/lib's delivers a whole port message).
   */
  #turn() {
    const now = performance.now()
    if (now - this.#turned >= 1) {
      this.#turned = now
      this.#burst = 0
      try {
        for (const datagram of this.#held.splice(0, MAX_BURST)) this.transmit(...datagram)
      } catch (error) {
        // no connection's operation is running to catch it: a socket whose send throws has failed
        this.fail(error as Error)
      }
    }
    if (this.#held.length) this.#wait()
  }

  /** Copies `bytes` into the stack's memory, where they stay until the next `put`. */
  put(bytes: Uint8Array) {
    if (bytes.length > this.#scratchLength) {
      if (this.#scratchLength) this.x.rtc_free(this.#scratch, this.#scratchLength)
      this.#scratchLength = Math.max(bytes.length, MAX_MESSAGE_SIZE)
      this.#scratch = this.x.rtc_alloc(this.#scratchLength)
    }
    new Uint8Array(this.x.memory.buffer, this.#scratch, bytes.length).set(bytes)
    return this.#scratch
  }

  create() {
    const { x, certificate, key } = this
    const certificatePointer = x.rtc_alloc(certificate.length)
    const keyPointer = x.rtc_alloc(key.length)
    new Uint8Array(x.memory.buffer, certificatePointer, certificate.length).set(certificate)
    new Uint8Array(x.memory.buffer, keyPointer, key.length).set(key)
    const handle = x.rtc_new(
      certificatePointer,
      certificate.length,
      keyPointer,
      key.length,
      this.ip,
      this.port,
      MAX_MESSAGE_SIZE,
      this.sendBufferSize,
    )
    x.rtc_free(certificatePointer, certificate.length)
    x.rtc_free(keyPointer, key.length)
    return handle
  }

  receive = (data: Uint8Array, remote: { address: string; port: number }) => {
    if (!this.#spent) this.#turn()
    const key = `${remote.address}:${remote.port}`
    let route = this.routes.get(key)
    if (!route) {
      const ip = ipv4(remote.address)
      const connection = ip === undefined ? undefined : this.#owner(ip, remote.port, data)
      if (ip === undefined || !connection) {
        this.dropped++
        return
      }
      route = { connection, ip }
      this.routes.set(key, route)
    }
    route.connection.receive(route.ip, remote.port, data)
  }

  /** The connection a datagram from a new address belongs to, which the stack tells from its ICE user name. */
  #owner(ip: number, port: number, data: Uint8Array) {
    const pointer = this.put(data)
    for (const connection of this.connections) {
      if (this.x.rtc_accepts(connection.handle, ip, port, pointer, data.length)) return connection
    }
    return undefined
  }

  forget(connection: Connection) {
    this.connections.delete(connection)
    for (const [key, route] of this.routes) if (route.connection === connection) this.routes.delete(key)
  }

  /** The socket failed (an error is given) or closed: no connection can go on. */
  fail = (error?: Error) => {
    const reason = error && failure(`the socket failed: ${error.message}`)
    this.close((connection) => connection.end('failed', reason))
  }

  close(end = (connection: Connection) => connection.end('closed')) {
    if (this.closed) return
    this.closed = true
    this.socket.off('message', this.receive)
    this.socket.off('error', this.fail)
    this.socket.off('close', this.fail)
    // the data that waits never goes out
    this.#held.length = 0
    for (const connection of this.connections) end(connection)
  }
}

class Channel {
  readonly target = new RTCDataChannel(this)
  /** The number the stack knows it by, once it has been handed to the stack. */
  index = -1
  state: RTCDataChannelState = 'connecting'
  /** The stack has the stream open and has not been asked to close it. */
  streaming = false
  readonly queue: Message[] = []
  queuedBytes = 0
  /** Bytes the stack holds, written and not yet acknowledged by the peer, as last measured. */
  inStack = 0
  /** The peer may have acknowledged some since: measure again before trusting `inStack`. */
  stale = false
  threshold = 0
  /** Above the threshold since the last `bufferedamountlow`. */
  high = false

  constructor(
    readonly connection: Connection,
    readonly label: string,
  ) {}

  get buffered() {
    return this.queuedBytes + this.inStack
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.state !== 'open') throw new DOMException(`the channel is ${this.state}`, 'InvalidStateError')
    // a copy: the caller may reuse its buffer once this returns
    const bytes =
      typeof data === 'string'
        ? encoder.encode(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
          : data instanceof ArrayBuffer
            ? new Uint8Array(data.slice(0))
            : undefined
    if (!bytes) throw new TypeError('a message is a string, an ArrayBuffer or a view of one')
    // str0m 0.25.0 takes an empty message and sends nothing, and the channel then waits for ever
    // on the sequence number it used up
    if (!bytes.length) throw new DOMException('an empty message cannot be sent', 'NotSupportedError')
    if (bytes.length > this.connection.sctp.maxMessageSize) {
      throw new TypeError(`the message is larger than the max message size, ${this.connection.sctp.maxMessageSize}`)
    }
    const buffered = this.buffered + bytes.length
    if (buffered > SEND_QUEUE_LIMIT) throw failure('the send queue is full')
    this.queue.push({ bytes, binary: typeof data !== 'string' })
    this.queuedBytes += bytes.length
    if (buffered > this.threshold) this.high = true
    this.connection.schedule()
  }

  close() {
    if (this.state === 'closing' || this.state === 'closed') return
    this.state = 'closing'
    const waiting = this.connection.waiting.indexOf(this)
    if (waiting < 0) return this.connection.schedule()
    this.connection.waiting.splice(waiting, 1)
    queueMicrotask(() => this.closed())
  }

  closed(error?: DOMException) {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.streaming = false
    this.queue.length = 0
    this.queuedBytes = 0
    this.inStack = 0
    this.high = false
    if (error) this.target.dispatchEvent(Object.assign(new Event('error'), { error }))
    this.target.dispatchEvent(new Event('close'))
  }
}

/**
 * One peer connection's state and its drive of the stack.
 *
 * The stack's contract is that every call which changes a connection is followed by polling it
 * until it has nothing more to say, before the next such call. So every change is an operation
 * handed to `run`, which runs them one at a time with a full drain after each. An operation asked
 * for while one is in progress, by an event handler for instance, waits its turn.
 *
 * Two calls are not operations, because they ask nothing of the stack: `rtc_accepts`, and
 * `rtc_buffered`, which str0m reads through a mutable handle and so counts as a change. Draining
 * after it as well cost 8 to 14% of the upload rate on loopback, for a read that queues nothing.
 */
class Connection {
  handle: number
  readonly channels = new Map<number, Channel>()
  /** Channels made before the stack has an association to open them on. */
  readonly waiting: Channel[] = []
  local: Description | null = null
  remote: Description | null = null
  offer: string | null = null
  answer: string | null = null
  state: RTCPeerConnectionState = 'new'
  gathering: RTCIceGatheringState = 'new'
  /**
   * Where the stack last sent data: the remote end of the pair ICE chose. Empty until it has,
   * and once the connection has ended.
   */
  peerAddress = ''
  peerPort = 0
  readonly sctp = {
    maxMessageSize: MAX_MESSAGE_SIZE,
    transport: {
      iceTransport: {
        getSelectedCandidatePair: () => (this.peerAddress ? { remote: { address: this.peerAddress, port: this.peerPort } } : null),
      },
    },
  }
  #operations: (() => unknown)[] = []
  #running = false
  #scheduled = false
  /** Milliseconds until the stack wants its next timeout, as of the last drain. */
  #wait = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #due = 0
  #gathered: ReturnType<typeof setTimeout> | undefined
  #peerClosed = false
  #trapped = false

  constructor(
    readonly host: Host,
    readonly target: RTCPeerConnection,
  ) {
    if (host.closed) throw new DOMException('the factory or its socket is closed', 'InvalidStateError')
    this.handle = host.create()
    host.connections.add(this)
  }

  run(operation?: () => unknown) {
    if (operation) this.#operations.push(operation)
    if (this.#running || !this.handle) return
    this.#running = true
    try {
      // A write the stack refused is asked again after the next operation, never at once: nothing
      // has changed in between, so it would be refused for ever, in a loop that never yields.
      let refused = false
      for (;;) {
        const asked = this.#operations.shift()
        const operation: (() => unknown) | undefined = asked ?? (refused ? undefined : this.#next())
        if (!operation) break
        refused = operation() === false
        this.#drain()
        if (!this.handle) return
        // an input may carry the peer's acknowledgements
        if (asked) for (const channel of this.channels.values()) channel.stale ||= channel.inStack > 0
      }
      this.#low()
      this.#arm()
    } catch (error) {
      this.#trapped = error instanceof WebAssembly.RuntimeError
      const text = this.#trapped ? this.host.panic.text.trim() : ''
      this.end('failed', error instanceof DOMException ? error : failure(text || String(error)))
    } finally {
      this.#running = false
    }
  }

  /**
   * As `run`, in a microtask. For what the caller asks from its own code, so that no event is
   * ever dispatched before the call that caused it has returned.
   */
  schedule(operation?: () => unknown) {
    if (operation) this.#operations.push(operation)
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      this.run()
    })
  }

  /** A stack call that fails answers a negative number and leaves its reason as text. */
  #check(code: number) {
    if (code < 0) throw failure(this.#text())
    return code
  }

  #out(handle = this.handle) {
    const { x } = this.host
    return new Uint8Array(x.memory.buffer, x.rtc_out_ptr(handle), x.rtc_out_len(handle))
  }

  #text() {
    return decoder.decode(this.#out())
  }

  #transmit(handle: number) {
    const { x } = this.host
    // copied: the socket may send after this returns, when the stack has reused its buffer
    const data = this.#out(handle).slice()
    const port = x.rtc_port(handle)
    const address = dotted(x.rtc_arg(handle))
    // A STUN message starts with 0 to 3 and goes to every candidate. Everything else is DTLS,
    // which the stack sends to the pair ICE chose and nowhere else.
    if (data[0] > 3) {
      this.peerAddress = address
      this.peerPort = port
    }
    this.host.transmit(data, port, address)
  }

  /** Everything the stack has to say after one operation. */
  #drain() {
    const { x } = this.host
    for (;;) {
      const handle = this.handle
      if (!handle) return
      const kind = this.#check(x.rtc_poll(handle))
      const arg = x.rtc_arg(handle)
      if (kind === TIMEOUT) {
        this.#wait = arg
        if (this.#peerClosed) this.end('failed')
        return
      }
      if (kind === TRANSMIT) this.#transmit(handle)
      else if (kind === OPEN) this.#opened(arg, this.#text())
      else if (kind === BINARY) this.#message(arg, this.#out().slice().buffer)
      else if (kind === TEXT) this.#message(arg, this.#text())
      else if (kind === CHANNEL_CLOSED) {
        this.channels.get(arg)?.closed()
        this.channels.delete(arg)
      } else if (kind === CONNECTED) this.#state('connected')
      else if (kind === UNREACHABLE) this.end('failed', failure('the peer stopped answering'))
      else if (kind === CLOSED) this.#peerClosed = true
    }
  }

  #opened(index: number, label: string) {
    let channel = this.channels.get(index)
    if (!channel) {
      channel = new Channel(this, label)
      channel.index = index
      this.channels.set(index, channel)
      channel.state = 'open'
      channel.streaming = channel.stale = true
      this.target.dispatchEvent(Object.assign(new Event('datachannel'), { channel: channel.target }))
    } else {
      // stale: the stack counts the message that opened the channel until the peer acknowledges it
      channel.streaming = channel.stale = true
      if (channel.state !== 'connecting') return
      channel.state = 'open'
    }
    if (channel.state === 'open') channel.target.dispatchEvent(new Event('open'))
  }

  #message(index: number, data: string | ArrayBuffer) {
    const channel = this.channels.get(index)
    if (channel) channel.target.dispatchEvent(new MessageEvent('message', { data }))
  }

  /**
   * What the connection does of its own accord once nothing is asked of it: hand the stack one
   * queued message it has room for, or close a channel that has sent everything. Undefined when
   * there is none of that. The operation answers false when the stack refused the write.
   */
  #next(): (() => unknown) | undefined {
    const { x, sendBufferSize } = this.host
    // one send buffer for the whole connection
    let room = sendBufferSize
    for (const channel of this.channels.values()) {
      if (!channel.streaming) continue
      if (channel.stale) {
        channel.stale = false
        channel.inStack = x.rtc_buffered(this.handle, channel.index)
      }
      room -= channel.inStack
    }
    for (const channel of this.channels.values()) {
      if (!channel.streaming) continue
      const message = channel.queue[0]
      if (message && message.bytes.length <= room) return () => this.#write(channel, message)
      if (!message && channel.state === 'closing' && !channel.inStack) {
        return () => {
          channel.streaming = false
          x.rtc_close_channel(this.handle, channel.index)
        }
      }
    }
    return undefined
  }

  #write(channel: Channel, message: Message) {
    const { x } = this.host
    const { length } = message.bytes
    const pointer = this.host.put(message.bytes)
    // The stack can refuse a write there was room for by the count in #next: it also counts the
    // message that opens another channel, until the peer acknowledges it, and that one cannot
    // be measured from here.
    if (!this.#check(x.rtc_write(this.handle, channel.index, Number(message.binary), pointer, length))) return false
    channel.queue.shift()
    channel.queuedBytes -= length
    channel.inStack += length
  }

  #low() {
    for (const channel of this.channels.values()) {
      if (!channel.high || channel.buffered > channel.threshold) continue
      channel.high = false
      queueMicrotask(() => channel.target.dispatchEvent(new Event('bufferedamountlow')))
    }
  }

  /** One timer, for the stack's next deadline. An early wake costs a call, so only an earlier deadline re-arms it. */
  #arm() {
    const due = performance.now() + this.#wait
    if (this.#timer !== undefined && due >= this.#due) return
    clearTimeout(this.#timer)
    this.#due = due
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.run(() => this.#check(this.host.x.rtc_timeout(this.handle)))
    }, this.#wait)
  }

  #state(state: RTCPeerConnectionState) {
    if (this.state === state) return
    this.state = state
    this.target.dispatchEvent(new Event('connectionstatechange'))
  }

  receive(ip: number, port: number, data: Uint8Array) {
    this.run(() => this.#check(this.host.x.rtc_receive(this.handle, ip, port, this.host.put(data), data.length)))
  }

  #alive() {
    if (!this.handle) throw new DOMException('the connection is closed', 'InvalidStateError')
  }

  /**
   * A description went into the stack. Its ICE agent schedules nothing until it has been told the
   * time once, so every such change is followed by a timeout input.
   */
  #describe(operation: () => unknown) {
    this.run(operation)
    this.run(() => this.#check(this.host.x.rtc_timeout(this.handle)))
  }

  #open(channel: Channel) {
    const label = encoder.encode(channel.label)
    channel.index = this.host.x.rtc_open(this.handle, this.host.put(label), label.length)
    this.channels.set(channel.index, channel)
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}) {
    this.#alive()
    if (
      init.ordered === false ||
      init.maxPacketLifeTime != null ||
      init.maxRetransmits != null ||
      init.negotiated ||
      init.id != null ||
      init.protocol
    ) {
      throw new DOMException('only ordered, reliable channels opened in band, with no protocol', 'NotSupportedError')
    }
    const channel = new Channel(this, label)
    if (this.remote) this.schedule(() => this.#open(channel))
    else this.waiting.push(channel)
    return channel.target
  }

  createOffer() {
    this.#alive()
    if (this.remote) throw new DOMException('this connection already has a remote description', 'InvalidStateError')
    if (!this.offer) {
      const channel = this.waiting.shift()
      if (!channel) throw new DOMException('an offer needs a data channel: there is no media to offer', 'InvalidStateError')
      this.#describe(() => {
        this.#open(channel)
        this.offer = this.#text()
      })
      // the stack failed on it, which has ended the connection
      this.#alive()
    }
    return { type: 'offer' as const, sdp: this.offer! }
  }

  createAnswer() {
    this.#alive()
    if (this.remote?.type !== 'offer' || this.local) throw new DOMException('there is no remote offer to answer', 'InvalidStateError')
    return { type: 'answer' as const, sdp: this.answer! }
  }

  setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
    this.#alive()
    const type = description?.type ?? (this.remote ? 'answer' : 'offer')
    if (type !== 'offer' && type !== 'answer') throw new DOMException(`${type} descriptions are not supported`, 'NotSupportedError')
    if (this.local) throw new DOMException('this connection already has a local description', 'InvalidStateError')
    const { sdp } = type === 'offer' ? this.createOffer() : this.createAnswer()
    if (description?.sdp && description.sdp !== sdp) {
      throw new DOMException('the description is not the one this connection created', 'InvalidModificationError')
    }
    this.local = { type, sdp }
    if (this.remote) this.#state('connecting')
    this.#gathered = setTimeout(() => this.#gather(sdp))
  }

  /** The one candidate is in the description from the start, so gathering is these four events and nothing else. */
  #gather(sdp: string) {
    const fire = (event: Event) => this.handle && this.target.dispatchEvent(event)
    const candidate = { candidate: /^a=(candidate:.*)$/m.exec(sdp)![1], sdpMid: /^a=mid:(.*)$/m.exec(sdp)![1], sdpMLineIndex: 0 }
    this.gathering = 'gathering'
    fire(new Event('icegatheringstatechange'))
    fire(Object.assign(new Event('icecandidate'), { candidate }))
    if (!this.handle) return
    this.gathering = 'complete'
    fire(new Event('icegatheringstatechange'))
    fire(Object.assign(new Event('icecandidate'), { candidate: null }))
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.#alive()
    const { type, sdp = '' } = description
    if (type !== 'offer' && type !== 'answer') {
      if (type === 'pranswer' || type === 'rollback') throw new DOMException(`${type} descriptions are not supported`, 'NotSupportedError')
      throw new TypeError(`'${String(type)}' is not a description type`)
    }
    if (this.remote || (type === 'offer' ? this.local : this.local?.type !== 'offer')) {
      throw new DOMException(`an ${type} cannot be set now`, 'InvalidStateError')
    }
    const { x } = this.host
    const text = encoder.encode(this.host.allowPrivateCandidates ? sdp : publicCandidatesOnly(sdp))
    let code = 0
    let result = ''
    this.#describe(() => {
      const pointer = this.host.put(text)
      code = type === 'offer' ? x.rtc_accept_offer(this.handle, pointer, text.length) : x.rtc_accept_answer(this.handle, pointer, text.length)
      result = this.#text()
    })
    if (code === -1) throw failure(`the description is not SDP: ${result}`)
    if (code < 0) {
      // the stack may have applied part of it
      const refusal = new DOMException(`the description was refused: ${result}`, 'InvalidAccessError')
      this.end('failed', refusal)
      throw refusal
    }
    // the stack failed on it, which has ended the connection
    this.#alive()
    this.remote = { type, sdp }
    if (type === 'offer') this.answer = result
    // RFC 8841: no attribute means 65536, and 0 means any size
    const limit = /^a=max-message-size:(\d+)/m.exec(sdp)
    this.sctp.maxMessageSize = Math.min(MAX_MESSAGE_SIZE, (limit ? Number(limit[1]) : 65536) || Infinity)
    if (this.local) this.#state('connecting')
    for (const channel of this.waiting.splice(0)) this.run(() => this.#open(channel))
  }

  /**
   * `closed` is the local close, which tells the peer. `failed` is every other end: the peer
   * closed or went quiet, the socket went, or the stack failed, and nothing more is sent.
   * Channels close either way, after an `error` event when a reason is given.
   */
  end(state: 'closed' | 'failed', error?: DOMException) {
    const { handle, host } = this
    if (!handle) {
      if (state === 'closed') this.state = state
      return
    }
    this.handle = 0
    this.#operations.length = 0
    clearTimeout(this.#timer)
    clearTimeout(this.#gathered)
    host.forget(this)
    const silently = () => {
      for (let kind; (kind = host.x.rtc_poll(handle)) > TIMEOUT; ) if (kind === TRANSMIT) this.#transmit(handle)
    }
    try {
      if (state === 'closed') {
        // a drain this was called from ends before the next change, then the close is drained
        silently()
        host.x.rtc_close(handle)
        silently()
      }
    } catch {
      // the socket is gone: the peer learns of the close from the silence
    }
    // a stack that trapped is left as it is
    if (!this.#trapped) host.x.rtc_delete(handle)
    this.peerAddress = ''
    const channels = [...this.channels.values(), ...this.waiting]
    this.channels.clear()
    this.waiting.length = 0
    for (const channel of channels) channel.state = 'closing'
    this.state = state
    queueMicrotask(() => {
      for (const channel of channels) channel.closed(error)
      if (state === 'failed') this.target.dispatchEvent(new Event('connectionstatechange'))
    })
  }
}

class RTCDataChannel extends EventTarget implements api.RTCDataChannel {
  #channel: Channel
  declare onopen: api.RTCDataChannel['onopen']
  declare onmessage: api.RTCDataChannel['onmessage']
  declare onbufferedamountlow: api.RTCDataChannel['onbufferedamountlow']
  declare onerror: api.RTCDataChannel['onerror']
  declare onclose: api.RTCDataChannel['onclose']

  constructor(channel: Channel) {
    super()
    this.#channel = channel
  }

  get label() {
    return this.#channel.label
  }

  get readyState() {
    return this.#channel.state
  }

  get binaryType(): BinaryType {
    return 'arraybuffer'
  }

  set binaryType(type: BinaryType) {
    if (type !== 'arraybuffer') throw new DOMException('binary messages arrive as ArrayBuffer only', 'NotSupportedError')
  }

  get bufferedAmount() {
    return this.#channel.buffered
  }

  get bufferedAmountLowThreshold() {
    return this.#channel.threshold
  }

  set bufferedAmountLowThreshold(bytes: number) {
    this.#channel.threshold = bytes
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    this.#channel.send(data)
  }

  close() {
    this.#channel.close()
  }
}
handlers(RTCDataChannel, 'open', 'message', 'bufferedamountlow', 'error', 'close')

export class RTCPeerConnection extends EventTarget implements api.RTCPeerConnection {
  #connection: Connection
  declare onconnectionstatechange: api.RTCPeerConnection['onconnectionstatechange']
  declare ondatachannel: api.RTCPeerConnection['ondatachannel']
  declare onicecandidate: api.RTCPeerConnection['onicecandidate']
  declare onicegatheringstatechange: api.RTCPeerConnection['onicegatheringstatechange']

  /** `createWebRTC` supplies `host`. `iceServers` is accepted and ignored: no STUN server is asked. */
  constructor(host: Host, _configuration?: RTCConfiguration) {
    super()
    this.#connection = new Connection(host, this)
  }

  get connectionState() {
    return this.#connection.state
  }

  get iceGatheringState() {
    return this.#connection.gathering
  }

  get localDescription() {
    return this.#connection.local
  }

  get remoteDescription() {
    return this.#connection.remote
  }

  get sctp() {
    const { local, remote, sctp } = this.#connection
    return local || remote ? sctp : null
  }

  createDataChannel(label: string, init?: RTCDataChannelInit) {
    return this.#connection.createDataChannel(String(label), init)
  }

  // Each of the four below starts in a microtask, so after the caller's stack has unwound and
  // never inside a drain, and runs to its end at once: calls take effect in the order they were made.

  createOffer() {
    return Promise.resolve().then(() => this.#connection.createOffer())
  }

  createAnswer() {
    return Promise.resolve().then(() => this.#connection.createAnswer())
  }

  setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
    return Promise.resolve().then(() => this.#connection.setLocalDescription(description))
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    return Promise.resolve().then(() => this.#connection.setRemoteDescription(description))
  }

  close() {
    this.#connection.end('closed')
  }
}
handlers(RTCPeerConnection, 'connectionstatechange', 'datachannel', 'icecandidate', 'icegatheringstatechange')
