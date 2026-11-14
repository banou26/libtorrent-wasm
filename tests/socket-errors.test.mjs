// What libtorrent reads when a host's tcp socket fails. A host gives Node's errors, whose errno is
// Node's own (negative, Linux numbering), and the shim answers in Emscripten's (WASI) numbers, so a
// reset passed through as -104 was read back by recv as 104 bytes received.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { offlineHost } from '../build/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

// Emscripten's system/include/wasi/api.h
const ECONNREFUSED = 14
const ECONNRESET = 15
const EHOSTUNREACH = 23
const ENETUNREACH = 40
const ETIMEDOUT = 73

const AF_INET = 2
const SOCK_STREAM = 1
const SOL_SOCKET = 1
const SO_ERROR = 4

/** The shim on its own over `net`, with one tcp fd it dialled. */
const dial = (t, net) => {
  const heap = new Uint8Array(1 << 12)
  let library
  new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )((obj) => { library = obj }, { fkn: { net, dgram: {}, storage: null } }, heap,
    new Int16Array(heap.buffer), new Uint16Array(heap.buffer), new Int32Array(heap.buffer), new Uint32Array(heap.buffer),
    { now: () => 0 }, { log() {}, warn() {}, error() {} })
  // Emscripten emits each `$name` as a module-level function, so the members call the bare names
  const FKN = library.$FKN
  globalThis.FKN = FKN
  for (const name of Object.keys(library)) {
    if (name.startsWith('$FKN_') && typeof library[name] === 'function') globalThis[name.slice(1)] = library[name]
  }
  new Function('FKN', library.$FKN__postset)(FKN)
  FKN.scheduleTick = () => {}
  t.after(() => FKN.teardown())

  const view = new DataView(heap.buffer)
  view.setUint16(64, AF_INET, true)
  view.setUint16(66, 6881)
  heap.set([192, 0, 2, 10], 68)
  const fd = library.__syscall_socket(AF_INET, SOCK_STREAM, 0)
  assert.equal(library.__syscall_connect(fd, 64, 16), 0)
  return {
    recv: () => library.__syscall_recvfrom(fd, 1024, 512, 0, 0, 0),
    soError: () => {
      assert.equal(library.__syscall_getsockopt(fd, SOL_SOCKET, SO_ERROR, 128, 132), 0)
      return view.getInt32(128, true)
    },
  }
}

/** A socket as a host's net.connect gives it, which fails with `error` as Node's does: an error, then a close. */
const failing = (error) => {
  const socket = new EventEmitter()
  socket.destroy = () => {}
  return { net: { connect: () => socket }, fail: () => { socket.emit('error', error); socket.emit('close', true) } }
}

const nodeError = (message, fields) => Object.assign(new Error(message), fields)

test('a reset reads as ECONNRESET, then as the end of the stream', (t) => {
  const { net, fail } = failing(nodeError('read ECONNRESET', { code: 'ECONNRESET', errno: -104, syscall: 'read' }))
  const { recv } = dial(t, net)
  fail()
  assert.deepEqual([recv(), recv()], [-ECONNRESET, 0])
})

for (const [code, errno, wasi] of [
  ['ECONNREFUSED', -111, ECONNREFUSED],
  ['ETIMEDOUT', -110, ETIMEDOUT],
  ['EHOSTUNREACH', -113, EHOSTUNREACH],
  ['ENETUNREACH', -101, ENETUNREACH],
]) {
  test(`a connect that fails with ${code} reads it through SO_ERROR`, (t) => {
    const { net, fail } = failing(nodeError(`connect ${code} 192.0.2.10:6881`, { code, errno, syscall: 'connect' }))
    const { soError } = dial(t, net)
    fail()
    assert.equal(soError(), wasi)
  })
}

for (const [what, error] of [
  ['no code', new Error('Connection reset by peer')],
  ['a code the shim does not know', nodeError('getaddrinfo ENOTFOUND example.org', { code: 'ENOTFOUND', errno: -3008 })],
]) {
  test(`an error with ${what} reads as a reset`, (t) => {
    const { net, fail } = failing(error)
    const { recv } = dial(t, net)
    fail()
    assert.deepEqual([recv(), recv()], [-ECONNRESET, 0])
  })
}

test('offlineHost() refuses a connect as ECONNREFUSED', async (t) => {
  const { soError } = dial(t, offlineHost().net)
  // the refusal comes on a microtask
  await new Promise(setImmediate)
  assert.equal(soError(), ECONNREFUSED)
})
