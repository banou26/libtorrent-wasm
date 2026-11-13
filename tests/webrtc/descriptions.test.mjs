// Descriptions, gathering and the candidate filter, on in-memory sockets: nothing here needs a
// peer that answers. What a rejection is named follows Chrome 156, measured for this module:
// text that is not SDP is OperationError, a description Chrome parses and then refuses (no
// fingerprint) is InvalidAccessError, one out of order is InvalidStateError, a type that is not
// one is TypeError, and a local description the connection did not make is InvalidModificationError.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebRTC, gathered, once, wasm } from './rig/local.mjs'
import { network } from './rig/memory-network.mjs'
import { traced } from './rig/trace.mjs'

const LOCAL = ['203.0.113.1', 40001]
const REMOTE = ['198.51.100.2', 40002]

async function factory(options = {}, at = LOCAL) {
  const socket = network().socket(...at)
  const webrtc = await createWebRTC({ socket, address: socket.address, port: socket.port, wasm, ...options })
  return { ...webrtc, socket, close: webrtc.close }
}

/** A complete offer from a connection of another factory, which nothing will ever reach. */
async function remoteOffer() {
  const remote = await factory({}, REMOTE)
  const pc = new remote.RTCPeerConnection()
  pc.createDataChannel('remote')
  await pc.setLocalDescription()
  const offer = await gathered(pc)
  remote.close()
  return offer
}

const withCandidate = ({ type, sdp }, candidate) => ({ type, sdp: sdp.replace(/a=candidate:.*/, `a=candidate:${candidate}`) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the description carries the one host candidate from the start, then gathering reports it and null', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.example.org:3478' }] })
  assert.equal(pc.localDescription, null)
  assert.equal(pc.sctp, null)
  assert.equal(pc.iceGatheringState, 'new')
  assert.equal(pc.connectionState, 'new')

  const events = []
  pc.onicegatheringstatechange = () => events.push(pc.iceGatheringState)
  pc.addEventListener('icecandidate', ({ candidate }) => events.push(candidate))
  pc.createDataChannel('x')
  const offer = await pc.createOffer()
  assert.equal(offer.type, 'offer')
  await pc.setLocalDescription(offer)
  assert.deepEqual(pc.localDescription, offer)
  assert.deepEqual(await pc.createOffer(), offer, 'the offer does not change while it waits for its answer')

  // as the platform: nothing of gathering has happened when setLocalDescription resolves
  assert.equal(pc.iceGatheringState, 'new')
  assert.deepEqual(events, [])
  const candidates = offer.sdp.split('\r\n').filter((line) => line.startsWith('a=candidate:'))
  assert.equal(candidates.length, 1, 'iceServers is ignored: the one candidate is the pair the factory was given')
  assert.match(candidates[0], /^a=candidate:\S+ 1 udp \d+ 203\.0\.113\.1 40001 typ host/)
  assert.match(offer.sdp, /^a=max-message-size:262144\r$/m)
  assert.match(offer.sdp, /^m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel\r$/m)
  assert.equal(offer.sdp.match(/^m=/gm).length, 1, 'no media')

  assert.deepEqual(await gathered(pc), offer)
  assert.equal(events.length, 4)
  assert.equal(events[0], 'gathering')
  assert.equal(`a=${events[1].candidate}`, candidates[0])
  assert.equal(events[1].sdpMLineIndex, 0)
  assert.equal(`a=mid:${events[1].sdpMid}`, offer.sdp.match(/^a=mid:.*/m)[0])
  assert.deepEqual(events.slice(2), ['complete', null])
  assert.equal(pc.sctp.maxMessageSize, 262144)
  assert.equal(local.socket.sent.length, 0, 'no STUN server is asked and no peer is known yet')
})

test('an on handler is a listener, in the place its first one was set', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection()
  assert.equal(pc.onicegatheringstatechange, null)
  const seen = []
  const replaced = () => seen.push('the handler that was replaced')
  const handler = function (event) {
    seen.push(`handler: ${pc.iceGatheringState}, this is the connection: ${this === pc}, type ${event.type}`)
  }
  pc.addEventListener('icegatheringstatechange', (event) => {
    seen.push(`first listener: ${pc.iceGatheringState}`)
    if (pc.iceGatheringState === 'complete') event.stopImmediatePropagation()
  })
  pc.onicegatheringstatechange = replaced
  pc.addEventListener('icegatheringstatechange', () => seen.push(`second listener: ${pc.iceGatheringState}`))
  pc.onicegatheringstatechange = handler
  assert.equal(pc.onicegatheringstatechange, handler)

  pc.createDataChannel('x')
  // the null candidate is the last event of gathering
  const complete = new Promise((resolve) => pc.addEventListener('icecandidate', ({ candidate }) => candidate || resolve()))
  await pc.setLocalDescription()
  await complete
  assert.deepEqual(seen, [
    'first listener: gathering',
    'handler: gathering, this is the connection: true, type icegatheringstatechange',
    'second listener: gathering',
    // stopped by the first listener, as any listener after it is
    'first listener: complete',
  ])

  pc.onicegatheringstatechange = 'not a function'
  assert.equal(pc.onicegatheringstatechange, null)
  const channel = pc.createDataChannel('y')
  let closes = 0
  channel.onclose = () => closes++
  channel.onclose = null
  assert.equal(channel.onclose, null)
  const closed = new Promise((resolve) => channel.addEventListener('close', resolve))
  pc.close()
  await closed
  assert.equal(closes, 0, 'a handler set to null is not called')
})

test('an offer needs a data channel, and a channel is ordered and reliable or refused', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection()
  await assert.rejects(pc.createOffer(), { name: 'InvalidStateError' })
  await assert.rejects(pc.setLocalDescription(), { name: 'InvalidStateError' })
  for (const init of [{ ordered: false }, { maxRetransmits: 0 }, { maxPacketLifeTime: 100 }, { negotiated: true, id: 1 }, { id: 3 }, { protocol: 'p' }]) {
    assert.throws(() => pc.createDataChannel('x', init), { name: 'NotSupportedError' }, JSON.stringify(init))
  }
  const channel = pc.createDataChannel('fine', { ordered: true, protocol: '' })
  assert.equal(channel.label, 'fine')
  assert.equal(channel.readyState, 'connecting')
  assert.equal((await pc.createOffer()).type, 'offer')
})

test('a channel closed before the stack was given it closes, with its event', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection()
  pc.createDataChannel('the one in the offer')
  // waits for an answer, and so for an association to be opened on
  const waiting = pc.createDataChannel('waiting')
  const closed = once(waiting, 'close', 3000)
  waiting.close()
  assert.equal(waiting.readyState, 'closing')
  await closed
  assert.equal(waiting.readyState, 'closed')
  assert.equal((await pc.createOffer()).type, 'offer')
})

test('text that is not SDP rejects with OperationError and leaves the connection as it was', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection()
  for (const sdp of ['garbage', '', undefined]) {
    await assert.rejects(pc.setRemoteDescription({ type: 'offer', sdp }), { name: 'OperationError' }, String(sdp))
  }
  assert.equal(pc.remoteDescription, null)
  assert.equal(pc.connectionState, 'new')

  const offer = await remoteOffer()
  await pc.setRemoteDescription(offer)
  assert.deepEqual(pc.remoteDescription, offer)
  const answer = await pc.createAnswer()
  assert.equal(answer.type, 'answer')
  assert.match(answer.sdp, /^a=setup:(active|passive)\r$/m)
  await pc.setLocalDescription(answer)
  assert.deepEqual(pc.localDescription, answer)
  assert.equal(pc.connectionState, 'connecting')
})

test('a description the stack refuses rejects with InvalidAccessError and ends the connection', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection()
  const channel = pc.createDataChannel('never')
  const states = []
  pc.onconnectionstatechange = () => states.push(pc.connectionState)
  const closed = new Promise((resolve) => (channel.onclose = resolve))
  const { type, sdp } = await remoteOffer()
  await assert.rejects(pc.setRemoteDescription({ type, sdp: sdp.replace(/a=fingerprint:.*\r\n/, '') }), {
    name: 'InvalidAccessError',
  })
  await closed
  assert.deepEqual(states, ['failed'])
  assert.equal(channel.readyState, 'closed')
  await assert.rejects(pc.setRemoteDescription({ type, sdp }), { name: 'InvalidStateError' })
})

test('descriptions out of order reject with InvalidStateError, and a type that is none with TypeError', async (t) => {
  const local = await factory()
  t.after(local.close)
  const offer = await remoteOffer()
  const answer = { type: 'answer', sdp: offer.sdp }

  const fresh = new local.RTCPeerConnection()
  await assert.rejects(fresh.setRemoteDescription(answer), { name: 'InvalidStateError' }, 'an answer to no offer')
  await assert.rejects(fresh.createAnswer(), { name: 'InvalidStateError' }, 'an answer to no offer')
  await assert.rejects(fresh.setLocalDescription({ type: 'answer' }), { name: 'InvalidStateError' })
  await assert.rejects(fresh.setRemoteDescription({ type: 'nope', sdp: offer.sdp }), TypeError)
  await assert.rejects(fresh.setRemoteDescription(), TypeError)
  for (const type of ['pranswer', 'rollback']) {
    await assert.rejects(fresh.setRemoteDescription({ type, sdp: offer.sdp }), { name: 'NotSupportedError' })
    await assert.rejects(fresh.setLocalDescription({ type }), { name: 'NotSupportedError' })
  }

  const offering = new local.RTCPeerConnection()
  offering.createDataChannel('x')
  const made = await offering.createOffer()
  await assert.rejects(offering.setRemoteDescription(answer), { name: 'InvalidStateError' }, 'the offer is not set yet')
  await assert.rejects(
    offering.setLocalDescription({ type: 'offer', sdp: made.sdp.replace(/a=ice-pwd:.*/, 'a=ice-pwd:0000000000000000000000') }),
    { name: 'InvalidModificationError' },
  )
  await offering.setLocalDescription(made)
  await assert.rejects(offering.setLocalDescription(made), { name: 'InvalidStateError' }, 'set twice')
  await assert.rejects(offering.setRemoteDescription(offer), { name: 'InvalidStateError' }, 'an offer to an offer')

  const answering = new local.RTCPeerConnection()
  await answering.setRemoteDescription(offer)
  await assert.rejects(answering.createOffer(), { name: 'InvalidStateError' })
  await assert.rejects(answering.setRemoteDescription(offer), { name: 'InvalidStateError' }, 'set twice')
  await answering.setLocalDescription()
  assert.equal(answering.localDescription.type, 'answer')
  await assert.rejects(answering.createAnswer(), { name: 'InvalidStateError' }, 'already answered')
})

test('sctp.maxMessageSize is what the remote description allows, capped at what this module sends', async (t) => {
  const local = await factory()
  t.after(local.close)
  const offer = await remoteOffer()
  const allowing = async (line) => {
    const pc = new local.RTCPeerConnection()
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp.replace(/a=max-message-size:.*\r\n/, line) })
    return pc.sctp.maxMessageSize
  }
  assert.equal(await allowing('a=max-message-size:262144\r\n'), 262144)
  assert.equal(await allowing('a=max-message-size:100000\r\n'), 100000)
  assert.equal(await allowing(''), 65536, 'no attribute means 65536')
  assert.equal(await allowing('a=max-message-size:0\r\n'), 262144, '0 means any size')
  assert.equal(await allowing('a=max-message-size:1073741823\r\n'), 262144)
})

test('a closed connection refuses everything with InvalidStateError', async (t) => {
  const local = await factory()
  t.after(local.close)
  const pc = new local.RTCPeerConnection()
  const channel = pc.createDataChannel('x')
  await pc.setLocalDescription()
  const closed = new Promise((resolve) => (channel.onclose = resolve))
  pc.close()
  assert.equal(pc.connectionState, 'closed')
  await closed
  assert.equal(channel.readyState, 'closed')
  assert.throws(() => pc.createDataChannel('y'), { name: 'InvalidStateError' })
  await assert.rejects(pc.createOffer(), { name: 'InvalidStateError' })
  await assert.rejects(pc.createAnswer(), { name: 'InvalidStateError' })
  await assert.rejects(pc.setLocalDescription(), { name: 'InvalidStateError' })
  await assert.rejects(pc.setRemoteDescription(await remoteOffer()), { name: 'InvalidStateError' })
  pc.close()
  // no gathering event after the close
  await sleep(20)
  assert.equal(pc.iceGatheringState, 'new')

  // nor after a close made by the handler of the first one
  const other = new local.RTCPeerConnection()
  other.createDataChannel('x')
  const events = []
  other.onicegatheringstatechange = () => {
    events.push(other.iceGatheringState)
    other.close()
  }
  other.onicecandidate = () => events.push('icecandidate')
  await other.setLocalDescription()
  await sleep(20)
  assert.deepEqual(events, ['gathering'])

  local.close()
  assert.throws(() => new local.RTCPeerConnection(), { name: 'InvalidStateError' })
})

// The relay refuses a datagram to any of these and writes a log line for each one, and an ICE
// agent sends checks several times a second, so none may reach str0m.
const REFUSED = {
  private: '1 1 udp 2130706431 10.1.2.3 5000 typ host',
  'private, 172.16/12': '1 1 udp 2130706431 172.31.255.1 5000 typ host',
  'private, 192.168/16': '1 1 udp 2130706431 192.168.1.20 5000 typ host',
  loopback: '1 1 udp 2130706431 127.0.0.1 5000 typ host',
  'link-local': '1 1 udp 2130706431 169.254.10.10 5000 typ host',
  'shared range': '1 1 udp 2130706431 100.64.0.1 5000 typ host',
  'shared range, top': '1 1 udp 2130706431 100.127.255.254 5000 typ host',
  'IETF protocol': '1 1 udp 2130706431 192.0.0.9 5000 typ host',
  'documentation, 192.0.2/24': '1 1 udp 2130706431 192.0.2.1 5000 typ host',
  'documentation, 198.51.100/24': '1 1 udp 2130706431 198.51.100.77 5000 typ host',
  'documentation, 203.0.113/24': '1 1 udp 2130706431 203.0.113.9 5000 typ host',
  benchmark: '1 1 udp 2130706431 198.18.0.1 5000 typ host',
  'benchmark, top': '1 1 udp 2130706431 198.19.255.254 5000 typ host',
  reserved: '1 1 udp 2130706431 240.0.0.1 5000 typ host',
  'a .local name': '1 1 udp 2113937151 4a8d2c5e-1b7f-4c0a-9a53-0e2f6d3b1c77.local 5000 typ host',
  IPv6: '1 1 udp 2130706431 2001:db8::1 5000 typ host',
  'IPv6 link-local': '1 1 udp 2130706431 fe80::1 5000 typ host',
  // a public address, so it reaches the stack, which never pairs it with our UDP candidate
  TCP: '1 1 tcp 1518280447 11.0.0.2 9 typ host tcptype active',
  multicast: '1 1 udp 2130706431 224.0.0.251 5000 typ host',
  'this network': '1 1 udp 2130706431 0.0.0.0 5000 typ host',
}
// just outside each refused range
const KEPT = `1.0.0.1 9.255.255.1 11.0.0.1 100.63.255.255 100.128.0.1 126.0.0.1 128.0.0.1 169.253.1.1 169.255.1.1
  172.15.0.1 172.32.0.1 191.255.255.1 192.0.1.1 192.0.3.1 192.167.1.1 192.169.1.1 198.17.255.1 198.20.0.1
  198.51.99.1 198.51.101.1 203.0.112.1 203.0.114.1 223.255.255.1`.split(/\s+/)

/**
 * Answers `offer` once per candidate, each on a connection of its own, waits long enough for
 * every ICE agent to have sent its first checks, and answers the addresses datagrams went to.
 */
async function destinations(local, offer, candidates) {
  const connections = []
  for (const candidate of candidates) {
    const pc = new local.RTCPeerConnection()
    await pc.setRemoteDescription(withCandidate(offer, candidate))
    await pc.setLocalDescription()
    connections.push(pc)
  }
  await sleep(600)
  for (const pc of connections) pc.close()
  return new Set(local.socket.sent.splice(0).map((datagram) => `${datagram.address}:${datagram.port}`))
}

test('a remote candidate a relay would refuse never produces a datagram', async (t) => {
  const local = await factory()
  t.after(local.close)
  const offer = await remoteOffer()
  const kept = KEPT.map((address) => `1 1 udp 2130706431 ${address} 5000 typ host`)

  // the control comes from the same run: every candidate that passes has been sent a check
  const reached = await destinations(local, offer, [...kept, ...Object.values(REFUSED)])
  assert.deepEqual([...reached].sort(), KEPT.map((address) => `${address}:5000`).sort())
})

test('a candidate that is dropped never reaches the stack, whatever the stack would do with it', async (t) => {
  const { calls, result: local } = await traced(() => factory())
  t.after(local.close)
  const { type, sdp } = await remoteOffer()
  const kept = `a=candidate:1 1 udp 2130706431 ${KEPT[0]} 5000 typ host`
  const tcp = `a=candidate:${REFUSED.TCP}`
  const dropped = Object.values(REFUSED).filter((candidate) => candidate !== REFUSED.TCP).map((candidate) => `a=candidate:${candidate}`)
  const candidates = [kept, ...dropped, tcp].join('\r\n')
  await new local.RTCPeerConnection().setRemoteDescription({ type, sdp: sdp.replace(/a=candidate:.*/, candidates) })
  const given = calls.find(({ name }) => name === 'rtc_accept_offer').sdp
  assert.deepEqual(given.match(/^a=candidate:.*$/gm), [kept, tcp])
})

test('allowPrivateCandidates keeps them, for a socket that does reach such addresses', async (t) => {
  const local = await factory({ allowPrivateCandidates: true })
  t.after(local.close)
  const offer = await remoteOffer()
  const reached = await destinations(local, offer, [REFUSED.private, REFUSED.loopback, REFUSED['shared range']])
  assert.deepEqual([...reached].sort(), ['10.1.2.3:5000', '100.64.0.1:5000', '127.0.0.1:5000'])
})

test('the factory refuses an address or a send buffer it cannot work with', async () => {
  const socket = network().socket(...LOCAL)
  const make = (options) => createWebRTC({ socket, address: LOCAL[0], port: LOCAL[1], wasm, ...options })
  // 0.0.0.0 is an IPv4 address, and one the stack refuses as a candidate
  for (const options of [{ address: '2001:db8::1' }, { address: 'relay.example' }, { address: '203.0.113' }, { address: '0.0.0.0' }, { port: 0 }, { port: 65536 }, { port: 1.5 }]) {
    await assert.rejects(make(options), TypeError, JSON.stringify(options))
  }
  await assert.rejects(make({ sendBufferSize: 262143 }), RangeError)
  await assert.rejects(make({ wasm: new Uint8Array(8) }), WebAssembly.CompileError)
  assert.equal(socket.listenerCount('message'), 0, 'a refused factory leaves nothing on the socket')
  ;(await make({ sendBufferSize: 262144 })).close()
})
