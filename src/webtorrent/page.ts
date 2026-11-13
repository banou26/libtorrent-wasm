import { gatherCap, LinksFull, rtcLinks, type Gathered, type Link, type Links, type Made, type RtcLinksOptions } from './links'
import { SEND_HIGH, SEND_LOW, SLICE, Stream } from './stream'

export { DEFAULT_ICE_SERVERS } from './links'

// One MessagePort carries every link, each named by a number the worker picks.
//   worker to page: offer, answer, flush (read the description now), accept, data, ack, close
//   page to worker: candidate, sdp, failed, open, data, ack, closed
// `data` moves an ArrayBuffer, never a copy. `ack` returns the count of bytes the other side has passed on, which
// is what keeps both queues bounded: a sender stops at SEND_HIGH bytes not yet acknowledged.
type ToPage =
  | { t: 'offer', id: number }
  | { t: 'answer', id: number, sdp: string }
  | { t: 'flush', id: number }
  | { t: 'accept', id: number, sdp: string }
  | { t: 'data', id: number, bytes: ArrayBuffer }
  | { t: 'ack', id: number, bytes: number }
  | { t: 'close', id: number }

type ToWorker =
  | { t: 'candidate', id: number, last: boolean }
  | { t: 'sdp', id: number, sdp: string }
  | { t: 'failed', id: number, full: boolean, reason: string }
  | { t: 'open', id: number }
  | { t: 'data', id: number, bytes: ArrayBuffer }
  | { t: 'ack', id: number, bytes: number }
  | { t: 'closed', id: number }

// A data channel cannot be paused: past this many bytes the worker has not taken, the page gives the link up.
const MAX_UNTAKEN = 32 * 1024 * 1024

/** The members of the platform's MessagePort that both halves use. */
export type PortLike = {
  onmessage: ((event: any) => void) | null
  postMessage(message: any, transfer: any[]): void
}

// `new Uint8Array(view)` and never `view.slice()`: a node Buffer's slice is a view of the same memory, and
// moving that would take the caller's bytes with it.
const copy = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer

const whole = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : copy(bytes)

/**
 * The page half: makes the browser's peer connections for the engine worker and carries their bytes.
 *
 * It holds no limit and no knowledge of torrents, and its one timer is the `CLOSE_AFTER_STEP_MS` a connection
 * is kept before it is closed: a page that is hidden runs its timers late, so every decision is the worker's,
 * and a late timer only closes a connection later. It drops every reference to a connection once its link
 * ended and that timer ran. Returns the function that closes every link and stops listening.
 */
export const servePeerLinks = (port: PortLike, options: RtcLinksOptions): (() => void) => {
  const links = rtcLinks(options)
  type Served = { link?: Link, stream?: Stream, flush: () => void, owed: number, unread: number }
  const served = new Map<number, Served>()
  const post = (message: ToWorker, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer)

  /** Tells the worker how many of its bytes the channel has taken since the last time. */
  const acknowledge = (id: number, entry: Served) => {
    post({ t: 'ack', id, bytes: entry.owed })
    entry.owed = 0
  }

  /** A link ended by itself: the page keeps nothing of it, and the worker is told how it ended. */
  const ended = (id: number, message: ToWorker) => {
    served.delete(id)
    post(message)
  }

  const serve = async (id: number, make: (gathered: Gathered) => Promise<Made>) => {
    // The wait for the worker's `flush` is there before the connection is: on a page whose tasks run late the
    // flush comes first, and dropping it would leave the description unread and the connection open for good.
    let flush!: () => void
    const flushed = new Promise<void>(resolve => { flush = resolve })
    const entry: Served = { flush, owed: 0, unread: 0 }
    served.set(id, entry)
    const gathered: Gathered = ({ reflexive, complete }) => {
      void reflexive.then(() => post({ t: 'candidate', id, last: false }))
      void complete.then(() => post({ t: 'candidate', id, last: true }))
      return flushed
    }
    try {
      const { sdp, link } = await make(gathered)
      if (served.get(id) !== entry) return link.close()
      entry.link = link
      link.onopen = stream => {
        entry.stream = stream
        stream.on('drain', () => acknowledge(id, entry))
        stream.on('data', bytes => {
          const buffer = whole(bytes)
          entry.unread += buffer.byteLength
          post({ t: 'data', id, bytes: buffer }, [buffer])
          // The worker is this far behind and a channel cannot be paused: the link goes, the page does not grow.
          if (entry.unread > MAX_UNTAKEN) stream.destroy()
        })
        post({ t: 'open', id })
      }
      link.onclose = () => ended(id, { t: 'closed', id })
      post({ t: 'sdp', id, sdp })
    } catch (error) {
      ended(id, { t: 'failed', id, full: error instanceof LinksFull, reason: String(error) })
    }
  }

  port.onmessage = ({ data: message }: { data: ToPage }) => {
    if (message.t === 'offer') return void serve(message.id, gathered => links.offer(gathered))
    if (message.t === 'answer') return void serve(message.id, gathered => links.answer(message.sdp, gathered))
    const entry = served.get(message.id)
    if (!entry) return
    if (message.t === 'flush') entry.flush()
    else if (message.t === 'accept') entry.link?.accept(message.sdp).catch(() => { /* onclose reports it */ })
    else if (message.t === 'ack') entry.unread -= message.bytes
    else if (message.t === 'data') {
      entry.owed += message.bytes.byteLength
      if (entry.stream?.write(new Uint8Array(message.bytes))) acknowledge(message.id, entry)
    } else if (message.t === 'close') {
      served.delete(message.id)
      entry.flush()
      entry.link?.close()
    }
  }

  return () => {
    port.onmessage = null
    for (const entry of served.values()) {
      entry.flush()
      entry.link?.close()
    }
    served.clear()
  }
}

/**
 * The worker half: the links interface over the port whose other end `servePeerLinks` holds.
 *
 * A stream's `write` returns false once `SEND_HIGH` bytes wait for the page to pass them to the channel, and
 * `drain` follows at `SEND_LOW`. `remoteAddress` is always undefined: the page does not send addresses over.
 */
export const pageLinks = (port: PortLike): Links => {
  type Pending = { resolve: (made: Made) => void, reject: (error: Error) => void, reflexive: () => void, complete: () => void }
  type Open = { link: Link, stream?: Stream, unsent: number, waiting: boolean }
  const pending = new Map<number, Pending>()
  const open = new Map<number, Open>()
  let next = 0
  const post = (message: ToPage, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer)

  const request = (message: (id: number) => ToPage): Promise<Made> => new Promise((resolve, reject) => {
    const id = next++
    let reflexive!: () => void
    let complete!: () => void
    const gathering = {
      reflexive: new Promise<void>(done => { reflexive = done }),
      complete: new Promise<void>(done => { complete = done }),
    }
    pending.set(id, { resolve, reject, reflexive, complete })
    post(message(id))
    void gatherCap(gathering).then(() => { if (pending.has(id)) post({ t: 'flush', id }) })
  })

  const finish = (id: number, notify: boolean) => {
    const entry = open.get(id)
    if (!entry) return
    open.delete(id)
    entry.stream?.end()
    if (notify) entry.link.onclose?.()
  }

  const made = (id: number): Link => {
    const link: Link = {
      onopen: null,
      onclose: null,
      accept: async sdp => post({ t: 'accept', id, sdp }),
      close: () => {
        post({ t: 'close', id })
        finish(id, false)
      },
    }
    open.set(id, { link, unsent: 0, waiting: false })
    return link
  }

  port.onmessage = ({ data: message }: { data: ToWorker }) => {
    const { id } = message
    const asked = pending.get(id)
    if (message.t === 'candidate') return message.last ? asked?.complete() : asked?.reflexive()
    if (message.t === 'sdp' || message.t === 'failed') {
      pending.delete(id)
      // Settles the gathering wait, so its timers do not outlive the request.
      asked?.complete()
      if (message.t === 'sdp') asked?.resolve({ sdp: message.sdp, link: made(id) })
      else asked?.reject(message.full ? new LinksFull(message.reason) : new Error(message.reason))
      return
    }
    const entry = open.get(id)
    if (!entry) return
    if (message.t === 'open') {
      entry.stream = new Stream({
        write: bytes => {
          for (let at = 0; at < bytes.length; at += SLICE) {
            const slice = copy(bytes.subarray(at, at + SLICE))
            post({ t: 'data', id, bytes: slice }, [slice])
          }
          entry.unsent += bytes.length
          if (entry.unsent < SEND_HIGH) return true
          entry.waiting = true
          return false
        },
        close: () => {
          post({ t: 'close', id })
          finish(id, true)
        },
      })
      entry.link.onopen?.(entry.stream)
    } else if (message.t === 'data') {
      post({ t: 'ack', id, bytes: message.bytes.byteLength })
      entry.stream?.push(new Uint8Array(message.bytes))
    } else if (message.t === 'ack') {
      entry.unsent -= message.bytes
      if (entry.waiting && entry.unsent <= SEND_LOW) {
        entry.waiting = false
        entry.stream?.drained()
      }
    } else if (message.t === 'closed') {
      finish(id, true)
    }
  }

  return {
    offer: () => request(id => ({ t: 'offer', id })),
    answer: sdp => request(id => ({ t: 'answer', id, sdp })),
    remoteAddress: () => undefined,
  }
}
