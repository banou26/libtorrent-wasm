/** Sending stops once this many bytes wait in a queue, and resumes once the queue is back under `SEND_LOW`. */
export const SEND_HIGH = 1024 * 1024
export const SEND_LOW = 256 * 1024

// Under every engine's message limit: 65,536 when the remote description names none, 262,144 between engines
// (Chrome 156, Firefox 158, WebKit 26.5, 2026-11-12). It is also what the reference client sends.
/** The largest piece of a write sent as one message. */
export const SLICE = 16 * 1024

/** Bytes a stream keeps before anything reads it. A peer's handshake is 68. */
export const MAX_HELD = 1024 * 1024

/**
 * One peer connection as the socket libtorrent's shim takes from a host: what `Session.addPeerStream` is given.
 *
 * `write` keeps the bytes it is handed, so they must not change afterwards. It never throws. After a `write` that
 * returned false the caller waits for `drain`. Bytes that arrived before the first `data` listener are delivered
 * to it in order, and a listener added after the stream ended still hears `end`, `close` and `error`. It names no
 * `maxRecvQueue`: how much may sit unread is the engine's to say, which knows what it asked the peer for.
 */
export type PeerStream = {
  readonly backpressure: true
  write(bytes: Uint8Array): boolean
  destroy(): void
  on(event: 'data', listener: (bytes: Uint8Array) => void): PeerStream
  on(event: 'drain' | 'end' | 'close', listener: () => void): PeerStream
  on(event: 'error', listener: (error: Error) => void): PeerStream
}

/** Where a stream's writes go, and what its `destroy` closes. */
export type StreamSink = {
  write(bytes: Uint8Array): boolean
  close(): void
}

type Listener = (argument?: any) => void

/** A `PeerStream` over any transport that can take bytes and be closed. The transport calls `push`, `drained` and `end`. */
export class Stream implements PeerStream {
  readonly backpressure = true
  private listeners = new Map<string, Listener[]>()
  private held: Uint8Array[] | null = []
  private heldBytes = 0
  private ended: Error | boolean = false

  constructor(private readonly sink: StreamSink) {}

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event)
    if (listeners) listeners.push(listener)
    else this.listeners.set(event, [listener])
    if (event === 'data' && this.held) {
      const held = this.held
      this.held = null
      for (const bytes of held) listener(bytes)
    }
    if (this.ended && (event === 'end' || event === 'close')) queueMicrotask(listener)
    if (this.ended instanceof Error && event === 'error') {
      const error = this.ended
      queueMicrotask(() => listener(error))
    }
    return this
  }

  /** How many listeners an event has. Zero for `data` means nothing reads the stream yet. */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0
  }

  write(bytes: Uint8Array): boolean {
    return this.ended ? true : this.sink.write(bytes)
  }

  destroy() {
    if (this.ended) return
    this.ended = true
    this.held = null
    this.sink.close()
  }

  /** Bytes from the remote. */
  push(bytes: Uint8Array) {
    if (this.ended) return
    if (!this.held) return this.emit('data', bytes)
    this.heldBytes += bytes.length
    if (this.heldBytes > MAX_HELD) {
      this.end(new Error(`${this.heldBytes} bytes arrived before anything read the stream`))
      this.sink.close()
      return
    }
    this.held.push(bytes)
  }

  /** The transport took everything written so far. */
  drained() {
    if (!this.ended) this.emit('drain')
  }

  /** The transport is gone, with an error when it failed. */
  end(error?: Error) {
    if (this.ended) return
    this.ended = error ?? true
    if (error) this.emit('error', error)
    this.emit('end')
    this.emit('close')
  }

  private emit(event: string, argument?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(argument)
  }
}
