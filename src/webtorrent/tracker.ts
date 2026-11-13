/** The tracker's announce interval is kept inside these, in seconds. */
export const ANNOUNCE_MIN_S = 60
export const ANNOUNCE_MAX_S = 600

/** A lost socket is opened again after the first, doubling up to the second, plus up to a quarter of jitter. */
export const RECONNECT_MIN_MS = 10_000
export const RECONNECT_MAX_MS = 600_000

const MAX_FRAME = 128 * 1024
const MAX_SDP = 64 * 1024
const MAX_OFFER_ID = 64
const MAX_REASON = 200

// The id trackers and peers see for a torrent. The BitTorrent handshake carries libtorrent's own, as it does
// for qBittorrent, whose tracker id and wire id differ too.
const PEER_ID_PREFIX = '-RP0001-'

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const random = (length: number): string => {
  let out = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) out += ALPHANUMERIC[byte % ALPHANUMERIC.length]
  return out
}

// Exactly 20 characters that are one byte each in latin1 and in UTF-8: libtorrent 2.1.1 and later close their
// whole tracker socket on a relayed offer id of any other length, and one such id reaches every peer of a torrent.
export const offerId = (): string => random(20)

/** A new id for one torrent in one session, so a tracker cannot join a person's torrents by it. */
export const peerId = (): string => PEER_ID_PREFIX + random(20 - PEER_ID_PREFIX.length)

/** An info hash as the tracker protocol carries it: one character per byte, from its first 40 hex characters. */
export const binaryHash = (hex: string): string => {
  let out = ''
  for (let i = 0; i < 40; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  return out
}

/** The members of the platform's WebSocket that a tracker socket uses. */
export type WebSocketLike = {
  readonly readyState: number
  onopen: ((event: any) => void) | null
  onmessage: ((event: any) => void) | null
  onclose: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  send(data: string): void
  close(): void
}

export type WebSocketClass = new (url: string) => WebSocketLike

export type AnnounceEvent = 'started' | 'completed' | 'stopped'

export type Announce = {
  infoHash: string
  peerId: string
  uploaded: number
  downloaded: number
  left: number
  event?: AnnounceEvent
  offers: { offerId: string, sdp: string }[]
}

export type Answer = { infoHash: string, peerId: string, toPeerId: string, offerId: string, sdp: string }

/** What the tracker said about a torrent. A field the tracker left out is null. */
export type Reply = { infoHash: string, intervalS: number | null, seeders: number | null, leechers: number | null }

/** An offer or an answer another peer sent through the tracker. */
export type Relayed = { infoHash: string, peerId: string, offerId: string, sdp: string }

const count = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

const whole = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0

/**
 * One socket to one WebSocket tracker, for every torrent of a session.
 *
 * It opens at once and again after a loss, until `close()`. Every hash and id is the protocol's binary string.
 * A message that does not parse, is not about a torrent announced on this socket, or carries a field of the
 * wrong shape is dropped and counted in `dropped`, and the socket stays open: one odd message must not stop
 * the other torrents. It refuses to send while the socket is not open, and says so by returning false.
 */
export class Tracker {
  dropped = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onreply: ((reply: Reply) => void) | null = null
  /** The tracker refused an announce. `infoHash` is null when it did not say which. */
  onfailure: ((infoHash: string | null, reason: string) => void) | null = null
  onoffer: ((offer: Relayed) => void) | null = null
  onanswer: ((answer: Relayed) => void) | null = null

  private socket: WebSocketLike | null = null
  // The torrents this connection of the socket has heard of: true while announced, false once we said
  // `stopped`, until the tracker's reply to that, which is expected and is not an odd message.
  private listed = new Map<string, boolean>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private losses = 0

  constructor(readonly url: string, private readonly WebSocket: WebSocketClass) {
    this.connect()
  }

  get connected(): boolean {
    return this.socket?.readyState === 1
  }

  announce({ infoHash, peerId, uploaded, downloaded, left, event, offers }: Announce): boolean {
    const sent = this.send({
      action: 'announce',
      info_hash: infoHash,
      peer_id: peerId,
      uploaded: whole(uploaded),
      downloaded: whole(downloaded),
      left: whole(left),
      numwant: offers.length,
      event,
      offers: offers.map(({ offerId, sdp }) => ({ offer_id: offerId, offer: { type: 'offer', sdp } })),
    })
    if (sent) this.listed.set(infoHash, event !== 'stopped')
    return sent
  }

  answer({ infoHash, peerId, toPeerId, offerId, sdp }: Answer): boolean {
    return this.send({
      action: 'announce',
      info_hash: infoHash,
      peer_id: peerId,
      to_peer_id: toPeerId,
      offer_id: offerId,
      answer: { type: 'answer', sdp },
    })
  }

  close() {
    clearTimeout(this.retry)
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null
      socket.close()
    }
  }

  private send(message: unknown): boolean {
    if (!this.connected) return false
    this.socket!.send(JSON.stringify(message))
    return true
  }

  private connect() {
    let socket: WebSocketLike
    try {
      socket = new this.WebSocket(this.url)
    } catch {
      // The platform refuses the URL itself (a plain ws: tracker from an https page): asking again cannot help.
      return
    }
    this.socket = socket
    socket.onopen = () => this.onopen?.()
    socket.onmessage = ({ data }) => this.read(data)
    socket.onclose = () => {
      this.socket = null
      this.listed.clear()
      const wait = Math.min(RECONNECT_MIN_MS * 2 ** this.losses++, RECONNECT_MAX_MS)
      this.retry = setTimeout(() => this.connect(), wait * (1 + Math.random() / 4))
      this.onclose?.()
    }
  }

  private read(data: unknown) {
    if (!this.accept(data)) this.dropped++
  }

  private accept(data: unknown): boolean {
    if (typeof data !== 'string' || data.length > MAX_FRAME) return false
    let message: any
    try {
      message = JSON.parse(data)
    } catch {
      return false
    }
    if (message === null || typeof message !== 'object') return false

    const hash = message.info_hash
    const failure = message['failure reason']
    if (failure !== undefined) {
      if (typeof failure !== 'string' || (hash !== undefined && !this.listed.get(hash))) return false
      this.onfailure?.(hash ?? null, failure.slice(0, MAX_REASON))
      return true
    }
    if (message.action !== 'announce') return false
    const listed = this.listed.get(hash)
    if (!listed) return listed === false && this.listed.delete(hash)
    // A tracker that talks sense is a tracker worth going back to quickly.
    this.losses = 0

    const { offer, answer } = message
    if (offer === undefined && answer === undefined) {
      const { interval, complete, incomplete } = message
      if (!count(interval) || !count(complete) || !count(incomplete)) return false
      this.onreply?.({
        infoHash: hash,
        intervalS: interval === undefined ? null : Math.min(ANNOUNCE_MAX_S, Math.max(ANNOUNCE_MIN_S, interval)),
        seeders: complete ?? null,
        leechers: incomplete ?? null,
      })
      return true
    }

    const description = offer ?? answer
    const { peer_id: peer, offer_id: id } = message
    if (offer !== undefined && answer !== undefined) return false
    if (description === null || typeof description !== 'object') return false
    if (typeof description.sdp !== 'string' || description.sdp.length > MAX_SDP) return false
    if (typeof peer !== 'string' || peer.length !== 20) return false
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_OFFER_ID) return false
    const relayed = { infoHash: hash, peerId: peer, offerId: id, sdp: description.sdp }
    if (offer) this.onoffer?.(relayed)
    else this.onanswer?.(relayed)
    return true
  }
}
