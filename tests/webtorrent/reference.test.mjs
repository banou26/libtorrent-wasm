// Against the reference implementation, webtorrent's bittorrent-tracker: its server on a loopback socket for
// the tracker client, and its client with libdatachannel as its WebRTC for the swarm. That client is what a
// WebTorrent peer runs, and libdatachannel is what a qBittorrent peer's connection is made of, so a channel
// that opens here in both directions is the interop proof this code has without a public swarm.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test, { after } from 'node:test'

import { rtcLinks, Tracker, webtorrentPeers } from '../../build/webtorrent/index.js'
import { binary, eventually, FakeSession, hashOf, nativeRtc, referenceTracker, releaseNativeRtc } from './fakes.mjs'

after(releaseNativeRtc)

const HASH = hashOf(1)
const PEER_A = '-RP0001-aaaaaaaaaaaa'
const PEER_B = '-RP0001-bbbbbbbbbbbb'

const client = async (t, url) => {
  const tracker = new Tracker(url, WebSocket)
  t.after(() => tracker.close())
  const heard = { replies: [], failures: [], offers: [], answers: [] }
  tracker.onreply = reply => heard.replies.push(reply)
  tracker.onfailure = (infoHash, reason) => heard.failures.push({ infoHash, reason })
  tracker.onoffer = offer => heard.offers.push(offer)
  tracker.onanswer = answer => heard.answers.push(answer)
  await eventually('the socket opened', () => tracker.connected)
  return { tracker, heard }
}

const announce = (peerId, more = {}) => ({ infoHash: binary(HASH), peerId, uploaded: 0, downloaded: 0, left: 100, offers: [], ...more })

test('the reference server lists us, counts us and names its interval', async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  const a = await client(t, reference.url)
  const b = await client(t, reference.url)

  a.tracker.announce(announce(PEER_A, { event: 'started' }))
  await eventually('the first reply', () => a.heard.replies.length === 1)
  assert.deepEqual(a.heard.replies[0], { infoHash: binary(HASH), intervalS: 120, seeders: 0, leechers: 1 })

  b.tracker.announce(announce(PEER_B, { event: 'started', left: 0 }))
  await eventually('the second reply', () => b.heard.replies.length === 1)
  assert.deepEqual(b.heard.replies[0], { infoHash: binary(HASH), intervalS: 120, seeders: 1, leechers: 1 })

  b.tracker.announce(announce(PEER_B, { event: 'stopped', left: 0 }))
  a.tracker.announce(announce(PEER_A))
  await eventually('the count after the stop', () => a.heard.replies.length === 2)
  assert.deepEqual(a.heard.replies[1], { infoHash: binary(HASH), intervalS: 120, seeders: 0, leechers: 1 })
  assert.equal(a.tracker.dropped + b.tracker.dropped, 0)
})

test('the reference server carries our offer to the other peer and its answer back', async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  const a = await client(t, reference.url)
  const b = await client(t, reference.url)
  b.tracker.announce(announce(PEER_B, { event: 'started' }))
  await eventually('b is listed', () => b.heard.replies.length === 1)

  const offerId = 'A1b2C3d4E5f6G7h8I9j0'
  a.tracker.announce(announce(PEER_A, { event: 'started', offers: [{ offerId, sdp: 'v=0 the offer' }] }))
  await eventually('the offer reached b', () => b.heard.offers.length === 1)
  assert.deepEqual(b.heard.offers[0], { infoHash: binary(HASH), peerId: PEER_A, offerId, sdp: 'v=0 the offer' })

  b.tracker.answer({ infoHash: binary(HASH), peerId: PEER_B, toPeerId: PEER_A, offerId, sdp: 'v=0 the answer' })
  await eventually('the answer reached a', () => a.heard.answers.length === 1)
  assert.deepEqual(a.heard.answers[0], { infoHash: binary(HASH), peerId: PEER_B, offerId, sdp: 'v=0 the answer' })
  assert.equal(a.tracker.dropped + b.tracker.dropped, 0)
})

test('one socket carries several torrents, each under its own id, and the reference server keeps them apart', async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  const { tracker, heard } = await client(t, reference.url)
  tracker.announce({ ...announce(PEER_A, { event: 'started' }), infoHash: binary(hashOf(1)) })
  tracker.announce({ ...announce(PEER_B, { event: 'started', left: 0 }), infoHash: binary(hashOf(2)) })
  await eventually('both replies', () => heard.replies.length === 2)
  const byHash = Object.fromEntries(heard.replies.map(reply => [reply.infoHash, reply]))
  assert.deepEqual(byHash[binary(hashOf(1))], { infoHash: binary(hashOf(1)), intervalS: 120, seeders: 0, leechers: 1 })
  assert.deepEqual(byHash[binary(hashOf(2))], { infoHash: binary(hashOf(2)), intervalS: 120, seeders: 1, leechers: 0 })
})

test('the reference server’s refusal is heard as a failure, and the socket stays', async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  const { tracker, heard } = await client(t, reference.url)
  tracker.announce(announce('nineteen-characters', { event: 'started' }))
  await eventually('the refusal', () => heard.failures.length === 1)
  assert.deepEqual(heard.failures, [{ infoHash: null, reason: 'invalid peer_id' }])
  assert.equal(tracker.connected, true)
  tracker.announce(announce(PEER_A, { event: 'started' }))
  await eventually('a good announce still works', () => heard.replies.length === 1)
})

/** The reference client with libdatachannel under it, and every peer it connected. */
const referenceClient = async (t, url) => {
  const { default: Client } = await import('bittorrent-tracker')
  const reference = new Client({
    infoHash: HASH, peerId: Buffer.from('-WW0300-cccccccccccc'), announce: [url], port: 6881,
    wrtc: nativeRtc, rtcConfig: { iceServers: [] },
  })
  const peers = []
  reference.on('error', () => {})
  reference.on('warning', () => {})
  reference.on('peer', peer => {
    const entry = { peer, connected: false, bytes: [] }
    peers.push(entry)
    peer.on('connect', () => { entry.connected = true })
    peer.on('data', bytes => entry.bytes.push(Buffer.from(bytes)))
    peer.on('error', () => {})
  })
  t.after(() => new Promise(resolve => reference.destroy(resolve)))
  return { reference, peers, connected: () => peers.filter(entry => entry.connected) }
}

const ours = (t, url, view) => {
  const session = new FakeSession()
  const peers = webtorrentPeers(session, {
    links: rtcLinks({ RTCPeerConnection: nativeRtc.RTCPeerConnection, iceServers: [] }), WebSocket, trackers: [url],
  })
  t.after(() => peers.close())
  session.add(1, view)
  return { session, peers }
}

/** A megabyte each way between the stream our session was handed and the reference client's peer. */
const exchange = async (stream, entry) => {
  const [toThem, toUs] = [crypto.randomBytes(1 << 20), crypto.randomBytes(1 << 20)]
  stream.socket.write(toThem)
  for (let at = 0; at < toUs.length; at += 16384) entry.peer.write(toUs.subarray(at, at + 16384))
  const size = chunks => chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  await eventually('the megabytes crossed', () => size(entry.bytes) === toThem.length && size(stream.bytes) === toUs.length)
  assert.equal(Buffer.compare(Buffer.concat(entry.bytes), toThem), 0)
  assert.equal(Buffer.compare(Buffer.concat(stream.bytes), toUs), 0)
}

test('the reference client offers to us: our seeding torrent answers, the channel opens and carries bytes both ways', { skip: !nativeRtc && 'node-datachannel did not load' }, async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  const us = ours(t, reference.url, { left: 0 })
  await eventually('we are listed', () => us.peers.snapshot().torrents[0]?.trackers[0].seeders === 1)

  const them = await referenceClient(t, reference.url)
  const started = Date.now()
  them.reference.start()
  await eventually('the channel opened at both ends', () => us.session.streamsOf(1).length === 1 && them.connected().length === 1)
  console.log(`# the reference client's offer to an open channel at both ends: ${Date.now() - started} ms`)
  assert.equal(us.peers.snapshot().torrents[0].open, 1)
  await exchange(us.session.streams[0], them.connected()[0])
})

test('the reference client answers our offer: our download offers by the count, the channel opens and carries bytes both ways', { skip: !nativeRtc && 'node-datachannel did not load' }, async t => {
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  const them = await referenceClient(t, reference.url)
  let listed = false
  them.reference.once('update', () => { listed = true })
  // Listed without an offer of its own, so the only way to it is ours.
  them.reference.start({ numwant: 0 })
  await eventually('the reference client is listed', () => listed)

  const started = Date.now()
  const us = ours(t, reference.url, { left: 1 << 20 })
  await eventually('the channel opened at both ends', () => us.session.streamsOf(1).length === 1 && them.connected().length === 1)
  console.log(`# our offer to an open channel at both ends: ${Date.now() - started} ms`)
  await exchange(us.session.streams[0], them.connected()[0])
})
