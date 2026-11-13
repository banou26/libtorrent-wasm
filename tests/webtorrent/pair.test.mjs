// Two of our swarms: they find each other through a tracker, each hands the channel to its session, and bytes
// cross both ways over the streams the sessions were given. Then the case that broke one of the designs: both
// offer to each other at the same moment, and exactly one channel must survive at both ends.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { rtcLinks, webtorrentPeers } from '../../build/webtorrent/index.js'
import {
  eventually, fakeRtc, fakeWebSocket, FakeSession, nativeRtc, referenceTracker, TestTracker, writeAll,
} from './fakes.mjs'

const TRACKER = 'wss://tracker.test/'
const HANDLE = 1

const swarm = (t, { RTCPeerConnection, WebSocket, url }) => {
  const session = new FakeSession()
  const peers = webtorrentPeers(session, { links: rtcLinks({ RTCPeerConnection, iceServers: [] }), WebSocket, trackers: [url] })
  t.after(() => peers.close())
  return { session, peers, state: () => peers.snapshot().torrents[0] }
}

/** The session was handed exactly one stream, ever, and it is open. */
const one = side => side.session.streams.length === 1 && side.session.streamsOf(HANDLE).length === 1 && side.state().open === 1

/** Both sessions hold one stream: 512 KiB go each way over them and arrive as sent. */
const exchange = async (a, b) => {
  const [streamA] = a.session.streamsOf(HANDLE)
  const [streamB] = b.session.streamsOf(HANDLE)
  const [fromA, fromB] = [crypto.randomBytes(512 * 1024), crypto.randomBytes(512 * 1024)]
  const [atA, atB] = [streamA.bytes.length, streamB.bytes.length]
  await Promise.all([writeAll(streamA.socket, fromA), writeAll(streamB.socket, fromB)])
  const got = (stream, from) => Buffer.concat(stream.bytes.slice(from))
  await eventually('the bytes crossed', () => got(streamB, atB).length === fromA.length && got(streamA, atA).length === fromB.length)
  assert.equal(Buffer.compare(got(streamB, atB), fromA), 0)
  assert.equal(Buffer.compare(got(streamA, atA), fromB), 0)
}

const meet = async (t, { RTCPeerConnection, WebSocket, url }) => {
  const seed = swarm(t, { RTCPeerConnection, WebSocket, url })
  const leech = swarm(t, { RTCPeerConnection, WebSocket, url })
  seed.session.add(HANDLE, { left: 0 })
  await eventually('the seed is listed', () => seed.state()?.trackers[0].seeders === 1)
  leech.session.add(HANDLE, { left: 1 << 20 })
  await eventually('each has one channel', () => one(seed) && one(leech))
  await exchange(seed, leech)
  assert.deepEqual(leech.state().trackers[0].seeders, 1)
  assert.ok(leech.state().lastPeerAt)
}

const cross = async (t, RTCPeerConnection) => {
  const tracker = new TestTracker()
  const WebSocket = fakeWebSocket({ [TRACKER]: tracker })
  const [a, b] = [swarm(t, { RTCPeerConnection, WebSocket, url: TRACKER }), swarm(t, { RTCPeerConnection, WebSocket, url: TRACKER })]
  // Both are listed before either hears a count, so each is told of the other and each makes an offer.
  tracker.hold()
  a.session.add(HANDLE, { left: 1 << 20 })
  b.session.add(HANDLE, { left: 1 << 20 })
  await eventually('both announced', () => tracker.announces().length === 2)
  tracker.release()
  await eventually('both offered', () => tracker.announces().filter(message => message.offers.length === 1).length === 2)
  await eventually('one channel at each end', () => one(a) && one(b))
  // Long enough for a second channel to have opened, had the losing attempt been left alive at either end.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.ok(one(a) && one(b), 'still exactly one channel at each end')
  // The end with the larger id may still hold its own offer, which the other end chose not to answer: it
  // waits out its 50 s like any offer nobody answered.
  assert.ok(a.state().pending + b.state().pending <= 1, 'and at most one unanswered offer is left waiting')
  await exchange(a, b)
  return { a, b }
}

test('a seed and a download find each other through the tracker and move bytes both ways', async t => {
  const tracker = new TestTracker()
  await meet(t, { RTCPeerConnection: fakeRtc(), WebSocket: fakeWebSocket({ [TRACKER]: tracker }), url: TRACKER })
  assert.equal(tracker.announces().filter(message => message.offers.length).length, 1, 'only the download offered')
})

test('two swarms that offer to each other at the same moment keep exactly one channel, the same one, 25 times over', async t => {
  for (let run = 0; run < 25; run++) {
    const Class = fakeRtc()
    const { a, b } = await cross(t, Class)
    const left = Class.all.filter(pc => !pc.closed).length
    assert.equal(left, 2 + a.state().pending + b.state().pending, 'one connection at each end, and the offer still waiting')
    a.peers.close()
    b.peers.close()
  }
})

test('through the reference tracker on a loopback socket: a seed and a download meet and move bytes', async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  await meet(t, { RTCPeerConnection: fakeRtc(), WebSocket, url: reference.url })
})

test('libdatachannel: the same meeting over real WebRTC, through the reference tracker', { skip: !nativeRtc && 'node-datachannel did not load' }, async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  await meet(t, { RTCPeerConnection: nativeRtc.RTCPeerConnection, WebSocket, url: reference.url })
})

test('libdatachannel: crossing offers over real WebRTC keep exactly one channel', { skip: !nativeRtc && 'node-datachannel did not load' }, async t => {
  for (let run = 0; run < 3; run++) {
    const { a, b } = await cross(t, nativeRtc.RTCPeerConnection)
    a.peers.close()
    b.peers.close()
  }
})
