// The socket shim on its own, without the wasm, for what the engine tests cannot aim at. libtorrent
// picks whether a write goes out as send (one buffer) or as sendmsg (several), and it never dials
// the addresses on either side of the stream range.
//
// A socket held back on one send path only still fills without bound: the first build of this held
// send back and the queue behind a slow stream still reached 7.3 MiB.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

const EAGAIN = 6
const ECONNREFUSED = 14
const POLLOUT = 4
const AF_INET = 2
const SOCK_STREAM = 1
const SOCK_DGRAM = 2

/** The shim evaluated on its own over `host`, with its heap and the structs a syscall reads from it. */
const loadShim = (host = { net: {}, dgram: {}, storage: null }) => {
  const heap = new Uint8Array(1 << 16)
  let library
  new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )((obj) => { library = obj }, { fkn: host }, heap,
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

  const view = new DataView(heap.buffer)
  /** A sockaddr_in at 64. */
  const sockaddr = (address, port) => {
    view.setUint16(64, AF_INET, true)
    view.setUint16(66, port)
    heap.set(address.split('.').map(Number), 68)
    return 64
  }
  /** sendmsg with the given buffer lengths: a msghdr at 256, its iovecs at 512, the bytes from 1024. */
  const sendmsg = (fd, lengths, name = 0) => {
    view.setUint32(256, name, true)
    view.setUint32(256 + 4, name ? 16 : 0, true)
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
  return { library, FKN, heap, view, sockaddr, sendmsg }
}

/** The shim with one connected tcp fd over `socket`. */
const shimWith = (socket) => {
  const { library, FKN, view, sendmsg } = loadShim()
  const st = { kind: 'tcp', family: 'IPv4', socket, connected: true }
  const fd = FKN.newFd(st)
  FKN.wireTcp(st, socket)
  /** Whether poll reports the fd writable: a pollfd at 128. */
  const writable = () => {
    view.setInt32(128, fd, true)
    view.setInt16(132, POLLOUT, true)
    library.$FKN_poll(128, 1)
    return (view.getInt16(134, true) & POLLOUT) !== 0
  }
  return { send: (length) => library.$FKN_send(fd, 1024, length), sendmsg: (...lengths) => sendmsg(fd, lengths), writable }
}

/** A datagram socket that records what it is asked to send. */
const datagramSocket = () => {
  const socket = new EventEmitter()
  socket.sent = []
  socket.bind = () => {}
  socket.close = () => {}
  socket.send = (bytes, offset, length, port, address) => { socket.sent.push({ text: Buffer.from(bytes).toString(), port, address }) }
  return socket
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

test('only 100.64.0.0/10 stays in the shim: the address on either side of it goes to the host', (t) => {
  const connects = []
  const asked = []
  const udpSocket = datagramSocket()
  const { library, FKN, sockaddr } = loadShim({
    storage: null,
    takeStream: (address) => { asked.push(address) },
    net: { connect: ({ host }) => { connects.push(host); return new EventEmitter() } },
    dgram: { createSocket: () => udpSocket },
  })
  t.after(() => FKN.teardown())
  const udp = library.__syscall_socket(AF_INET, SOCK_DGRAM, 0)

  // the address before the range, its first, its last, and the address after it
  const answers = ['100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0'].map((address) => [
    library.__syscall_connect(library.__syscall_socket(AF_INET, SOCK_STREAM, 0), sockaddr(address, 6881), 16),
    library.__syscall_sendto(udp, 1024, 20, 0, sockaddr(address, 6881), 16),
  ])

  assert.deepEqual(connects, ['100.63.255.255', '100.128.0.0'])
  assert.deepEqual(asked, ['100.64.0.0', '100.127.255.255'], 'the session was not asked for exactly the range')
  assert.deepEqual(udpSocket.sent.map((d) => d.address), ['100.63.255.255', '100.128.0.0'])
  // a dial with no stream behind it is refused, and a dropped datagram reads as sent
  assert.deepEqual(answers, [[0, 20], [-ECONNREFUSED, 20], [-ECONNREFUSED, 20], [0, 20]])
})

test('a datagram of several buffers leaves as one, and is dropped or held as a datagram of one is', (t) => {
  const udpSocket = datagramSocket()
  const { library, FKN, heap, sockaddr, sendmsg } = loadShim({ storage: null, net: {}, dgram: { createSocket: () => udpSocket } })
  t.after(() => FKN.teardown())
  const fd = library.__syscall_socket(AF_INET, SOCK_DGRAM, 0)
  heap.set(Buffer.from('headpayload'), 1024)

  assert.equal(sendmsg(fd, [4, 7], sockaddr('198.51.100.3', 6881)), 11)
  assert.deepEqual(udpSocket.sent, [{ text: 'headpayload', port: 6881, address: '198.51.100.3' }])

  assert.equal(sendmsg(fd, [4, 7], sockaddr('100.64.0.1', 6881)), 11, 'a dropped datagram reads as sent')
  assert.equal(udpSocket.sent.length, 1, 'a datagram to a stream address reached the host')

  // the socket under the fd has gone, and the one that replaces it is not there yet
  udpSocket.emit('close')
  assert.equal(sendmsg(fd, [4, 7], sockaddr('198.51.100.3', 6881)), -EAGAIN)
  assert.equal(udpSocket.sent.length, 1, 'a datagram was sent through a socket that had closed')
})
