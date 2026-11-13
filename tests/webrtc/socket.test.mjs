// The one socket of a factory: which connection a datagram goes to, what is dropped, and what
// its error and its close do. In-memory sockets, each remote on an address of its own.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebRTC, MiB, once, pair, receive, send, wasm } from './rig/local.mjs'
import { network } from './rig/memory-network.mjs'

/** One factory, and `remotes` more with a connection each, joined to a connection of the first. */
async function star(t, remotes) {
  const { socket } = network()
  const make = async (address, port) => {
    const made = socket(address, port)
    const webrtc = await createWebRTC({ socket: made, address, port, wasm, allowPrivateCandidates: true })
    t.after(webrtc.close)
    return { webrtc, socket: made }
  }
  const local = await make('203.0.113.1', 40000)
  const links = []
  for (let i = 0; i < remotes; i++) {
    const remote = await make('198.51.100.2', 41000 + i)
    const ours = new local.webrtc.RTCPeerConnection()
    const theirs = new remote.webrtc.RTCPeerConnection()
    const [channel, far] = await pair(ours, theirs, `link ${i}`)
    links.push({ ours, theirs, channel, far })
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
