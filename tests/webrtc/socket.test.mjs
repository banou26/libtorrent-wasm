// The one socket of a factory: how many datagrams it is handed at a time, which connection a
// datagram goes to, what is dropped, and what its error and its close do. In-memory sockets,
// each remote on an address of its own.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebRTC, MiB, once, pair, receive, send, settled, wasm, within } from './rig/local.mjs'
import { network } from './rig/memory-network.mjs'

/**
 * One factory, and `remotes` more with a connection each, joined to a connection of the first.
 * `options` are the first factory's, `wire` the network's.
 */
async function star(t, remotes, options, wire) {
  const { socket } = network(wire)
  const make = async (address, port, options) => {
    const made = socket(address, port)
    const webrtc = await createWebRTC({ socket: made, address, port, wasm, allowPrivateCandidates: true, ...options })
    t.after(webrtc.close)
    return { webrtc, socket: made }
  }
  const local = await make('203.0.113.1', 40000, options)
  const links = []
  for (let i = 0; i < remotes; i++) {
    const remote = await make('198.51.100.2', 41000 + i)
    const ours = new local.webrtc.RTCPeerConnection()
    const theirs = new remote.webrtc.RTCPeerConnection()
    const [channel, far] = await pair(ours, theirs, `link ${i}`)
    links.push({ ours, theirs, channel, far, remote: remote.webrtc })
  }
  return { local, links, socket }
}

/** Every event of a connection and its channel from now on, in order. */
function record({ ours, channel }) {
  const events = []
  ours.onconnectionstatechange = () => events.push(ours.connectionState)
  channel.onerror = ({ error }) => events.push(`error ${error.name}: ${error.message}`)
  channel.onclose = () => events.push(`close ${channel.readyState}`)
  return events
}

/**
 * A link whose window is open: 8 MiB have gone over it and all of it is acknowledged. A new
 * connection sends four datagrams at a time and more with each acknowledgement.
 */
async function warmed(t, options, wire) {
  const { local, links } = await star(t, 1, options, wire)
  const [{ channel, far }] = links
  const moved = Promise.all([receive(far, 8 * MiB), send(channel, 8 * MiB, 16384)])
  await within(moved, 10_000, 'the 8 MiB that open the window did not go over in 10 s')
  await settled(channel, 10_000)
  // long enough for the last millisecond the socket was counted in to be over
  await new Promise((resolve) => setTimeout(resolve, 5))
  /** Every later datagram handed to the socket, as the time it was, and the number of each DTLS record of data. */
  const handed = []
  const records = []
  const { socket } = local
  const sendNow = socket.send
  socket.send = (data, ...rest) => {
    handed.push(performance.now())
    // DTLS 1.2: type 23 is application data, and bytes 5 to 10 count the records in the order they were made
    if (data[0] === 23) records.push(new DataView(data.buffer, data.byteOffset).getUint32(7))
    sendNow(data, ...rest)
  }
  return { local, channel, far, handed, records }
}

/** The most datagrams of `handed` within any one millisecond. */
function busiest(handed) {
  let most = 0
  for (let first = 0, last = 0; last < handed.length; last++) {
    while (handed[last] - handed[first] >= 1) first++
    most = Math.max(most, last - first + 1)
  }
  return most
}

/** `messages` of 16 KiB on `channel`, in the one task that calls this. */
function write(channel, messages) {
  const message = new Uint8Array(16384)
  for (let i = 0; i < messages; i++) channel.send(message)
}

// Counted, never "until the remote drops us": 4 MiB into a window of about 1 MiB is some 930
// datagrams with no bound, and the test reads how many the socket was handed.
test('a write into an open window hands the socket 128 datagrams in its task, and no millisecond more than 256', async (t) => {
  // each datagram arrives in a task of its own, and the send buffer is no limit: the peer's window is
  const { channel, far, handed, records } = await warmed(t, { sendBufferSize: 4 * MiB }, { task: true })
  const arriving = receive(far, 4 * MiB)
  write(channel, 256)
  // the microtask the sends were queued for has run, and no task has begun since
  await Promise.resolve()
  assert.ok(handed.length > 100, `only ${handed.length} datagrams were ready, so the window was not open and this proves nothing`)
  assert.ok(handed.length <= 128, `one task handed the socket ${handed.length} datagrams`)

  const arrived = await within(arriving, 10_000, 'what waited did not all go out and arrive in 10 s')
  assert.equal(arrived.bytes, 4 * MiB)
  assert.ok(busiest(handed) <= 256, `the socket was handed ${busiest(handed)} datagrams within one millisecond`)
  assert.ok(records.length > 3600, 'the whole of it went through the socket that was watched')
  const late = records.findIndex((record, at) => at > 0 && record !== records[at - 1] + 1)
  assert.equal(late, -1, `record ${records[late]} was handed over after record ${records[late - 1]}: what waits goes out in the order it was made`)
  t.diagnostic(`${handed.length} datagrams, at most ${busiest(handed)} within one millisecond`)
})

test('what waits goes out on a timer of one millisecond when nothing arrives, 128 datagrams each time', async (t) => {
  const { local, channel, handed } = await warmed(t, { sendBufferSize: 4 * MiB })
  // from here on nothing reaches the factory, and its timers fire when this test says so
  local.socket.emit = () => {}
  t.mock.timers.enable({ apis: ['setTimeout'] })
  write(channel, 256)
  await Promise.resolve()
  const first = handed.length
  assert.ok(first > 100 && first <= 128, `the write handed the socket ${first} datagrams`)
  for (let turn = 1; turn <= 6; turn++) {
    // the bound reads the real clock, which this lets move on by a millisecond
    for (const over = performance.now() + 1; performance.now() < over; );
    t.mock.timers.tick(1)
    assert.equal(handed.length, first + turn * 128, `${turn} ms after the write`)
  }
})

test('what waits goes out when a datagram arrives, with no timer: timers a page holds back do not hold the socket', async (t) => {
  const { channel, handed } = await warmed(t, { sendBufferSize: 4 * MiB })
  const { setTimeout: timeout } = globalThis
  // a timer that never fires, for as long as this test looks; the factory is closed right after
  globalThis.setTimeout = () => 0
  t.after(() => {
    globalThis.setTimeout = timeout
  })
  write(channel, 256)
  await new Promise((resolve) => timeout(resolve, 100))
  assert.ok(handed.length > 128, `the socket was handed ${handed.length} datagrams and the rest waited for a timer`)
})

test('closing the factory in the middle of a burst tells the peer at once, and hands the socket nothing after', async (t) => {
  const { local, channel, far, handed } = await warmed(t, { sendBufferSize: 4 * MiB })
  const told = once(far, 'close', 2000)
  write(channel, 256)
  await Promise.resolve()
  const spent = handed.length
  assert.ok(spent > 100 && spent <= 128, `the write handed the socket ${spent} datagrams: its burst is not spent`)
  local.webrtc.close()
  const afterClose = handed.length
  assert.ok(afterClose > spent, 'the last words were handed to the socket inside close()')
  await told
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(handed.length, afterClose)
})

test('three connections on one socket each get their own datagrams', async (t) => {
  const { local, links } = await star(t, 3)
  const results = await Promise.all(
    links.map(async ({ channel, far }, i) => {
      const [down, up] = [receive(channel, MiB), receive(far, MiB)]
      const [sentUp, sentDown] = await Promise.all([send(channel, MiB, 4096 + i), send(far, MiB, 8192 + i)])
      return (await up).sha256 === sentUp && (await down).sha256 === sentDown
    }),
  )
  assert.deepEqual(results, [true, true, true])
  assert.equal(local.webrtc.droppedDatagrams, 0)
})

test('a datagram that belongs to no connection is dropped and counted', async (t) => {
  const { local, links, socket } = await star(t, 1)
  const [{ channel, far }] = links
  const { webrtc } = local
  assert.equal(webrtc.droppedDatagrams, 0)

  const stranger = socket('198.51.100.99', 5555)
  const toLocal = (bytes) => stranger.send(bytes, local.socket.port, local.socket.address)
  // a STUN binding request with no user name: no connection's
  const stun = new Uint8Array(20)
  new DataView(stun.buffer).setUint32(0, 0x0001_0000)
  new DataView(stun.buffer).setUint32(4, 0x2112_a442)
  toLocal(stun)
  // what a DTLS record, a uTP packet and noise start with
  toLocal(new Uint8Array([22, 254, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  toLocal(new Uint8Array([0x21, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]))
  toLocal(new Uint8Array(0))
  await Promise.resolve()
  assert.equal(webrtc.droppedDatagrams, 4)
  // a source that is not IPv4 has no connection either
  local.socket.emit('message', stun, { address: '2001:db8::7', port: 5555 })
  assert.equal(webrtc.droppedDatagrams, 5)
  assert.deepEqual(stranger.sent.length, 4)
  assert.equal(local.socket.sent.filter(({ address }) => address === stranger.address).length, 0, 'nothing is answered')

  // the connection that is there has not been disturbed
  const arriving = receive(far, 5)
  channel.send(new Uint8Array([1, 2, 3, 4, 5]))
  assert.equal((await arriving).bytes, 5)
  assert.equal(webrtc.droppedDatagrams, 5)
})

test('a closed connection lets go of its remote address: the next one between the same two sockets connects', { timeout: 10_000 }, async (t) => {
  const { local, links } = await star(t, 1)
  const [{ ours, theirs, remote }] = links
  ours.close()
  theirs.close()
  // what a peer that comes back from the same address and port is
  const [channel, far] = await pair(new local.webrtc.RTCPeerConnection(), new remote.RTCPeerConnection())
  const arriving = once(far, 'message', 3000)
  channel.send('again')
  assert.equal((await arriving).data, 'again')
})

test('a socket error ends every connection: each channel gets error, then close, and the state is failed', async (t) => {
  const { local, links } = await star(t, 2)
  const events = links.map(record)
  local.socket.emit('error', new Error('boom'))
  assert.deepEqual(
    links.map(({ ours }) => ours.connectionState),
    ['failed', 'failed'],
  )
  await Promise.all(links.map(({ ours }) => once(ours, 'connectionstatechange')))
  for (const list of events) {
    assert.deepEqual(list, ['error OperationError: the socket failed: boom', 'close closed', 'failed'])
  }
  for (const event of ['message', 'error', 'close']) assert.equal(local.socket.listenerCount(event), 0)
  assert.throws(() => new local.webrtc.RTCPeerConnection(), { name: 'InvalidStateError' })
  assert.equal(local.socket.sent.splice(0).length > 0, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(local.socket.sent.length, 0, 'nothing more is sent')
})

test('a socket close ends every connection: each channel closes, with no error, and the state is failed', async (t) => {
  const { local, links } = await star(t, 2)
  const events = links.map(record)
  local.socket.emit('close')
  await Promise.all(links.map(({ ours }) => once(ours, 'connectionstatechange')))
  for (const list of events) assert.deepEqual(list, ['close closed', 'failed'])
  for (const event of ['message', 'error', 'close']) assert.equal(local.socket.listenerCount(event), 0)
  assert.throws(() => new local.webrtc.RTCPeerConnection(), { name: 'InvalidStateError' })
})

test('a peer that goes quiet fails the connection once its ICE checks have run out', { timeout: 60_000 }, async (t) => {
  const { local, links } = await star(t, 1)
  const [link] = links
  const events = record(link)
  const started = performance.now()
  // from here on nothing reaches the factory, which is what a peer that is gone looks like
  local.socket.emit = () => {}
  await once(link.ours, 'connectionstatechange', 45_000)
  assert.deepEqual(events, ['error OperationError: the peer stopped answering', 'close closed', 'failed'])
  t.diagnostic(`failed ${((performance.now() - started) / 1000).toFixed(1)} s after the last datagram`)
})

test('closing the factory closes its connections, tells their peers, and lets go of the socket', async (t) => {
  const { local, links } = await star(t, 2)
  const events = links.map(record)
  const told = Promise.all(links.map(({ theirs }) => once(theirs, 'connectionstatechange', 2000)))
  local.webrtc.close()
  assert.deepEqual(
    links.map(({ ours }) => ours.connectionState),
    ['closed', 'closed'],
  )
  await told
  assert.deepEqual(
    links.map(({ theirs, far }) => [theirs.connectionState, far.readyState]),
    [
      ['failed', 'closed'],
      ['failed', 'closed'],
    ],
  )
  for (const list of events) assert.deepEqual(list, ['close closed'])
  for (const event of ['message', 'error', 'close']) assert.equal(local.socket.listenerCount(event), 0)
  local.webrtc.close()
})
