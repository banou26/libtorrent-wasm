/**
 * The six WASI calls the stack imports, and all it asks of its host: random bytes, the two
 * clocks, an empty environment, standard error and exit. `memory` is read on every call because
 * growing the wasm memory replaces its buffer.
 *
 * The stack writes to standard error only when it panics, and `stderr` is given that text.
 */
export const wasi = (memory: () => ArrayBuffer, stderr: (text: string) => void) => ({
  random_get(pointer: number, length: number) {
    // getRandomValues fills at most 65536 bytes a call
    for (let offset = 0; offset < length; offset += 65536) {
      crypto.getRandomValues(new Uint8Array(memory(), pointer + offset, Math.min(65536, length - offset)))
    }
    return 0
  },
  clock_time_get(id: number, _precision: bigint, out: number) {
    const milliseconds = id === 0 ? Date.now() : performance.now()
    new DataView(memory()).setBigUint64(out, BigInt(Math.round(milliseconds * 1e6)), true)
    return 0
  },
  environ_sizes_get(count: number, size: number) {
    const view = new DataView(memory())
    view.setUint32(count, 0, true)
    view.setUint32(size, 0, true)
    return 0
  },
  environ_get: () => 0,
  fd_write(_fd: number, vectors: number, count: number, written: number) {
    const view = new DataView(memory())
    let total = 0
    for (let i = 0; i < count; i++) {
      const length = view.getUint32(vectors + i * 8 + 4, true)
      stderr(new TextDecoder().decode(new Uint8Array(memory(), view.getUint32(vectors + i * 8, true), length)))
      total += length
    }
    view.setUint32(written, total, true)
    return 0
  },
  proc_exit(code: number): never {
    throw new Error(`the WebRTC stack exited with code ${code}`)
  },
})
