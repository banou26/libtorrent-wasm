import { SEND_HIGH, SEND_LOW, SLICE, Stream } from './stream'

/** The STUN host the owner chose, the one qBittorrent, libtorrent and WebTorrent use. Nothing asks it unless a caller passes it. */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

// "complete" took 39.9 s in Chrome 156 and WebKit 26.5 with a STUN name that has an IPv6 address and no IPv6
// route, while the reflexive candidate was there after 7 to 119 ms (2026-11-13).
/** The local description is read at gathering complete, this long after the first reflexive candidate, or at the cap. */
export const REFLEXIVE_GRACE_MS = 300
export const GATHER_CAP_MS = 3000

// Chromium 156 schedules a connection's state events one task ahead, and a connection closed while one is
// scheduled keeps one of the page's 500 slots until its frame is gone: 36 to 40 of 40 closed one task after
// setLocalDescription resolved, 30 of 40 closed in the task the other end finished in, none closed 5 ms
// later (2026-11-13).
/** A connection is closed no sooner than this after its last signalling step. */
export const CLOSE_AFTER_STEP_MS = 5

/** One connection attempt. `onopen` and `onclose` fire at most once each; `onclose` does not follow a `close()`. */
export type Link = {
  /** Applies the remote's answer to our offer. A refused answer closes the link and rejects. A closed link rejects. */
  accept(remoteSdp: string): Promise<void>
  onopen: ((socket: Stream) => void) | null
  onclose: (() => void) | null
  close(): void
}

export type Made = { sdp: string, link: Link }

/** A factory of connection attempts: the one seam between the signalling and a WebRTC implementation. */
export type Links = {
  offer(): Promise<Made>
  answer(remoteSdp: string): Promise<Made>
  /** The remote address of an open link where the implementation can tell, for the caller to compare and drop. */
  remoteAddress(link: Link): string | undefined
}

/**
 * `offer` and `answer` reject with this when the class would not make a connection: there is no slot now
 * (Chromium allows 500 a page), which says nothing about a later try.
 */
export class LinksFull extends Error {}

/** What a connection reports while it collects its own addresses. */
export type Gathering = { reflexive: Promise<void>, complete: Promise<void> }

/** Decides when a local description is read: resolves at that moment. */
export type Gathered = (gathering: Gathering) => Promise<void>

/**
 * The `Gathered` used unless a caller passes one: gathering complete, `REFLEXIVE_GRACE_MS` after the first
 * reflexive candidate, or `GATHER_CAP_MS`, whichever is first. Its timers run in the thread that calls it.
 */
export const gatherCap: Gathered = ({ reflexive, complete }) => new Promise(resolve => {
  let grace: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const done = () => {
    settled = true
    clearTimeout(cap)
    clearTimeout(grace)
    resolve()
  }
  const cap = setTimeout(done, GATHER_CAP_MS)
  void complete.then(done)
  void reflexive.then(() => { if (!settled) grace ??= setTimeout(done, REFLEXIVE_GRACE_MS) })
})

/** The members of the platform's RTCDataChannel that `rtcLinks` uses. */
export type DataChannelLike = {
  binaryType: string
  readonly readyState: string
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  onopen: ((event: any) => void) | null
  onmessage: ((event: any) => void) | null
  onclose: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onbufferedamountlow: ((event: any) => void) | null
  send(data: any): void
  close(): void
}

/** The members of the platform's RTCPeerConnection that `rtcLinks` uses. `sctp` may be absent. */
export type PeerConnectionLike = {
  readonly localDescription: { sdp: string } | null
  readonly iceGatheringState: string
  readonly connectionState: string
  readonly sctp?: any
  onicecandidate: ((event: any) => void) | null
  onicegatheringstatechange: ((event: any) => void) | null
  onconnectionstatechange: ((event: any) => void) | null
  ondatachannel: ((event: any) => void) | null
  createDataChannel(label: string): DataChannelLike
  createOffer(): Promise<any>
  createAnswer(): Promise<any>
  setLocalDescription(description: any): Promise<void>
  setRemoteDescription(description: any): Promise<void>
  close(): void
}

export type RtcLinksOptions = {
  /** The browser's own class, or any class with its shape. */
  RTCPeerConnection: new (configuration: { iceServers: any[] }) => PeerConnectionLike
  iceServers?: any[]
}

type Step = <T>(taken: Promise<T>) => Promise<T>

/** `Links`, where a caller may also say when each description is read. */
export type RtcLinks = {
  offer(gathered?: Gathered): Promise<Made>
  answer(remoteSdp: string, gathered?: Gathered): Promise<Made>
  remoteAddress(link: Link): string | undefined
}

/**
 * Connection attempts over anything shaped like the platform's RTCPeerConnection, one data channel each.
 *
 * It promises a description within `GATHER_CAP_MS` (or whenever `gathered` says), a stream that keeps what the
 * remote sent before anything read it, sends cut to the connection's message limit and paced by the channel's
 * `bufferedAmount`, and that a closed link leaves none of its handlers on the connection. However a link ends,
 * its channel is closed at once and its connection `CLOSE_AFTER_STEP_MS` after its last signalling step or
 * later, on a timer of the thread it runs in when that moment is still ahead. The link itself still reaches
 * its connection, so the connection is freed once the caller lets the link go. It contacts nothing by itself:
 * the ICE servers are the caller's.
 */
export const rtcLinks = ({ RTCPeerConnection, iceServers = [] }: RtcLinksOptions): RtcLinks => {
  const connections = new WeakMap<Link, PeerConnectionLike>()

  const negotiate = async (
    gathered: Gathered,
    describe: (pc: PeerConnectionLike, attach: (channel: DataChannelLike) => void, step: Step) => Promise<void>,
  ): Promise<Made> => {
    let pc: PeerConnectionLike
    try {
      pc = new RTCPeerConnection({ iceServers })
    } catch (cause) {
      throw new LinksFull('no connection could be made', { cause })
    }

    let channel: DataChannelLike | null = null
    let stream: Stream | null = null
    let closed = false
    let queue: Uint8Array[] = []
    let sent = 0
    let waiting = false
    let slice = SLICE
    let stepping = 0
    let steppedAt = 0

    const shut = () => {
      if (stepping) return
      const close = () => { try { pc.close() } catch { /* already closed */ } }
      if (Date.now() - steppedAt > CLOSE_AFTER_STEP_MS) close()
      else setTimeout(close, CLOSE_AFTER_STEP_MS)
    }

    /** One signalling step. A link that ends meanwhile closes its connection once the step has settled. */
    const step: Step = async taken => {
      stepping++
      try {
        return await taken
      } finally {
        stepping--
        steppedAt = Date.now()
        if (closed) shut()
      }
    }

    const release = () => {
      closed = true
      queue = []
      pc.onicecandidate = pc.onicegatheringstatechange = pc.onconnectionstatechange = pc.ondatachannel = null
      if (channel) {
        channel.onopen = channel.onmessage = channel.onclose = channel.onerror = channel.onbufferedamountlow = null
        try { channel.close() } catch { /* already closed */ }
      }
      shut()
    }

    const end = (error?: Error) => {
      if (closed) return
      release()
      stream?.end(error)
      link.onclose?.()
    }

    const pump = () => {
      try {
        while (queue.length && channel!.bufferedAmount < SEND_HIGH) {
          const bytes = queue[0]!
          const piece = bytes.subarray(sent, sent + slice)
          channel!.send(piece)
          sent += piece.length
          if (sent >= bytes.length) {
            queue.shift()
            sent = 0
          }
        }
      } catch (cause) {
        end(new Error('the data channel refused a message', { cause }))
      }
    }

    const opened = () => {
      if (stream || closed) return
      // The limit is the remote description's, so it is only there to read once that is set.
      const limit = pc.sctp?.maxMessageSize
      if (limit > 0 && limit < SLICE) slice = limit
      stream = new Stream({
        write: bytes => {
          queue.push(bytes)
          pump()
          if (!queue.length) return true
          waiting = true
          return false
        },
        close: () => end(),
      })
      link.onopen?.(stream)
    }

    // Called in the task the channel appears in: a handler attached one task later loses what the remote sent
    // first, its handshake, and the open event with it (0 of 10 messages in Chrome, Firefox and WebKit).
    const attach = (made: DataChannelLike) => {
      channel = made
      made.binaryType = 'arraybuffer'
      made.bufferedAmountLowThreshold = SEND_LOW
      made.onopen = opened
      made.onmessage = ({ data }) => {
        opened()
        if (data instanceof ArrayBuffer) stream?.push(new Uint8Array(data))
        else if (ArrayBuffer.isView(data)) stream?.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        else end(new Error('a message that is not bytes'))
      }
      made.onclose = () => end()
      made.onerror = () => end(new Error('the data channel failed'))
      made.onbufferedamountlow = () => {
        pump()
        if (waiting && !queue.length) {
          waiting = false
          stream?.drained()
        }
      }
      if (made.readyState === 'open') opened()
    }

    const link: Link = {
      onopen: null,
      onclose: null,
      accept: async remoteSdp => {
        if (closed) throw new Error('the link is closed')
        try {
          await step(pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp }))
        } catch (error) {
          end()
          throw error
        }
      },
      close: () => {
        if (closed) return
        release()
        stream?.end()
      },
    }
    connections.set(link, pc)

    let reflexive!: () => void
    let complete!: () => void
    const gathering: Gathering = {
      reflexive: new Promise(resolve => { reflexive = resolve }),
      complete: new Promise(resolve => { complete = resolve }),
    }
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate) complete()
      else if (/ typ srflx\b/.test(candidate.candidate)) reflexive()
    }
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') complete() }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') end() }

    try {
      await describe(pc, attach, step)
      if (pc.iceGatheringState === 'complete') complete()
      await gathered(gathering)
      const sdp = pc.localDescription?.sdp
      if (closed || !sdp) throw new Error('the connection closed before it had a description')
      return { sdp, link }
    } catch (error) {
      link.close()
      throw error
    }
  }

  return {
    offer: (gathered = gatherCap) => negotiate(gathered, async (pc, attach, step) => {
      attach(pc.createDataChannel('webtorrent'))
      await step(pc.setLocalDescription(await step(pc.createOffer())))
    }),
    answer: (remoteSdp, gathered = gatherCap) => negotiate(gathered, async (pc, attach, step) => {
      pc.ondatachannel = ({ channel }) => attach(channel)
      await step(pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp }))
      await step(pc.setLocalDescription(await step(pc.createAnswer())))
    }),
    remoteAddress: link =>
      connections.get(link)?.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.()?.remote?.address || undefined,
  }
}
