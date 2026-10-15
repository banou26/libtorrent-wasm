// Emscripten hands a 64-bit file offset to the shim as two i32 halves, and the low half arrives
// SIGNED. Joined without `>>> 0`, every offset from 2 GiB to 4 GiB came out negative, the storage
// refused it, and a torrent with a file that large looped on Retrying forever (HOR-497).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

const loadShim = (storage) => {
  const heap = new Uint8Array(1 << 16)
  const completed = []
  const Module = {
    fkn: { net: {}, dgram: {}, storage },
    _lt_disk_complete_read: (jobLo, jobHi, ptr, len, err) => completed.push({ kind: 'read', len, err }),
    _lt_disk_complete_write: (jobLo, jobHi, err) => completed.push({ kind: 'write', err }),
  }
  let library
  const fn = new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAPU16', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )
  fn((obj) => { library = obj }, Module, heap, new Uint16Array(heap.buffer), new Uint32Array(heap.buffer),
    { now: () => 0 }, { log() {}, warn() {}, error() {} })
  const FKN = library.$FKN
  globalThis.FKN = FKN
  new Function('FKN', library.$FKN__postset)(FKN)
  FKN.storage = storage
  FKN.scheduleTick = () => {}
  globalThis._malloc = () => 0
  return { library, completed }
}

// what the wasm side passes for an i64: the low 32 bits as a signed i32, then the high 32 bits
const halves = (offset) => [offset % 0x100000000 | 0, Math.floor(offset / 0x100000000)]

const offsets = [0, 0x7fffffff, 2_365_587_456, 0xffffffff, 0x100000000, 6.5 * 2 ** 30]

test('a write reaches the storage at its real offset, past 2 GiB and past 4 GiB', () => {
  const seen = []
  const { library, completed } = loadShim({ write: (id, file, offset) => { seen.push(offset) } })
  for (const offset of offsets) library.js_disk_write(1, 0, 0, 0, ...halves(offset), 0, 16)
  assert.deepEqual(seen, offsets)
  assert.ok(completed.every((c) => c.err === 0))
})

test('a read reaches the storage at its real offset, past 2 GiB and past 4 GiB', () => {
  const seen = []
  const { library } = loadShim({ read: (id, file, offset, len) => { seen.push(offset); return new Uint8Array(len) } })
  for (const offset of offsets) library.js_disk_read(1, 0, 0, 0, ...halves(offset), 16)
  assert.deepEqual(seen, offsets)
})
