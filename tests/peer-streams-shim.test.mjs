// The shim's two tcp send paths, without the wasm. libtorrent's writes arrive as send (one buffer)
// or as sendmsg (several), and a socket held back on one path only still fills without bound:
// the first build of this held send back and the queue behind a slow stream still reached 7.3 MiB.
// The engine tests cannot tell the paths apart, since libtorrent picks which one a write takes.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

const EAGAIN = 6
const POLLOUT = 4

/** The shim evaluated on its own, with one connected tcp fd over `socket`. */
const shimWith = (socket) => {
  const heap = new Uint8Array(1 << 16)
  let library
  new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )((obj) => { library = obj }, { fkn: { net: {}, dgram: {}, storage: null } }, heap,
    new Int16Array(heap.buffer), new Uint16Array(heap.buffer), new Int32Array(heap.buffer), new Uint32Array(heap.buffer),
    { now: () => 0 }, { log() {}, warn() {}, error() {} })
  // Emscripten emits each `$name` as a module-level function, so the members call the bare names
  const FKN = library.$FKN
  globalThis.FKN = FKN
  globalThis.FKN_send = library.$FKN_send
  new Function('FKN', library.$FKN__postset)(FKN)
  FKN.scheduleTick = () => {}

  const st = { kind: 'tcp', family: 'IPv4', socket, connected: true }
  const fd = FKN.newFd(st)
  FKN.wireTcp(st, socket)

  const view = new DataView(heap.buffer)
  /** sendmsg with the given buffer lengths: a msghdr at 256, its iovecs at 512, the bytes from 1024. */
  const sendmsg = (...lengths) => {
    view.setUint32(256 + 8, 512, true)
    view.setUint32(256 + 12, lengths.length, true)
    let at = 1024
    lengths.forEach((length, i) => {
      view.setUint32(512 + i * 8, at, true)
      view.setUint32(512 + i * 8 + 4, length, true)
      at += length
    })
    return library.__syscall_sendmsg(fd, 256, 0)
  }
  /** Whether poll reports the fd writable: a pollfd at 128. */
  const writable = () => {
    view.setInt32(128, fd, true)
    view.setInt16(132, POLLOUT, true)
    library.$FKN_poll(128, 1)
    return (view.getInt16(134, true) & POLLOUT) !== 0
  }
  return { send: (length) => library.$FKN_send(fd, 1024, length), sendmsg, writable }
}

const socketAnswering = (answer, backpressure) => {
  const socket = new EventEmitter()
  socket.written = []
  socket.write = (chunk) => { socket.written.push(chunk.length); return answer() }
  if (backpressure) socket.backpressure = true
  return socket
}

test('a socket that asks for backpressure is held back on send and on sendmsg until it drains', () => {
  let full = true
  const socket = socketAnswering(() => !full, true)
  const { send, sendmsg, writable } = shimWith(socket)

  assert.equal(writable(), true)
  assert.equal(send(100), 100, 'the write that answers false is still taken')
  assert.equal(send(100), -EAGAIN)
  assert.equal(sendmsg(40, 60), -EAGAIN)
  assert.equal(sendmsg(100), -EAGAIN)
  assert.equal(writable(), false, 'a held fd reads as writable')
  assert.deepEqual(socket.written, [100], 'bytes were written while the socket was held back')

  full = false
  socket.emit('drain')
  assert.equal(writable(), true)
  assert.equal(sendmsg(40, 60), 100)
  assert.equal(send(50), 50)
  assert.deepEqual(socket.written, [100, 100, 50])

  // and the same from the other path: a sendmsg that answers false holds back a send
  full = true
  assert.equal(sendmsg(30, 30), 60)
  assert.equal(send(10), -EAGAIN)
  assert.deepEqual(socket.written, [100, 100, 50, 60])
})

test('a socket that does not ask is written to whatever write() answers', () => {
  const socket = socketAnswering(() => false, false)
  const { send, sendmsg, writable } = shimWith(socket)
  assert.equal(send(100), 100)
  assert.equal(sendmsg(40, 60), 100)
  assert.equal(send(100), 100)
  assert.equal(writable(), true)
  assert.deepEqual(socket.written, [100, 100, 100])
})
