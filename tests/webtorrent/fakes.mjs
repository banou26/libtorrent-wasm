// In-memory stand-ins for the three things the signalling is handed: a WebSocket with a tracker behind it, a
// class shaped like RTCPeerConnection, and a session. No native module and no socket, so every case built on
// them runs anywhere and under mocked timers. Nothing here uses setTimeout unless a test asks for a delay:
// work is deferred with microtasks and setImmediate, which node's mock timers leave alone.

/** One turn of the event loop: every microtask and every setImmediate queued so far has run. */
export const turn = () => new Promise(resolve => setImmediate(resolve))

/** Enough turns for a negotiation over the fakes to finish. */
export const settle = async (turns = 12) => { for (let i = 0; i < turns; i++) await turn() }

/** Moves mocked time forward in steps and lets promises settle between them, as real time would. */
export const advance = async (t, ms, step = 100) => {
  for (let done = 0; done < ms; done += step) {
    t.mock.timers.tick(Math.min(step, ms - done))
    await turn()
  }
}

export const until = async (what, predicate, turns = 400) => {
  for (let i = 0; i < turns; i++) {
    if (await predicate()) return
    await turn()
  }
  throw new Error(`never happened: ${what}`)
}

/**
 * Waits in real time, and fails by itself once `ms` have passed. No timer and no Date, which a case may have
 * mocked: it takes turns of the event loop and reads the clock mocking leaves alone.
 */
export const reached = async (what, predicate, ms = 5000) => {
  const deadline = performance.now() + ms
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(`never happened: ${what}`)
    await turn()
  }
}

/** The promise's own outcome, or a failure once `ms` have passed: a case that would wait forever ends by itself. */
export const within = async (what, promise, ms) => {
  let settled = false
  const outcome = promise.finally(() => { settled = true })
  outcome.catch(() => {})
  await reached(what, () => settled, ms)
  return outcome
}

export const HASH = 'aabbccddeeff00112233445566778899aabbccdd'
export const hashOf = n => n.toString(16).padStart(40, '0')
export const binary = hex => Buffer.from(hex, 'hex').toString('latin1')

/**
 * A tracker written for the tests, speaking what the reference server speaks: it counts seeders and leechers
 * by `left`, answers every announce that carries no answer, hands offer i to the i-th other peer of the swarm
 * and forwards an answer to the peer it names. Every knob the cases need is a plain field.
 */
export class TestTracker {
  sockets = new Set()
  swarms = new Map()
  /** Every message received, parsed, oldest first, and when each came by `Date.now()`. */
  received = []
  receivedAt = []
  interval = 120
  /** Peers added to the counts that are not really there. */
  phantoms = { complete: 0, incomplete: 0 }
  silent = false
  refusing = false
  held = null

  announces(hash) {
    return this.received.filter(m => m.action === 'announce' && !m.answer && (!hash || m.info_hash === binary(hash)))
  }

  receive(socket, data) {
    const message = JSON.parse(data)
    this.received.push(message)
    this.receivedAt.push(Date.now())
    if (message.answer) {
      this.swarms.get(message.info_hash)?.get(message.to_peer_id)?.socket.deliver({
        action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id,
        offer_id: message.offer_id, answer: message.answer,
      })
      return
    }
    const swarm = this.swarms.get(message.info_hash) ?? new Map()
    this.swarms.set(message.info_hash, swarm)
    if (message.event === 'stopped') swarm.delete(message.peer_id)
    else swarm.set(message.peer_id, { socket, left: message.left })
    if (this.held) this.held.push([socket, message])
    else this.respond(socket, message)
  }

  respond(socket, message) {
    if (this.silent) return
    const swarm = this.swarms.get(message.info_hash)
    const peers = [...swarm.values()]
    socket.deliver({
      action: 'announce',
      info_hash: message.info_hash,
      interval: this.interval,
      complete: peers.filter(peer => peer.left === 0).length + this.phantoms.complete,
      incomplete: peers.filter(peer => peer.left !== 0).length + this.phantoms.incomplete,
    })
    const others = [...swarm].filter(([id]) => id !== message.peer_id)
    message.offers?.forEach((offer, i) => others[i]?.[1].socket.deliver({
      action: 'announce', info_hash: message.info_hash, peer_id: message.peer_id,
      offer_id: offer.offer_id, offer: offer.offer,
    }))
  }

  /** From here announces are taken in and answered only at `release()`, all at once, as if they had arrived together. */
  hold() {
    this.held = []
  }

  release() {
    const held = this.held
    this.held = null
    for (const [socket, message] of held) this.respond(socket, message)
  }

  /** Closes every socket from the tracker's side, as a restart would. */
  drop() {
    for (const socket of [...this.sockets]) socket.lose()
  }
}

/** The WebSocket class of a network that has the given trackers on it, by URL as the client spells it. */
export const fakeWebSocket = trackers => {
  const map = new Map(Object.entries(trackers))
  return class FakeWebSocket {
    static opened = []
    /** Every frame sent on an open socket, as the text handed to `send`. */
    static frames = []
    readyState = 0
    onopen = null
    onmessage = null
    onclose = null
    onerror = null

    constructor(url) {
      this.url = url
      this.tracker = map.get(url)
      FakeWebSocket.opened.push(url)
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        if (!this.tracker || this.tracker.refusing) return this.lose()
        this.readyState = 1
        this.tracker.sockets.add(this)
        this.onopen?.({})
      })
    }

    // As a browser's: it throws only while connecting, drops what is sent once closing, and what was sent
    // before a close still arrives.
    send(data) {
      if (this.readyState === 0) throw new Error('InvalidStateError')
      if (this.readyState !== 1) return
      FakeWebSocket.frames.push(data)
      queueMicrotask(() => this.tracker.receive(this, data))
    }

    /** A frame from the tracker: an object is sent as JSON, anything else as it is. */
    deliver(frame) {
      const data = frame !== null && typeof frame === 'object' && !(frame instanceof Uint8Array) ? JSON.stringify(frame) : frame
      queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data }) })
    }

    lose() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.tracker?.sockets.delete(this)
      for (const swarm of this.tracker?.swarms.values() ?? []) {
        for (const [id, peer] of swarm) if (peer.socket === this) swarm.delete(id)
      }
      queueMicrotask(() => this.onclose?.({}))
    }

    close() {
      this.lose()
    }
  }
}

const pcs = new Map()
let nextPc = 1

/**
 * A class shaped like RTCPeerConnection whose instances find each other through the ids in their
 * descriptions. Behaviour a case needs to vary is an option of the class:
 *   gathering  'task' (candidates then complete, one task later), 'instant' (complete before
 *              setLocalDescription resolves), or { reflexiveMs, completeMs } with either left out for never
 *   completion how the end of gathering is told: 'state', 'candidate' (the null one), or both by default
 *   capacity   how many may be constructed before the constructor throws
 *   maxMessageSize  what the description advertises, and so what the other end may send; null leaves the line out
 *   rate       bytes a channel moves per task; Infinity by default
 *   address    what the other end reads as this end's remote address
 *   mute       takes and gives descriptions and then never connects
 *   stepMs     how long each signalling step takes to settle; left out, a step settles in a microtask
 *   fails      the name of a signalling step that rejects, such as 'createOffer'
 * A channel whose `onmessage` is not set by the end of the task it appeared in never hears anything, and what
 * it should have heard is counted in `stats.lost`: that is what Chrome, Firefox and WebKit were measured doing.
 * A connection closed while one of its signalling steps is in flight, or sooner than 5 ms after the last one
 * settled, is counted in `stats.early`: Chromium 156 was measured keeping the slot of such a connection. Each
 * connection keeps the two times, `steppedAt` and `closedAt`, read from `Date.now()`, so a case that asserts
 * on them mocks `Date` along with `setTimeout`.
 */
export const fakeRtc = (options = {}) => {
  const {
    gathering = 'task', completion = 'both', capacity = Infinity, maxMessageSize = 262144, rate = Infinity, address,
    mute = false, stepMs, fails,
  } = options

  class FakeDataChannel {
    binaryType = 'blob'
    readyState = 'connecting'
    bufferedAmount = 0
    bufferedAmountLowThreshold = 0
    onopen = null
    onmessage = null
    onclose = null
    onerror = null
    onbufferedamountlow = null
    peer = null
    wire = []
    moving = false
    deaf = false

    constructor(pc) {
      this.pc = pc
    }

    send(data) {
      if (this.readyState !== 'open') throw new Error('InvalidStateError')
      const bytes = typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
      if (bytes.length > this.pc.sendLimit) throw new TypeError(`message of ${bytes.length} over the limit ${this.pc.sendLimit}`)
      if (this.bufferedAmount + bytes.length > 16 * 1024 * 1024) throw new Error('OperationError: send queue is full')
      this.bufferedAmount += bytes.length
      Class.stats.sent += bytes.length
      Class.stats.maxBuffered = Math.max(Class.stats.maxBuffered, this.bufferedAmount)
      Class.stats.maxMessage = Math.max(Class.stats.maxMessage, bytes.length)
      this.wire.push(bytes)
      if (!this.moving) {
        this.moving = true
        setImmediate(() => this.move())
      }
    }

    move() {
      let budget = rate
      while (this.wire.length && budget > 0 && this.readyState === 'open') {
        const bytes = this.wire.shift()
        budget -= bytes.length
        const before = this.bufferedAmount
        this.bufferedAmount -= bytes.length
        const peer = this.peer
        if (peer?.readyState === 'open') {
          if (peer.onmessage && !peer.deaf) peer.onmessage({ data: typeof bytes === 'string' ? bytes : bytes.buffer })
          else Class.stats.lost++
        }
        if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.onbufferedamountlow?.({})
        }
      }
      if (this.wire.length && this.readyState === 'open') setImmediate(() => this.move())
      else this.moving = false
    }

    close() {
      if (this.readyState === 'closed') return
      this.readyState = 'closed'
      setImmediate(() => this.onclose?.({}))
      this.peer?.close()
    }
  }

  class Class {
    static stats = { made: 0, sent: 0, maxBuffered: 0, maxMessage: 0, lost: 0, early: 0 }
    static all = []

    iceGatheringState = 'new'
    connectionState = 'new'
    localDescription = null
    onicecandidate = null
    onicegatheringstatechange = null
    onconnectionstatechange = null
    ondatachannel = null
    sctp = null
    candidates = []
    channel = null
    remote = null
    sendLimit = 65536
    closed = false
    stepping = 0
    steppedAt = null
    closedAt = null

    constructor(configuration) {
      if (Class.stats.made >= capacity) throw new Error('UnknownError: Cannot create so many PeerConnections')
      Class.stats.made++
      Class.all.push(this)
      this.configuration = configuration
      this.id = nextPc++
      pcs.set(this.id, this)
    }

    createDataChannel() {
      return this.channel = new FakeDataChannel(this)
    }

    describe(type) {
      const limit = maxMessageSize === null ? '' : `a=max-message-size:${maxMessageSize}\r\n`
      return { type, sdp: `v=0\r\na=fake:${this.id}\r\n${limit}` }
    }

    /** One signalling step: it settles after `stepMs`, and the connection notes when. */
    async step(name, work) {
      this.stepping++
      try {
        if (stepMs !== undefined) await new Promise(resolve => setTimeout(resolve, stepMs))
        if (fails === name) throw new Error(`OperationError: ${name}`)
        return work()
      } finally {
        this.stepping--
        this.steppedAt = Date.now()
      }
    }

    createOffer() {
      return this.step('createOffer', () => this.describe('offer'))
    }

    createAnswer() {
      return this.step('createAnswer', () => this.describe('answer'))
    }

    setLocalDescription(description) {
      return this.step('setLocalDescription', () => this.takeLocal(description))
    }

    setRemoteDescription(description) {
      return this.step('setRemoteDescription', () => this.takeRemote(description))
    }

    takeLocal(description) {
      const pc = this
      this.localDescription = { type: description.type, get sdp() { return description.sdp + pc.candidates.join('') } }
      this.iceGatheringState = 'gathering'
      const candidate = (type, ip) => {
        if (this.closed) return
        const line = `candidate:1 1 udp 1 ${ip} 9 typ ${type}`
        this.candidates.push(`a=${line}\r\n`)
        this.onicecandidate?.({ candidate: { candidate: line, type } })
      }
      const complete = () => {
        if (this.closed) return
        if (completion !== 'candidate') {
          this.iceGatheringState = 'complete'
          this.onicegatheringstatechange?.({})
        }
        if (completion !== 'state') this.onicecandidate?.({ candidate: null })
      }
      if (gathering === 'instant') {
        this.candidates.push('a=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n')
        this.iceGatheringState = 'complete'
      } else if (gathering === 'task') {
        setImmediate(() => {
          candidate('host', '192.0.2.1')
          complete()
        })
      } else {
        setImmediate(() => candidate('host', '192.0.2.1'))
        if (gathering.reflexiveMs !== undefined) setTimeout(() => candidate('srflx', '198.51.100.1'), gathering.reflexiveMs)
        if (gathering.completeMs !== undefined) setTimeout(complete, gathering.completeMs)
      }
      this.connect()
    }

    takeRemote({ type, sdp }) {
      const id = Number(/a=fake:(\d+)/.exec(sdp ?? '')?.[1])
      const remote = pcs.get(id)
      if (!remote || remote.closed) throw new Error('InvalidAccessError: no such description')
      if (type === 'answer' && !this.localDescription) throw new Error('InvalidStateError')
      // A browser takes a description for what `type` says it is, and one set under the other type never connects.
      if (type !== remote.localDescription?.type) throw new Error(`InvalidAccessError: that description is not an ${type}`)
      this.remote = remote
      this.sendLimit = Number(/a=max-message-size:(\d+)/.exec(sdp)?.[1] ?? 65536)
      this.sctp = {
        maxMessageSize: this.sendLimit,
        transport: { iceTransport: { getSelectedCandidatePair: () => this.pair } },
      }
      this.connect()
    }

    /** Both ends have both descriptions: the answerer gets its channel already open, the offerer an open event. */
    connect() {
      const remote = this.remote
      if (!remote || remote.remote !== this || !this.localDescription || !remote.localDescription) return
      if (this.connectionState !== 'new' || this.mute || remote.mute) return
      const [offerer, answerer] = this.channel ? [this, remote] : [remote, this]
      for (const pc of [offerer, answerer]) pc.connectionState = 'connecting'
      setImmediate(() => {
        // A channel its maker closed before the connection was up is never opened at the other end.
        if (offerer.closed || answerer.closed || offerer.channel.readyState === 'closed') return
        for (const pc of [offerer, answerer]) {
          pc.connectionState = 'connected'
          pc.pair = { remote: { address: pc.remote.address } }
          pc.onconnectionstatechange?.({})
        }
        answerer.channel = new FakeDataChannel(answerer)
        answerer.channel.peer = offerer.channel
        offerer.channel.peer = answerer.channel
        answerer.channel.readyState = 'open'
        offerer.channel.readyState = 'open'
        // Queued before the event, so it runs after the microtasks of this task and before any later task.
        const appeared = answerer.channel
        setImmediate(() => { appeared.deaf = !appeared.onmessage })
        answerer.ondatachannel?.({ channel: appeared })
        offerer.channel.onopen?.({})
      })
    }

    get address() {
      return address
    }

    get mute() {
      return mute
    }

    close() {
      if (this.closed) return
      this.closed = true
      this.closedAt = Date.now()
      if (this.stepping || (this.steppedAt !== null && this.closedAt - this.steppedAt < 5)) Class.stats.early++
      this.connectionState = 'closed'
      pcs.delete(this.id)
      this.channel?.close()
    }
  }
  return Class
}

/** Everything a fake connection still points at, for the cases that check a closed link holds nothing. */
export const handlersOf = pc => [
  pc.onicecandidate, pc.onicegatheringstatechange, pc.onconnectionstatechange, pc.ondatachannel,
  pc.channel?.onopen, pc.channel?.onmessage, pc.channel?.onclose, pc.channel?.onerror, pc.channel?.onbufferedamountlow,
].filter(handler => handler != null)

/**
 * A session as the swarm reads the engine's: a case writes a torrent as a plain view, and the session answers
 * for it through the engine's own members. `dials` decides whether a stream handed over is read at once, the
 * way libtorrent's dial reads it; `speaks` makes it write its handshake in the same call; `refuses` makes
 * addPeerStream throw.
 */
export class FakeSession {
  views = new Map()
  /** Called after add, remove, pause and resume: a rig points it at its swarm's refresh(). `set` is silent. */
  changed = null
  /** Every stream handed over: { handle, socket, bytes: Buffer[], closed }. */
  streams = []
  ordinary = new Map()
  /** When the ordinary peers were asked for, by `Date.now()`. */
  lookedAt = []
  dials = true
  speaks = false
  refuses = false
  /** addPeerStream takes the stream and destroys it before it returns, as the engine does for a torrent it has not. */
  destroys = false

  /** `status` in a view is laid over the status the session answers with, and null makes it answer none. */
  add(handle, view = {}) {
    this.views.set(handle, {
      infoHash: hashOf(handle), trackers: [], running: true, hasMetadata: true, private: false,
      uploaded: 0, downloaded: 0, left: 1000, watched: false, ...view,
    })
    this.changed?.()
  }

  set(handle, patch) {
    Object.assign(this.views.get(handle), patch)
  }

  remove(handle) {
    this.views.delete(handle)
    this.changed?.()
  }

  pause(handle) {
    this.set(handle, { running: false })
    this.changed?.()
  }

  resume(handle) {
    this.set(handle, { running: true })
    this.changed?.()
  }

  torrents() {
    return [...this.views.keys()]
  }

  infohash(handle) {
    return this.views.get(handle)?.infoHash ?? null
  }

  status(handle) {
    const view = this.views.get(handle)
    if (!view || view.status === null) return null
    return {
      state: view.hasMetadata ? 3 : 2, paused: !view.running, errorCode: 0, hasMetadata: view.hasMetadata,
      totalWanted: view.left, totalWantedDone: 0, sessionPayloadUpload: view.uploaded, sessionPayloadDownload: view.downloaded,
      ...view.status,
    }
  }

  isPrivate(handle) {
    return this.views.get(handle)?.private
  }

  webSocketTrackers(handle) {
    return this.views.get(handle)?.trackers ?? []
  }

  hasStreamWindow(handle) {
    return this.views.get(handle)?.watched ?? false
  }

  async peers(handle) {
    this.lookedAt.push(Date.now())
    return this.ordinary.get(handle) ?? []
  }

  addPeerStream(handle, socket) {
    if (this.refuses) throw new Error('the torrent cannot take a peer')
    const stream = { handle, socket, bytes: [], closed: false }
    this.streams.push(stream)
    if (this.destroys) {
      stream.closed = true
      socket.destroy(new Error('addPeerStream: the engine has no such torrent'))
    } else if (this.dials) {
      socket.on('data', bytes => stream.bytes.push(Buffer.from(bytes)))
      socket.on('close', () => { stream.closed = true })
      if (this.speaks) socket.write(Buffer.alloc(68, 19))
    }
    return { address: '100.64.0.1', port: 6881 }
  }

  streamsOf(handle) {
    return this.streams.filter(stream => stream.handle === handle && !stream.closed)
  }
}

/** One end of a link, with what it reported. */
const end = link => {
  const side = { link, closes: 0, socket: null }
  link.onopen = socket => { side.socket = socket }
  link.onclose = () => side.closes++
  return side
}

/** Two open links, `a` the offering end. Fails by itself when a step never comes. */
export const pair = async (offering, answering = offering) => {
  const offer = await within('the offer', offering.offer())
  const a = end(offer.link)
  const answer = await within('the answer', answering.answer(offer.sdp))
  const b = end(answer.link)
  await within('the accept', a.link.accept(answer.sdp))
  await reached('both ends open', () => a.socket && b.socket)
  return { a, b, offer, answer }
}

export const reading = socket => {
  const chunks = []
  socket.on('data', bytes => chunks.push(Buffer.from(bytes)))
  return { get bytes() { return Buffer.concat(chunks) }, get length() { return chunks.reduce((n, c) => n + c.length, 0) } }
}

/**
 * Writes as libtorrent's shim does: after a write that returned false it waits for drain. The loop is counted
 * by the bytes it was given, and a drain that never comes fails it after 5 s.
 */
export const writeAll = async (socket, bytes, chunk = 256 * 1024) => {
  const seen = { waits: 0 }
  let drained = false
  socket.on('drain', () => { drained = true })
  for (let at = 0; at < bytes.length; at += chunk) {
    drained = false
    if (socket.write(bytes.subarray(at, at + chunk))) continue
    seen.waits++
    await reached('a drain after a write that said to wait', () => drained)
  }
  return seen
}

/** Waits in real time, for the cases that run on real sockets. */
export const eventually = async (what, predicate, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The reference tracker, bittorrent-tracker's server, on a loopback port. Null when the package is not installed. */
export const referenceTracker = async t => {
  const { Server } = await import('bittorrent-tracker').catch(() => ({}))
  if (!Server) return null
  const server = new Server({ http: false, udp: false, ws: true, stats: false })
  server.on('warning', () => {})
  server.on('error', () => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const clients = new Set()
  server.ws.on('connection', client => clients.add(client))
  // close() waits for every client to leave, and the swarms under test leave in hooks that run after this one.
  t.after(() => new Promise(resolve => {
    for (const client of clients) client.terminate()
    server.close(resolve)
  }))
  return { server, url: `ws://127.0.0.1:${server.ws.address().port}` }
}

/** libdatachannel's RTCPeerConnection and its companions, or null when the native module does not load here. */
export const nativeRtc = await import('node-datachannel/polyfill').catch(() => null)

// node-datachannel 0.32.3 keeps the event loop until each channel's closed callback has run, and that
// callback is lost when a connection is closed and its channel right behind it from this thread, which is what
// the polyfill makes of a channel closed first (it closes the channel a task later). 260 of 640 channels
// closed that way never heard it, the 3 processes holding such a channel never ended, and the 8 that then
// called cleanup() ended, in 1 to 9 ms (2026-11-13).
/**
 * For a file whose cases made connections with `nativeRtc`, once they are done: frees what the native module
 * still holds, so that the file's process can end.
 */
export const releaseNativeRtc = async () => {
  if (nativeRtc) (await import('node-datachannel')).cleanup()
}
