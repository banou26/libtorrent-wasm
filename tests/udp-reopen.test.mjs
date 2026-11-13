// The UDP socket under a fd does not survive losing the connection, and nothing above the
// shim can see that happen: a dead socket still accepts send(). These cover the shim healing itself.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

const makeDgram = () => {
  const sockets = []
  return {
    sockets,
    createSocket() {
      const sock = new EventEmitter()
      sock.bindCalls = []
      sock.sent = []
      sock.closed = false
      sock.bind = (port, address) => { sock.bindCalls.push({ port, address }); sock.emit('listening') }
      sock.send = (buf, offset, length, port, address) => { sock.sent.push({ length, port, address }) }
      sock.close = () => { sock.closed = true }
      sock.address = () => ({ address: '0.0.0.0', port: 6882, family: 'IPv4' })
      sockets.push(sock)
      return sock
    },
  }
}

// `wasm` stands in for the module's exports the shim calls
const loadShim = (dgram, wasm = {}) => {
  const heap = new Uint8Array(1 << 16)
  let library
  const addToLibrary = (obj) => { library = obj }
  const fn = new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )
  fn(addToLibrary, { fkn: { net: {}, dgram, storage: null }, ...wasm }, heap,
    new Int16Array(heap.buffer), new Uint16Array(heap.buffer), new Int32Array(heap.buffer), new Uint32Array(heap.buffer),
    { now: () => 0 }, { log() {}, warn() {}, error() {} })

  // Emscripten emits `$FKN` as a module-level `var FKN`, so the member functions refer to the bare identifier
  const FKN = library.$FKN
  globalThis.FKN = FKN
  // $FKN__postset is what fills the fd table at link time; there is no linker here.
  const postset = library.$FKN__postset
  new Function('FKN', postset)(FKN)
  FKN.dgram = dgram
  FKN.net = {}
  FKN.scheduleTick = () => {}
  return { FKN, library, heap }
}

// Timers outlive the test that scheduled them, and every shim shares one global FKN
const settled = (st) => { st.closed = true }

const boundUdpState = (FKN) => {
  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0
  FKN._dbgWorkerUdpBytes = 0
  FKN._dbgJsBusyUs = 0
  FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  st.socket.bind(6882, '0.0.0.0')
  st.localAddr = '0.0.0.0'
  st.localPort = 6882
  st.localFamily = 'IPv4'
  st.bound = true
  return st
}

test('a closed socket is replaced and re-bound to the same port', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)
  assert.equal(dgram.sockets.length, 1)

  st.socket.emit('error', Object.assign(new Error('WebVPN session closed'), { errno: 5 }))
  st.socket.emit('close')
  assert.equal(st.dead, true, 'the socket is marked dead straight away')

  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(dgram.sockets.length, 2, 'a replacement socket was created')
  assert.equal(st.socket, dgram.sockets[1], 'the fd now points at the replacement')
  assert.deepEqual(dgram.sockets[1].bindCalls, [{ port: 6882, address: '0.0.0.0' }],
    'the replacement is back on the endpoint peers and trackers already have')
  assert.equal(st.dead, false, 'the fd is usable again')
  settled(st)
})

test('error and close together only produce one replacement', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)

  st.socket.emit('error', new Error('WebVPN session closed'))
  st.socket.emit('close')
  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(dgram.sockets.length, 2, 'the three events are one outage, not three')
  assert.equal(FKN.stats.udpReopen, 1)
  settled(st)
})

test('sends report EAGAIN while the socket is gone instead of claiming success', async () => {
  const dgram = makeDgram()
  const { FKN, library, heap } = loadShim(dgram)
  const st = boundUdpState(FKN)
  const fd = FKN.newFd(st)

  // A sockaddr_in for 1.2.3.4:6881
  const addrPtr = 1024
  heap[addrPtr] = 2
  heap[addrPtr + 1] = 0
  new DataView(heap.buffer).setUint16(addrPtr + 2, 6881, false)
  heap.set([1, 2, 3, 4], addrPtr + 4)

  const sendto = library.$FKN_sendto.bind({})
  const before = sendto(fd, 2048, 16, 0, addrPtr, 16)
  assert.equal(before, 16, 'a healthy socket reports the bytes sent')

  st.socket.emit('close')
  const during = sendto(fd, 2048, 16, 0, addrPtr, 16)
  assert.equal(during, -FKN.err.AGAIN,
    'a send over a socket that is gone must not be reported as delivered')

  await new Promise((resolve) => setTimeout(resolve, 400))
  const after = sendto(fd, 2048, 16, 0, addrPtr, 16)
  assert.equal(after, 16, 'once the replacement is up, sends work again')
  assert.equal(dgram.sockets[1].sent.length, 1, 'and they go out over the new socket')
  settled(st)
})

test('a udp fd is not writable while its socket is being replaced, in poll and in select', async (t) => {
  const dgram = makeDgram()
  const { FKN, library, heap } = loadShim(dgram)
  const st = boundUdpState(FKN)
  t.after(() => settled(st))
  const fd = FKN.newFd(st)
  const view = new DataView(heap.buffer)

  const pollfd = 4096
  const polledWritable = () => {
    view.setInt32(pollfd, fd, true)
    view.setInt16(pollfd + 4, 4, true)
    library.$FKN_poll(pollfd, 1)
    return (view.getInt16(pollfd + 6, true) & 4) !== 0
  }
  const writeSet = 8192
  const selectedWritable = () => {
    heap.fill(0, writeSet, writeSet + 128)
    heap[writeSet + (fd >>> 3)] |= 1 << (fd & 7)
    library.__syscall__newselect(fd + 1, 0, writeSet, 0, 0)
    return ((heap[writeSet + (fd >>> 3)] >> (fd & 7)) & 1) === 1
  }
  const writable = () => [polledWritable(), selectedWritable()]

  assert.deepEqual(writable(), [true, true], 'a healthy udp fd is not writable')
  st.socket.emit('error', new Error('WebVPN session closed'))
  st.socket.emit('close')
  assert.deepEqual(writable(), [false, false], 'an fd whose sends answer EAGAIN reads as writable')

  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(writable(), [true, true], 'the replacement socket is not writable')
})

test('a socket back up starts its backoff over, though no datagram has come in', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)

  for (let outage = 1; outage <= 2; outage++) {
    st.socket.emit('close')
    // 400 against UDP_REOPEN_DELAYS: the first reopen of an outage comes after 250 ms, a second one after 1 s
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(dgram.sockets.length, outage + 1, `outage ${outage} was not reopened after 250 ms`)
    assert.equal(st.reopenAttempts, 0)
  }
  settled(st)
})

test('closing the fd does not trigger a reopen', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)
  const fd = FKN.newFd(st)

  FKN.closeFd(fd)
  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(dgram.sockets.length, 1, 'a deliberate close is not an outage')
})

/**
 * A relay that grants a bind on a free port on a later turn, as @fkn/lib answers, and refuses one
 * while it is `away` or on a port in `taken`.
 */
const makeRelayDgram = () => {
  const relay = { away: false, taken: new Set(), binds: [] }
  relay.createSocket = () => {
    const sock = new EventEmitter()
    sock.bind = (port) => {
      relay.binds.push({ at: Date.now(), port })
      setTimeout(() => {
        if (relay.away || relay.taken.has(port)) { sock.emit('error', new Error('refused')); return }
        sock.granted = port || 50000
        sock.emit('listening')
      }, 30)
    }
    sock.send = () => {}
    sock.close = () => {}
    sock.address = () => ({ address: '0.0.0.0', port: sock.granted, family: 'IPv4' })
    return sock
  }
  return relay
}

// in steps, because a mocked tick runs only the timers due when it started: one set by a timer that
// fired during it waits for the next tick
const STEP = 10
const advance = (t, ms) => { for (let i = 0; i < ms / STEP; i++) t.mock.timers.tick(STEP) }

const relayUdpState = (t, relay, wasm) => {
  const { FKN } = loadShim(relay, wasm)
  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0; FKN._dbgWorkerUdpBytes = 0; FKN._dbgJsBusyUs = 0; FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  st.socket.bind(6882, '0.0.0.0')
  st.bound = true
  t.mock.timers.tick(30)
  t.after(() => settled(st))
  const drop = () => { st.socket.emit('error', new Error('WebVPN session closed')); st.socket.emit('close') }
  const healed = () => !st.dead && st.socket.granted != null
  return { FKN, st, drop, healed }
}

test('a relay back after 20 s or 45 s is found within 2 s, on the port the fd held', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const relay = makeRelayDgram()
  const { st, drop, healed } = relayUdpState(t, relay)
  assert.equal(st.localPort, 6882)

  for (const awayMs of [20_000, 45_000]) {
    relay.away = true
    const from = relay.binds.length
    drop()
    advance(t, awayMs)
    relay.away = false
    const back = Date.now()
    for (let i = 0; i < 250 && !healed(); i++) t.mock.timers.tick(STEP)
    const asked = relay.binds.slice(from)
    assert.equal(st.socket.granted, 6882, `not back 2.5 s after a relay away ${awayMs} ms`)
    assert.ok(asked.at(-1).at - back <= 2000 + 30 + 2 * STEP, `found ${asked.at(-1).at - back} ms after a relay away ${awayMs} ms`)
    assert.deepEqual([...new Set(asked.map((b) => b.port))], [6882], 'a reopen gave up the port peers know')
  }
})

test('a port somebody took is given up after KEEP_PORT_MS, and the next outage asks for it again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const relay = makeRelayDgram()
  const { FKN, st, drop, healed } = relayUdpState(t, relay)

  relay.taken.add(6882)
  const from = relay.binds.length
  const lost = Date.now()
  drop()
  for (let i = 0; i < 7000 && !healed(); i++) t.mock.timers.tick(STEP)
  const asked = relay.binds.slice(from)
  const moved = asked.findIndex((b) => b.port === 0)
  assert.ok(moved > 0, 'never took another port')
  assert.ok(asked.slice(0, moved).every((b) => b.port === 6882 && b.at - lost < FKN.KEEP_PORT_MS), 'gave up the port too early')
  assert.ok(asked[moved].at - lost >= FKN.KEEP_PORT_MS && asked[moved].at - lost <= FKN.KEEP_PORT_MS + 2000 + 30 + 2 * STEP)
  assert.equal(st.localPort, 50000)

  relay.taken.clear()
  drop()
  for (let i = 0; i < 250 && !healed(); i++) t.mock.timers.tick(STEP)
  assert.equal(relay.binds.at(-1).port, 6882, 'the next outage did not ask for the published port')
  assert.equal(st.localPort, 6882)
})

/** A socket on a relay that can be taken away, and the calls it makes into the engine, timed. */
const redialRig = (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const relay = makeRelayDgram()
  const calls = []
  const rig = relayUdpState(t, relay, {
    _lt_session_cut_utp_peers: () => { calls.push({ what: 'cut', at: Date.now() }) },
    _lt_session_redial_cut_peers: () => { calls.push({ what: 'redial', at: Date.now() }) },
  })
  // the relay away `ms`, then back: when the socket healed
  const outage = (ms) => {
    relay.away = true
    rig.drop()
    rig.drop()
    advance(t, ms)
    relay.away = false
    for (let i = 0; i < 250 && !rig.healed(); i++) t.mock.timers.tick(STEP)
    assert.ok(rig.healed(), `not back 2.5 s after a relay away ${ms} ms`)
    return Date.now()
  }
  return { ...rig, calls, outage }
}

test('a socket back after more than REDIAL_AFTER_MS cuts its uTP peers, once, and a blip or a first bind does not', (t) => {
  const { FKN, calls, outage } = redialRig(t)
  assert.deepEqual(calls, [], 'the first bind cut its peers')

  for (const [awayMs, cut] of [[5_000, true], [1_000, false], [20_000, true]]) {
    const from = calls.length
    const healedAt = outage(awayMs)
    advance(t, FKN.REDIAL_WAIT_MS + STEP)
    const after = calls.slice(from).map((c) => c.what)
    assert.deepEqual(after, cut ? ['cut', 'redial'] : ['redial'], `a relay away ${awayMs} ms, healed ${healedAt - 1_000_000} ms in`)
  }
})

test('the cut peers are dialled again once the socket has stayed up REDIAL_WAIT_MS, not into a socket that went away again', (t) => {
  const { FKN, calls, outage } = redialRig(t)

  // back, and away again 1 s later: nothing is dialled until a socket lasts
  outage(20_000)
  advance(t, 1_000)
  const second = outage(20_000)
  advance(t, FKN.REDIAL_WAIT_MS + STEP)
  assert.deepEqual(calls.map((c) => c.what), ['cut', 'cut', 'redial'])
  assert.ok(calls[2].at - second >= FKN.REDIAL_WAIT_MS && calls[2].at - second <= FKN.REDIAL_WAIT_MS + 2 * STEP, `dialled ${calls[2].at - second} ms after the socket was back`)

  // a short outage right after a cut still dials the cut peers once the socket lasts
  calls.length = 0
  outage(20_000)
  advance(t, 500)
  const blip = outage(1_000)
  advance(t, FKN.REDIAL_WAIT_MS + STEP)
  assert.deepEqual(calls.map((c) => c.what), ['cut', 'redial'])
  assert.ok(calls[1].at - blip >= FKN.REDIAL_WAIT_MS, 'dialled before the socket had lasted')
})
