// One in-memory byte stream with two ends, each the socket Session.addPeerStream takes. It stands
// in for a data channel: it cannot pause what the other end sends, and it holds what arrives until
// the engine attaches its listener.

import { EventEmitter } from 'node:events'

const HIGH = 1024 * 1024
const LOW = 256 * 1024
const SLICE_MS = 10

class StreamEnd extends EventEmitter {
  /** The other end. */
  peer = null
  /** Bytes written here and not yet delivered to the other end, and the most that ever was. */
  queued = 0
  peakQueued = 0
  written = 0
  received = 0
  writes = 0
  /** performance.now() when the engine attached its data listener, which is libtorrent's dial. */
  dialledAt = null
  destroyed = false
  destroyError = null
  #outbox = []
  #held = []
  #flowing = false
  #blocked = false
  #timer = null
  #bytesPerSecond

  /**
   * `bytesPerSecond` paces what this end sends, 0 for no pacing. `backpressure` makes write()
   * answer false past 1 MiB queued and emit 'drain' at 256 KiB, the marks a data channel socket
   * uses; without it write() takes everything, as a socket the shim does not hold back.
   */
  constructor({ backpressure = false, bytesPerSecond = 0 } = {}) {
    super()
    if (backpressure) this.backpressure = true
    this.#bytesPerSecond = bytesPerSecond
  }

  on(event, listener) {
    super.on(event, listener)
    if (event === 'data' && this.dialledAt == null) {
      this.dialledAt = performance.now()
      queueMicrotask(() => {
        this.#flowing = true
        for (const chunk of this.#held.splice(0)) this.emit('data', chunk)
      })
    }
    return this
  }

  write(chunk) {
    if (this.destroyed) return true
    this.writes++
    this.written += chunk.length
    this.queued += chunk.length
    this.peakQueued = Math.max(this.peakQueued, this.queued)
    this.#outbox.push(chunk)
    if (!this.#bytesPerSecond) queueMicrotask(() => this.#pump(Infinity))
    else this.#timer ??= setInterval(() => this.#pump(Math.ceil(this.#bytesPerSecond * SLICE_MS / 1000)), SLICE_MS)
    if (this.backpressure && this.queued > HIGH) {
      this.#blocked = true
      return false
    }
    return true
  }

  destroy(error) {
    if (this.destroyed) return
    this.destroyed = true
    this.destroyError = error ?? null
    this.#stop()
    this.#outbox = []
    const peer = this.peer
    if (!peer.destroyed) queueMicrotask(() => peer.emit('close'))
  }

  #stop() {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  #pump(budget) {
    while (budget > 0 && this.#outbox.length) {
      let chunk = this.#outbox[0]
      if (chunk.length > budget) {
        this.#outbox[0] = chunk.subarray(budget)
        chunk = chunk.subarray(0, budget)
      } else {
        this.#outbox.shift()
      }
      budget -= chunk.length
      this.queued -= chunk.length
      this.peer.#deliver(chunk)
    }
    if (!this.#outbox.length) this.#stop()
    if (this.#blocked && this.queued <= LOW) {
      this.#blocked = false
      this.emit('drain')
    }
  }

  #deliver(chunk) {
    if (this.destroyed) return
    this.received += chunk.length
    if (this.#flowing) this.emit('data', chunk)
    else this.#held.push(chunk)
  }
}

/** The two ends of a new stream. Options are per end: what `a` sets shapes what `a` sends. */
export const streamPipe = (a = {}, b = {}) => {
  const ends = [new StreamEnd(a), new StreamEnd(b)]
  ends[0].peer = ends[1]
  ends[1].peer = ends[0]
  return ends
}
