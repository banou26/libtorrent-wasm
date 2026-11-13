import { LinksFull, type Link, type Links } from './links'
import type { PeerStream, Stream } from './stream'
import { binaryHash, offerId, peerId, Tracker, type Relayed, type WebSocketClass } from './tracker'
import { trackerUrl } from './trackers'

/** What the swarm reads about one torrent, each time it decides something. */
export type SwarmTorrent = {
  /** The v1 info hash as 40 hex characters, or the first 40 of a v2-only torrent's. */
  infoHash: string
  /** The `ws` and `wss` trackers the torrent names: `trackersOf` what it was added from. */
  trackers: readonly string[]
  /** Not paused by the person or by the queue, not checking, no error. */
  running: boolean
  hasMetadata: boolean
  /** Undefined until the metadata says. */
  private: boolean | undefined
  uploaded: number
  downloaded: number
  /** Bytes still wanted. Read only once the metadata is known. */
  left: number
  /** Somebody is watching it: it is served before the others. */
  watched: boolean
}

/** The part of a session the swarm needs. `peers` is only read with `relay`. */
export type SwarmSession = {
  /** Hands libtorrent an open stream as a peer it dials. A torrent that cannot take it throws, or destroys the stream. */
  addPeerStream(handle: number, socket: PeerStream): { address: string, port: number }
  torrents(): Iterable<number>
  /** Null once the session no longer has the torrent. */
  torrent(handle: number): SwarmTorrent | null
  on(event: 'add' | 'remove' | 'pause' | 'resume', listener: (handle: number) => void): void
  off(event: 'add' | 'remove' | 'pause' | 'resume', listener: (handle: number) => void): void
  peers?(handle: number): Promise<ReadonlyArray<{ endpoint: string }>>
}

export type Limits = {
  /** Remotes one torrent may be connected or connecting to. */
  torrentPeers: number
  sessionPeers: number
  /** Connections open or pending in the session, offers nobody answered yet included. */
  connections: number
  /** Connections made in a minute. */
  perMinute: number
}

export const LIMITS: Limits = { torrentPeers: 20, sessionPeers: 60, connections: 80, perMinute: 40 }

// Of each session-wide budget, what a torrent of that rank leaves to the ranks above it. Ten is one round of offers.
const RESERVE = { watched: 0, downloading: 10, seeding: 20 }

// libtorrent's own count, and what the live trackers use of an announce at most (webtorrent.dev 10, openwebtorrent 20).
const OFFERS_PER_ANNOUNCE = 10
// What libtorrent announces before it knows the size. Zero would list a magnet as a seed.
const LEFT_BEFORE_METADATA = 16 * 1024

const MAKING_MS = 10_000
/** The reference client's wait for an answer. */
const UNANSWERED_MS = 50_000
const OPENING_MS = 30_000
const UNDIALLED_MS = 10_000
const QUIET_AFTER_CLOSE_MS = 60_000
const QUIET_AFTER_FULL_MS = 60_000
/** Between announces until the tracker names its interval. */
const ANNOUNCE_MS = 120_000
const BEAT_MS = 1000

export type WebtorrentPeersOptions = {
  links: Links
  /** The platform's WebSocket, or one with its shape that goes through the relay. */
  WebSocket: WebSocketClass
  /** Announced for every torrent known not to be private, beside the torrent's own. None unless given. */
  trackers?: readonly string[]
  limits?: Partial<Limits>
  /** The session also has ordinary peers: a channel whose remote address one of them already holds is closed. */
  relay?: boolean
}

export type TrackerState = {
  url: string
  connected: boolean
  /** The tracker's last counts for the torrent, this session included. Null before its first answer. */
  seeders: number | null
  leechers: number | null
  answeredAt: number | null
  /** The tracker's own words when it refused the last announce. Text from the network. */
  failure: string | null
}

export type TorrentPeers = {
  handle: number
  trackers: TrackerState[]
  /** Connections not open yet, offers nobody answered included. */
  pending: number
  open: number
  lastPeerAt: number | null
}

export type Snapshot = {
  /** Running torrents only. */
  torrents: TorrentPeers[]
  /** Tracker messages that did not validate. */
  dropped: number
}

export type WebtorrentPeers = {
  /** Says `stopped` to every tracker and closes every connection and socket. */
  close(): void
  snapshot(): Snapshot
  /** Called after the snapshot changed, at most once a task. */
  onchange: (() => void) | null
}

type Announcing = {
  tracker: Tracker
  /** Whether the socket, as it is connected now, has heard of the torrent. */
  started: boolean
  /** The last announce has had no offer round yet: one follows the first reply that leaves somebody to offer to. */
  offersDue: boolean
  sentAt: number
  nextAt: number
  intervalMs: number
  seeders: number | null
  leechers: number | null
  answeredAt: number | null
  failure: string | null
}

type Conn = {
  torrent: Torrent
  /** We made the offer. */
  ours: boolean
  /** The remote's tracker id, once one is behind the attempt. */
  remote: string | null
  offerId: string
  state: 'making' | 'offered' | 'answered' | 'open'
  deadline: number
  link?: Link
  socket?: Stream
}

type Torrent = {
  handle: number
  hash: string
  peerId: string
  view: SwarmTorrent
  announcing: Map<string, Announcing>
  conns: Set<Conn>
  offers: Map<string, Conn>
  /** Remotes whose offers are not answered, and until when. */
  quiet: Map<string, number>
  leeching: boolean
  completed: boolean
  lastPeerAt: number | null
}

/** The last announce has had neither a reply nor a refusal yet. */
const unanswered = (announcing: Announcing): boolean => (announcing.answeredAt ?? 0) < announcing.sentAt

const seeding = (view: SwarmTorrent): boolean => view.hasMetadata && view.left <= 0

const rank = (view: SwarmTorrent): keyof typeof RESERVE =>
  view.watched ? 'watched' : seeding(view) ? 'seeding' : 'downloading'

/** Its own trackers that are not local names, and the defaults once it is known not to be private. */
const trackersFor = (view: SwarmTorrent, defaults: readonly string[]): string[] => {
  const own = view.trackers.map(trackerUrl).filter(url => url !== null)
  return [...new Set(view.private === false ? [...own, ...defaults] : own)]
}

/** Of our offer and theirs, both ends keep the one from the smaller id. */
const oursStands = (ourId: string, theirId: string): boolean => ourId < theirId

const addressOf = (endpoint: string): string => endpoint.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')

/**
 * Finds WebRTC peers for every running torrent of a session through WebSocket trackers, and hands each open
 * data channel to libtorrent as a peer.
 *
 * It contacts the trackers it is given and the ones a torrent names, and nothing else. It makes no connection
 * for a swarm the tracker reports empty, none from a seeding torrent, and none for a torrent that is not
 * running. It keeps announcing at the tracker's interval for as long as a torrent runs, so `snapshot()` can
 * say that nobody was found yet without that being final.
 */
export const webtorrentPeers = (session: SwarmSession, options: WebtorrentPeersOptions): WebtorrentPeers => {
  const { links, WebSocket, relay = false } = options
  const limits = { ...LIMITS, ...options.limits }
  const defaults = (options.trackers ?? []).map(url => new URL(url).href)
  const trackers = new Map<string, Tracker>()
  const torrents = new Map<number, Torrent>()
  const byHash = new Map<string, Torrent>()
  const ids = new Map<number, string>()
  let live = 0
  let tokens = limits.perMinute
  let refilledAt = Date.now()
  let quietUntil = 0
  let dropped = 0
  let notifying = false
  let closed = false

  const changed = () => {
    if (notifying || closed) return
    notifying = true
    queueMicrotask(() => {
      notifying = false
      peers.onchange?.()
    })
  }

  const known = (t: Torrent): number => {
    let count = 0
    for (const conn of t.conns) if (conn.remote) count++
    return count
  }

  const sessionKnown = (): number => {
    let count = 0
    for (const t of torrents.values()) count += known(t)
    return count
  }

  /** How many connections a torrent may make now. */
  const room = (t: Torrent): number => {
    const now = Date.now()
    if (now < quietUntil) return 0
    tokens = Math.min(limits.perMinute, tokens + (now - refilledAt) * limits.perMinute / 60_000)
    refilledAt = now
    const reserve = RESERVE[rank(t.view)]
    return Math.max(0, Math.floor(Math.min(
      limits.torrentPeers - known(t),
      limits.sessionPeers - sessionKnown() - reserve,
      limits.connections - live - reserve,
      tokens - reserve,
    )))
  }

  const add = (t: Torrent, ours: boolean, remote: string | null, id: string): Conn => {
    const conn: Conn = { torrent: t, ours, remote, offerId: id, state: 'making', deadline: Date.now() + MAKING_MS }
    t.conns.add(conn)
    live++
    tokens--
    changed()
    return conn
  }

  const remove = (conn: Conn): boolean => {
    const t = conn.torrent
    if (!t.conns.delete(conn)) return false
    live--
    t.offers.delete(conn.offerId)
    if (conn.remote) t.quiet.set(conn.remote, Date.now() + QUIET_AFTER_CLOSE_MS)
    changed()
    return true
  }

  const drop = (conn: Conn) => {
    if (remove(conn)) conn.link?.close()
  }

  const failed = (conn: Conn, error: unknown) => {
    if (error instanceof LinksFull) quietUntil = Date.now() + QUIET_AFTER_FULL_MS
    remove(conn)
  }

  /** False, with the link closed, when the attempt was given up while the link was being made. */
  const attach = (conn: Conn, link: Link): boolean => {
    if (!conn.torrent.conns.has(conn)) {
      link.close()
      return false
    }
    conn.link = link
    link.onopen = socket => void opened(conn, socket)
    link.onclose = () => remove(conn)
    return true
  }

  const opened = async (conn: Conn, socket: Stream) => {
    const t = conn.torrent
    if (relay && session.peers) {
      const address = links.remoteAddress(conn.link!)
      if (address) {
        // libtorrent keeps one connection per address, and a libtorrent 2.1 remote refuses the channel anyway.
        const ordinary = await session.peers(t.handle).catch(() => [])
        if (!t.conns.has(conn)) return
        if (ordinary.some(peer => addressOf(peer.endpoint) === address)) return drop(conn)
      }
    }
    if (!conn.remote || !session.torrent(t.handle)?.running) return drop(conn)
    try {
      session.addPeerStream(t.handle, socket)
    } catch {
      return drop(conn)
    }
    // The engine destroys a stream it cannot take, where another session would throw.
    if (!t.conns.has(conn)) return
    conn.state = 'open'
    conn.socket = socket
    conn.deadline = Date.now() + UNDIALLED_MS
    t.lastPeerAt = Date.now()
    changed()
  }

  const identity = (t: Torrent) => ({
    infoHash: t.hash,
    peerId: t.peerId,
    uploaded: t.view.uploaded,
    downloaded: t.view.downloaded,
    left: t.view.hasMetadata ? t.view.left : LEFT_BEFORE_METADATA,
  })

  const offer = async (t: Torrent): Promise<{ conn: Conn, sdp: string } | null> => {
    const conn = add(t, true, null, offerId())
    try {
      const made = await links.offer()
      return attach(conn, made.link) ? { conn, sdp: made.sdp } : null
    } catch (error) {
      failed(conn, error)
      return null
    }
  }

  /**
   * As many offers as the tracker's count leaves somebody to answer, none from a seeding torrent. A count that
   * leaves nobody keeps the round due: after a pause and a resume inside the tracker's round trip the first
   * reply is the one to `stopped`, which counts the swarm without us.
   */
  const offerRound = async (t: Torrent, announcing: Announcing) => {
    if (seeding(t.view)) return
    const others = (announcing.seeders ?? 0) + (announcing.leechers ?? 0) - 1
    const count = Math.min(OFFERS_PER_ANNOUNCE, room(t), others - t.conns.size)
    if (count < 1) return
    announcing.offersDue = false
    const made = await Promise.all(Array.from({ length: count }, () => offer(t)))
    const ready = made.filter(offered => offered !== null).filter(({ conn }) => t.conns.has(conn))
    if (!ready.length) return
    const sent = announcing.tracker.announce({
      ...identity(t),
      offers: ready.map(({ conn, sdp }) => ({ offerId: conn.offerId, sdp })),
    })
    for (const { conn } of ready) {
      if (!sent) {
        drop(conn)
        continue
      }
      conn.state = 'offered'
      conn.deadline = Date.now() + UNANSWERED_MS
      t.offers.set(conn.offerId, conn)
    }
  }

  const answer = async (tracker: Tracker, { infoHash, peerId: remote, offerId: id, sdp }: Relayed) => {
    const t = byHash.get(infoHash)
    if (!t || remote === t.peerId || t.quiet.has(remote)) return
    const same = [...t.conns].filter(conn => conn.remote === remote)
    if (same.length) {
      // An open channel wins and an earlier offer of theirs stands. Otherwise they answered an offer of ours.
      if (same.some(conn => conn.state === 'open' || !conn.ours) || oursStands(t.peerId, remote)) return
      same.forEach(drop)
    }
    if (room(t) < 1) return
    const conn = add(t, false, remote, id)
    try {
      const made = await links.answer(sdp)
      if (!attach(conn, made.link)) return
      if (!tracker.answer({ infoHash, peerId: t.peerId, toPeerId: remote, offerId: id, sdp: made.sdp })) return drop(conn)
      conn.state = 'answered'
      conn.deadline = Date.now() + OPENING_MS
    } catch (error) {
      failed(conn, error)
    }
  }

  const accept = ({ infoHash, peerId: remote, offerId: id, sdp }: Relayed) => {
    const t = byHash.get(infoHash)
    const conn = t?.offers.get(id)
    if (!t || !conn || conn.state !== 'offered' || remote === t.peerId) return
    const same = [...t.conns].filter(other => other.remote === remote)
    // An open channel wins and an earlier answer of theirs stands. Otherwise we answered an offer of theirs.
    if (same.some(other => other.state === 'open' || other.ours)) return drop(conn)
    if (same.length && !oursStands(t.peerId, remote)) return drop(conn)
    same.forEach(drop)
    if (known(t) >= limits.torrentPeers || sessionKnown() + RESERVE[rank(t.view)] >= limits.sessionPeers) return drop(conn)
    conn.remote = remote
    conn.state = 'answered'
    conn.deadline = Date.now() + OPENING_MS
    changed()
    // A refused answer closes the link, and its onclose removes the attempt.
    conn.link!.accept(sdp).catch(() => {})
  }

  const trackerAt = (url: string): Tracker => {
    const existing = trackers.get(url)
    if (existing) return existing
    const tracker = new Tracker(url, WebSocket)
    trackers.set(url, tracker)
    tracker.onopen = () => {
      for (const t of torrents.values()) {
        const announcing = t.announcing.get(url)
        if (!announcing) continue
        announcing.started = false
        announcing.nextAt = 0
      }
      announce()
      changed()
    }
    tracker.onclose = changed
    tracker.onreply = ({ infoHash, intervalS, seeders, leechers }) => {
      const t = byHash.get(infoHash)
      const announcing = t?.announcing.get(url)
      if (!t || !announcing) return
      if (intervalS !== null) {
        announcing.intervalMs = intervalS * 1000
        announcing.nextAt = announcing.sentAt + announcing.intervalMs
      }
      announcing.seeders = seeders
      announcing.leechers = leechers
      announcing.answeredAt = Date.now()
      announcing.failure = null
      changed()
      if (announcing.offersDue) void offerRound(t, announcing)
    }
    tracker.onfailure = (infoHash, reason) => {
      for (const t of torrents.values()) {
        const announcing = t.announcing.get(url)
        // A refusal that names no torrent is about whichever announce still waits for its reply.
        if (!announcing || (infoHash === null ? !unanswered(announcing) : infoHash !== t.hash)) continue
        announcing.failure = reason
        announcing.answeredAt = Date.now()
        changed()
      }
    }
    tracker.onoffer = offered => void answer(tracker, offered)
    tracker.onanswer = accept
    return tracker
  }

  /** Every announce that is due on an open socket. Never with offers: those follow the count in the reply. */
  const announce = () => {
    const now = Date.now()
    for (const t of torrents.values()) {
      for (const announcing of t.announcing.values()) {
        if (now < announcing.nextAt || !announcing.tracker.connected) continue
        announcing.tracker.announce({ ...identity(t), event: announcing.started ? undefined : 'started', offers: [] })
        announcing.started = true
        announcing.offersDue = true
        announcing.sentAt = now
        announcing.nextAt = now + announcing.intervalMs
      }
    }
  }

  const tell = (t: Torrent, announcing: Announcing, event: 'completed' | 'stopped') => {
    announcing.tracker.announce({ ...identity(t), event, offers: [] })
  }

  const stop = (t: Torrent) => {
    for (const announcing of t.announcing.values()) tell(t, announcing, 'stopped')
    for (const conn of t.conns) drop(conn)
    torrents.delete(t.handle)
    byHash.delete(t.hash)
    changed()
  }

  /** Brings what the swarm holds for one torrent in line with what the session says of it now. */
  const reconcile = (handle: number) => {
    const view = session.torrent(handle)
    let t = torrents.get(handle)
    if (!view) ids.delete(handle)
    if (!view?.running) {
      if (t) stop(t)
      return
    }
    if (!t) {
      // One id per torrent for the whole session, kept across a pause.
      const id = ids.get(handle) ?? peerId()
      ids.set(handle, id)
      t = {
        handle, view, hash: binaryHash(view.infoHash), peerId: id, announcing: new Map(), conns: new Set(),
        offers: new Map(), quiet: new Map(), leeching: false, completed: false, lastPeerAt: null,
      }
      torrents.set(handle, t)
      byHash.set(t.hash, t)
      changed()
    }
    t.view = view

    const wanted = trackersFor(view, defaults)
    for (const url of wanted) {
      if (t.announcing.has(url)) continue
      t.announcing.set(url, {
        tracker: trackerAt(url), started: false, offersDue: false, sentAt: 0, nextAt: 0, intervalMs: ANNOUNCE_MS,
        seeders: null, leechers: null, answeredAt: null, failure: null,
      })
      changed()
    }
    for (const [url, announcing] of t.announcing) {
      if (wanted.includes(url)) continue
      tell(t, announcing, 'stopped')
      t.announcing.delete(url)
      changed()
    }

    if (view.hasMetadata && view.left > 0) t.leeching = true
    if (t.leeching && !t.completed && seeding(view)) {
      t.completed = true
      for (const announcing of t.announcing.values()) tell(t, announcing, 'completed')
    }
  }

  const prune = () => {
    for (const [url, tracker] of trackers) {
      let used = false
      for (const t of torrents.values()) used ||= t.announcing.has(url)
      if (used) continue
      dropped += tracker.dropped
      tracker.close()
      trackers.delete(url)
    }
  }

  const beat = () => {
    const now = Date.now()
    for (const handle of new Set([...session.torrents(), ...torrents.keys()])) reconcile(handle)
    for (const t of torrents.values()) {
      for (const conn of t.conns) {
        if (now < conn.deadline) continue
        // A stream with a reader was dialled: from here it lives until either side closes it.
        if (conn.state === 'open' && conn.socket!.listenerCount('data')) conn.deadline = Infinity
        else drop(conn)
      }
      for (const [remote, until] of t.quiet) if (now >= until) t.quiet.delete(remote)
    }
    prune()
    announce()
  }

  const refresh = (handle: number) => {
    reconcile(handle)
    prune()
    announce()
  }

  const events = ['add', 'remove', 'pause', 'resume'] as const

  const peers: WebtorrentPeers = {
    onchange: null,
    close: () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      for (const event of events) session.off(event, refresh)
      for (const t of torrents.values()) stop(t)
      prune()
    },
    snapshot: () => ({
      dropped: [...trackers.values()].reduce((sum, tracker) => sum + tracker.dropped, dropped),
      torrents: [...torrents.values()].map(t => {
        let open = 0
        for (const conn of t.conns) if (conn.state === 'open') open++
        return {
          handle: t.handle,
          trackers: [...t.announcing].map(([url, { tracker, seeders, leechers, answeredAt, failure }]) =>
            ({ url, connected: tracker.connected, seeders, leechers, answeredAt, failure })),
          pending: t.conns.size - open,
          open,
          lastPeerAt: t.lastPeerAt,
        }
      }),
    }),
  }

  for (const event of events) session.on(event, refresh)
  const timer = setInterval(beat, BEAT_MS)
  beat()
  return peers
}
