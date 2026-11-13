import { makeCertificate } from './certificate'
import { Host, ipv4, MAX_MESSAGE_SIZE, RTCPeerConnection as PeerConnection, type Stack } from './connection'
import { wasi } from './wasi'

/**
 * The part of a `node:dgram` socket this module drives. Node's own and @fkn/lib's both fit.
 * A `message` may arrive while `send` is still running, as from a socket joined to it in
 * memory, and any number of them in one task, as from @fkn/lib's. The socket is handed at most
 * 128 datagrams in one task and 256 within one millisecond, over all connections; only the
 * factory's `close()` hands it more, the last words of every connection.
 */
export interface DatagramSocket {
  send(data: Uint8Array, port: number, address: string, callback?: (error: Error | null) => void): void
  on(event: 'message', listener: (data: Uint8Array, remote: { address: string; port: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  off(event: 'message' | 'error' | 'close', listener: (...args: never[]) => void): unknown
}

export interface WebRTCOptions {
  /**
   * An already bound UDP socket. Every connection made from the factory sends and receives
   * through it, and nothing else may read from it. The caller keeps it and closes it; its
   * `error` or `close` ends every connection.
   */
  socket: DatagramSocket
  /**
   * The public IPv4 address and port at which a peer reaches `socket`. They become the one host
   * candidate of every description, so no STUN server is asked.
   */
  address: string
  port: number
  /**
   * The module's wasm: its bytes, a compiled module, or where to fetch it. Defaults to
   * `webrtc.wasm` beside this file, fetched. Node's `fetch` reads no file, so node passes the bytes.
   */
  wasm?: BufferSource | WebAssembly.Module | URL | string
  /**
   * Keep the remote candidates that are dropped by default: every one whose address is not a
   * public IPv4 address, so private, loopback, link-local, shared (100.64.0.0/10), documentation,
   * benchmark, multicast and reserved addresses, `.local` names and IPv6. A relay refuses a
   * datagram to any of those and writes a log line for each, and ICE would send them several a
   * second. Set it only where the socket really reaches such addresses.
   */
  allowPrivateCandidates?: boolean
  /**
   * Bytes a connection may have written and not yet acknowledged by its peer, over all its
   * channels. It caps the data in flight, so a connection uploads at most this much per round
   * trip: 5 MiB/s at 50 ms with the default.
   *
   * Defaults to 262144, which is also the least it can be (the largest message). More is faster
   * toward libtorrent 2.1 and libdatachannel: over a 50 ms round trip 8 MiB/s at 512 KiB and 12
   * to 19 from 1 MiB, the most for a writer that lets `bufferedAmount` fall no lower than this
   * size before it writes again. Toward Chrome more is not faster: 512 KiB fell to 1.6 MiB/s on
   * a busy machine, and every size above it was erratic on a quiet one. The README has the
   * tables.
   */
  sendBufferSize?: number
}

export interface WebRTC {
  /**
   * The platform's constructor, for the subset the README lists. `iceServers` is accepted and
   * ignored. The platform's own `RTCPeerConnection` fits this type too, so code that takes
   * either constructor names this one.
   */
  RTCPeerConnection: new (configuration?: RTCConfiguration) => RTCPeerConnection
  /** Datagrams that belonged to no connection and were dropped. */
  readonly droppedDatagrams: number
  /** Closes every connection and stops listening to the socket, which stays open. */
  close(): void
}

/**
 * An `on` handler. A method's type, which lets a handler written for a wider event fit: that
 * is what makes the platform's own objects fit the two interfaces below.
 */
type Handler<E extends Event = Event> = { handler(event: E): void }['handler'] | null

/**
 * The part of the platform's RTCDataChannel this module stands in for: an ordered, reliable
 * channel. Every event arrives through `addEventListener` and through its `on` handler.
 */
export interface RTCDataChannel extends EventTarget {
  readonly label: string
  /** `closing` from `close()` until everything sent before it has been delivered. */
  readonly readyState: RTCDataChannelState
  /** Binary messages arrive as ArrayBuffer. Setting anything else throws NotSupportedError. */
  binaryType: BinaryType
  /**
   * Bytes sent and not yet acknowledged by the peer: what waits here, plus what the stack holds
   * until the acknowledgement comes. The platform stops counting when the bytes leave.
   */
  readonly bufferedAmount: number
  /** `bufferedamountlow` fires when `bufferedAmount` falls from above this to it or below. 0 at first. */
  bufferedAmountLowThreshold: number
  onopen: Handler
  /** `data` is a string for a text message and an ArrayBuffer for a binary one. */
  onmessage: Handler<MessageEvent<string | ArrayBuffer>>
  /** Never fires inside `send`. */
  onbufferedamountlow: Handler
  /** Fires before `close` when the connection ended for a reason: `error` says which. */
  onerror: Handler<Event & { error: DOMException }>
  onclose: Handler
  /**
   * Queues a message, whose bytes are taken now. Throws InvalidStateError unless the channel is
   * open, TypeError when the message is larger than `sctp.maxMessageSize` of its connection,
   * OperationError when it would take `bufferedAmount` past 16 MiB (the channel goes on), and
   * NotSupportedError when it is empty.
   */
  send(data: string | ArrayBuffer | ArrayBufferView): void
  /** Closes once everything sent before has been delivered. The connection stays up. */
  close(): void
}

/**
 * The part of the platform's RTCPeerConnection this module stands in for: data channels, complete
 * descriptions, no media, no trickle. Every event arrives through `addEventListener` and through
 * its `on` handler.
 */
export interface RTCPeerConnection extends EventTarget {
  /**
   * `connecting` once both descriptions are set, `connected` when ICE and DTLS are up, `closed`
   * after `close()`. `failed` is final here and comes at once when the peer closes, when the
   * socket goes, and about 22 s after the peer goes quiet; there is no `disconnected`. A
   * connection no peer ever reaches stays `connecting`: close it on a timeout of your own.
   */
  readonly connectionState: RTCPeerConnectionState
  readonly iceGatheringState: RTCIceGatheringState
  /** Its SDP carries the one host candidate from the start, before gathering is reported complete. */
  readonly localDescription: { readonly type: RTCSdpType; readonly sdp: string } | null
  readonly remoteDescription: { readonly type: RTCSdpType; readonly sdp: string } | null
  /**
   * Null until a description is set. `maxMessageSize` is the remote description's
   * `a=max-message-size` (65536 when it has none), capped at 262144, the most this module sends.
   * `getSelectedCandidatePair()` answers the address and port the peer is reached at, which is
   * `remote` of the platform's pair and nothing else of it. It is null until ICE has chosen one,
   * and again once the connection is `closed` or `failed`.
   */
  readonly sctp: {
    readonly maxMessageSize: number
    readonly transport: {
      readonly iceTransport: {
        getSelectedCandidatePair(): { readonly remote: { readonly address: string | null; readonly port: number | null } } | null
      }
    }
  } | null
  /** Does not fire for `close()`, as the platform. */
  onconnectionstatechange: Handler
  /** `channel` is the one the peer opened, already open. */
  ondatachannel: Handler<Event & { channel: RTCDataChannel }>
  /** Fires twice after the local description is set: with the host candidate, then with null. */
  onicecandidate: Handler<Event & { candidate: RTCIceCandidateInit | null }>
  onicegatheringstatechange: Handler
  /**
   * Ordered and reliable only: `ordered: false`, `maxRetransmits`, `maxPacketLifeTime`,
   * `negotiated`, `id` and `protocol` throw NotSupportedError. Any number of channels, before the
   * offer or once the connection is up, with no new description.
   */
  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel
  /** Rejects with InvalidStateError when no data channel has been created: there is no media to offer. */
  createOffer(): Promise<RTCSessionDescriptionInit>
  createAnswer(): Promise<RTCSessionDescriptionInit>
  /**
   * With no argument, sets the offer or the answer this connection makes. A description is
   * accepted only if it is that one: any other SDP rejects with InvalidModificationError.
   */
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>
  /**
   * Rejects with OperationError when the text is not SDP, which leaves the connection as it was;
   * with InvalidAccessError when the stack refuses the description, which ends the connection as
   * `failed`; and with InvalidStateError when a description of that type cannot be set now.
   */
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>
  /** Tells the peer and closes every channel. */
  close(): void
}

async function compile(source: NonNullable<WebRTCOptions['wasm']>) {
  if (source instanceof WebAssembly.Module) return source
  if (typeof source !== 'string' && !(source instanceof URL)) return WebAssembly.compile(source)
  const response = await fetch(source)
  if (!response.ok) throw new Error(`could not fetch the WebRTC module: ${response.status}`)
  return WebAssembly.compile(await response.arrayBuffer())
}

/**
 * A WebRTC stack of the module's own, for data channels, whose every packet goes out through
 * `socket` instead of through the browser. Peers see the address of that socket and never the
 * device's.
 *
 * Runs on one thread and needs no cross-origin isolation, so a page, a worker or node can hold it.
 */
export async function createWebRTC(options: WebRTCOptions): Promise<WebRTC> {
  const { socket, address, port, allowPrivateCandidates = false, sendBufferSize = MAX_MESSAGE_SIZE } = options
  const ip = ipv4(address)
  if (ip === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('address and port are the IPv4 address and UDP port peers reach the socket at')
  }
  if (!Number.isInteger(sendBufferSize) || sendBufferSize < MAX_MESSAGE_SIZE) {
    throw new RangeError(`sendBufferSize is at least ${MAX_MESSAGE_SIZE}, the largest message`)
  }
  const [module, { certificate, privateKey }] = await Promise.all([
    compile(options.wasm ?? new URL(/* @vite-ignore */ './webrtc.wasm', import.meta.url)),
    makeCertificate(),
  ])
  const panic = { text: '' }
  const stderr = (text: string) => {
    panic.text = (panic.text + text).slice(-2048)
  }
  const imports = { wasi_snapshot_preview1: wasi(() => x.memory.buffer, stderr) }
  const x = (await WebAssembly.instantiate(module, imports)).exports as unknown as Stack
  x._initialize()
  const host = new Host(x, socket, ip, port, allowPrivateCandidates, sendBufferSize, certificate, privateKey, panic)
  const probe = host.create()
  if (!probe) {
    host.close()
    throw new TypeError(`${address}:${port} cannot be a host candidate`)
  }
  x.rtc_delete(probe)
  return {
    RTCPeerConnection: PeerConnection.bind(null, host),
    get droppedDatagrams() {
      return host.dropped
    },
    close: () => host.close(),
  }
}
