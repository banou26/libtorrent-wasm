// The tracker client against a tracker written here: what it puts on the wire, what it reports, what it
// refuses to act on, and when it comes back after a loss. The same client against the reference server is in
// reference.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { Tracker } from '../../build/webtorrent/index.js'
import { binary, fakeWebSocket, HASH, TestTracker, turn } from './fakes.mjs'

const URL_A = 'wss://tracker.test/'
const PEER = '-RP0001-aaaaaaaaaaaa'
const OTHER = '-XX0001-bbbbbbbbbbbb'
const numbers = { uploaded: 1, downloaded: 2, left: 3 }

const connect = async () => {
  const server = new TestTracker()
  const WebSocket = fakeWebSocket({ [URL_A]: server })
  const tracker = new Tracker(URL_A, WebSocket)
  const heard = { replies: [], failures: [], offers: [], answers: [], opens: 0, closes: 0 }
  tracker.onopen = () => heard.opens++
  tracker.onclose = () => heard.closes++
  tracker.onreply = reply => heard.replies.push(reply)
  tracker.onfailure = (infoHash, reason) => heard.failures.push({ infoHash, reason })
  tracker.onoffer = offer => heard.offers.push(offer)
  tracker.onanswer = answer => heard.answers.push(answer)
  await turn()
  return { server, tracker, heard, WebSocket, socket: () => [...server.sockets][0] }
}

const announced = async (rig, event = 'started') => {
  assert.equal(rig.tracker.announce({ infoHash: binary(HASH), peerId: PEER, ...numbers, event, offers: [] }), true)
  await turn()
}

test('an announce without offers is the reference shape, and one with offers counts them', async () => {
  const rig = await connect()
  await announced(rig)
  assert.deepEqual(rig.server.received[0], {
    action: 'announce', info_hash: binary(HASH), peer_id: PEER, uploaded: 1, downloaded: 2, left: 3,
    numwant: 0, event: 'started', offers: [],
  })

  rig.tracker.announce({
    infoHash: binary(HASH), peerId: PEER, ...numbers,
    offers: [{ offerId: 'A'.repeat(20), sdp: 'one' }, { offerId: 'B'.repeat(20), sdp: 'two' }],
  })
  await turn()
  const second = rig.server.received[1]
  assert.equal(second.numwant, 2)
  assert.equal('event' in second, false)
  assert.deepEqual(second.offers, [
    { offer_id: 'A'.repeat(20), offer: { type: 'offer', sdp: 'one' } },
    { offer_id: 'B'.repeat(20), offer: { type: 'offer', sdp: 'two' } },
  ])
  rig.tracker.close()
})

test('a number that is not a count goes out as zero', async () => {
  const rig = await connect()
  rig.tracker.announce({ infoHash: binary(HASH), peerId: PEER, uploaded: NaN, downloaded: -4, left: Infinity, offers: [] })
  await turn()
  const { uploaded, downloaded, left } = rig.server.received[0]
  assert.deepEqual({ uploaded, downloaded, left }, { uploaded: 0, downloaded: 0, left: 0 })
  rig.tracker.close()
})

test('the reply carries the counts, and the interval is kept between 60 and 600 seconds', async () => {
  const rig = await connect()
  for (const [sent, kept] of [[5, 60], [120, 120], [86_400, 600]]) {
    rig.server.interval = sent
    await announced(rig)
    assert.deepEqual(rig.heard.replies.pop(), { infoHash: binary(HASH), intervalS: kept, seeders: 0, leechers: 1 })
  }
  rig.tracker.close()
})

test('a reply that leaves the interval and the counts out is a reply with nothing known', async () => {
  const rig = await connect()
  rig.server.silent = true
  await announced(rig)
  rig.socket().deliver({ action: 'announce', info_hash: binary(HASH) })
  await turn()
  assert.deepEqual(rig.heard.replies, [{ infoHash: binary(HASH), intervalS: null, seeders: null, leechers: null }])
  assert.equal(rig.tracker.dropped, 0)
  rig.tracker.close()
})

test('a failure reason is reported, with the torrent when the tracker names it, and the socket stays', async () => {
  const rig = await connect()
  await announced(rig)
  rig.socket().deliver({ action: 'announce', info_hash: binary(HASH), 'failure reason': 'torrent not allowed' })
  rig.socket().deliver({ 'failure reason': 'invalid peer_id' })
  rig.socket().deliver({ 'failure reason': 'x'.repeat(5000) })
  await turn()
  assert.deepEqual(rig.heard.failures.slice(0, 2), [
    { infoHash: binary(HASH), reason: 'torrent not allowed' },
    { infoHash: null, reason: 'invalid peer_id' },
  ])
  assert.equal(rig.heard.failures[2].reason.length, 200)
  assert.equal(rig.tracker.connected, true)
  assert.equal(rig.tracker.dropped, 0)
  rig.tracker.close()
})

test('an offer and an answer another peer sent arrive, and our answer names that peer', async () => {
  const rig = await connect()
  await announced(rig)
  const relay = { action: 'announce', info_hash: binary(HASH), peer_id: OTHER, offer_id: 'C'.repeat(20) }
  rig.socket().deliver({ ...relay, offer: { type: 'offer', sdp: 'theirs' } })
  rig.socket().deliver({ ...relay, answer: { type: 'answer', sdp: 'reply' } })
  await turn()
  const expected = { infoHash: binary(HASH), peerId: OTHER, offerId: 'C'.repeat(20) }
  assert.deepEqual(rig.heard.offers, [{ ...expected, sdp: 'theirs' }])
  assert.deepEqual(rig.heard.answers, [{ ...expected, sdp: 'reply' }])

  rig.tracker.answer({ infoHash: binary(HASH), peerId: PEER, toPeerId: OTHER, offerId: 'C'.repeat(20), sdp: 'mine' })
  await turn()
  assert.deepEqual(rig.server.received.at(-1), {
    action: 'announce', info_hash: binary(HASH), peer_id: PEER, to_peer_id: OTHER,
    offer_id: 'C'.repeat(20), answer: { type: 'answer', sdp: 'mine' },
  })
  rig.tracker.close()
})

const relayed = { action: 'announce', info_hash: binary(HASH), peer_id: OTHER, offer_id: 'C'.repeat(20) }
const offered = { ...relayed, offer: { type: 'offer', sdp: 'v=0' } }

const MALFORMED = {
  'text that is not JSON': '{"action":',
  'a JSON array': '[]',
  'a JSON null': 'null',
  'a JSON number': '7',
  // As node hands one over: bytes that would read as a good message if they were taken for text.
  'a binary frame': Buffer.from(JSON.stringify(offered)),
  'a frame over 128 KiB': JSON.stringify({ ...offered, padding: 'x'.repeat(128 * 1024) }),
  'another action': { ...relayed, action: 'scrape' },
  'no action': { info_hash: binary(HASH), interval: 120 },
  'an info hash of 19 characters': { ...offered, info_hash: binary(HASH).slice(1) },
  'an info hash that is a number': { ...offered, info_hash: 7 },
  'a torrent that was never announced here': { ...offered, info_hash: binary('ff'.repeat(20)) },
  'an interval that is text': { action: 'announce', info_hash: binary(HASH), interval: '120', complete: 1, incomplete: 1 },
  'an interval below zero': { action: 'announce', info_hash: binary(HASH), interval: -1 },
  'a count that is not finite': `{"action":"announce","info_hash":${JSON.stringify(binary(HASH))},"complete":1e999}`,
  'a count that is text': { action: 'announce', info_hash: binary(HASH), incomplete: 'many' },
  'an offer that is null': { ...relayed, offer: null },
  'an offer that is text': { ...relayed, offer: 'v=0' },
  'a description with no sdp': { ...relayed, offer: { type: 'offer' } },
  'an sdp over 64 KiB': { ...relayed, offer: { type: 'offer', sdp: 'x'.repeat(64 * 1024 + 1) } },
  'a peer id of 19 characters': { ...offered, peer_id: OTHER.slice(1) },
  'no peer id': { ...offered, peer_id: undefined },
  'an empty offer id': { ...offered, offer_id: '' },
  'an offer id of 65 characters': { ...offered, offer_id: 'x'.repeat(65) },
  'an offer id that is a number': { ...offered, offer_id: 7 },
  'an offer and an answer at once': { ...offered, answer: { type: 'answer', sdp: 'v=0' } },
  'a failure reason that is not text': { 'failure reason': 7 },
  'a failure reason for a torrent never announced here': { 'failure reason': 'no', info_hash: binary('ff'.repeat(20)) },
}

for (const [kind, frame] of Object.entries(MALFORMED)) {
  test(`${kind} is dropped and counted, and the socket stays open`, async () => {
    const rig = await connect()
    await announced(rig)
    const before = { ...rig.heard, replies: rig.heard.replies.length }
    rig.socket().deliver(frame)
    await turn()
    assert.equal(rig.tracker.dropped, 1)
    assert.equal(rig.tracker.connected, true)
    assert.deepEqual({ ...rig.heard, replies: rig.heard.replies.length }, before)

    rig.socket().deliver(offered)
    await turn()
    assert.equal(rig.heard.offers.length, 1, 'the next good message is still heard')
    assert.equal(rig.tracker.dropped, 1)
    rig.tracker.close()
  })
}

test('an offer id of any length up to 64 from another client is passed on, since it is theirs to recognise', async () => {
  const rig = await connect()
  await announced(rig)
  rig.socket().deliver({ ...offered, offer_id: 'short' })
  await turn()
  assert.equal(rig.heard.offers[0].offerId, 'short')
  rig.tracker.close()
})

test('after stopped the torrent is not listened for: the reply to the stop is expected, anything after it is counted', async () => {
  const rig = await connect()
  await announced(rig)
  const replies = rig.heard.replies.length
  await announced(rig, 'stopped')
  assert.equal(rig.heard.replies.length, replies, 'the reply to stopped is not reported')
  assert.equal(rig.tracker.dropped, 0, 'and it is not an odd message either')
  rig.socket().deliver(offered)
  await turn()
  assert.equal(rig.heard.offers.length, 0)
  assert.equal(rig.tracker.dropped, 1)
  rig.tracker.close()
})

test('nothing is sent while the socket is not open, and the caller is told', async () => {
  const server = new TestTracker()
  const tracker = new Tracker(URL_A, fakeWebSocket({ [URL_A]: server }))
  assert.equal(tracker.connected, false)
  assert.equal(tracker.announce({ infoHash: binary(HASH), peerId: PEER, ...numbers, offers: [] }), false)
  assert.equal(tracker.answer({ infoHash: binary(HASH), peerId: PEER, toPeerId: OTHER, offerId: 'x', sdp: 'x' }), false)
  await turn()
  assert.equal(server.received.length, 0)

  // A closing socket takes a send without a word and drops it, so only the state can tell.
  const [socket] = server.sockets
  socket.readyState = 2
  assert.equal(tracker.announce({ infoHash: binary(HASH), peerId: PEER, ...numbers, offers: [] }), false)
  tracker.close()
})

test('a lost socket is opened again after 10 s, doubling to 10 min, and 10 s again once the tracker talks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(Math, 'random', () => 0)
  const rig = await connect()
  const opens = () => rig.WebSocket.opened.length
  assert.equal(opens(), 1)
  await announced(rig)

  const waits = [10, 20, 40, 80, 160, 320, 600, 600]
  rig.server.refusing = true
  rig.server.drop()
  await turn()
  for (const [i, seconds] of waits.entries()) {
    t.mock.timers.tick(seconds * 1000 - 1)
    await turn()
    assert.equal(opens(), i + 1, `not before ${seconds} s`)
    t.mock.timers.tick(1)
    await turn()
    assert.equal(opens(), i + 2, `at ${seconds} s`)
  }

  rig.server.refusing = false
  t.mock.timers.tick(600_000)
  await turn()
  assert.equal(rig.tracker.connected, true)
  assert.equal(rig.heard.opens, 2)
  rig.socket().deliver(offered)
  await turn()
  assert.equal(rig.heard.offers.length, 0, 'the new connection has heard of no torrent yet')
  await announced(rig)
  rig.server.drop()
  await turn()
  const before = opens()
  t.mock.timers.tick(10_000)
  await turn()
  assert.equal(opens(), before + 1, 'a tracker that answered is retried after the first wait again')
  rig.tracker.close()
})

test('the wait before a reconnect carries up to a quarter of jitter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(Math, 'random', () => 0.999)
  const rig = await connect()
  rig.server.refusing = true
  rig.server.drop()
  await turn()
  t.mock.timers.tick(12_400)
  await turn()
  assert.equal(rig.WebSocket.opened.length, 1)
  t.mock.timers.tick(100)
  await turn()
  assert.equal(rig.WebSocket.opened.length, 2)
  rig.tracker.close()
})

test('close ends the socket for good: no reconnect and no more events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rig = await connect()
  rig.tracker.close()
  await turn()
  t.mock.timers.tick(3_600_000)
  await turn()
  assert.equal(rig.WebSocket.opened.length, 1)
  assert.equal(rig.heard.closes, 0)
  assert.equal(rig.server.sockets.size, 0)

  const waiting = await connect()
  waiting.server.drop()
  await turn()
  waiting.tracker.close()
  t.mock.timers.tick(3_600_000)
  await turn()
  assert.equal(waiting.WebSocket.opened.length, 1, 'closed while it waited to reconnect, it does not')
})

test('a URL the platform refuses to open is never asked again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const tracker = new Tracker('ws://tracker.test/', class { constructor() { attempts++; throw new Error('SecurityError') } })
  t.mock.timers.tick(3_600_000)
  await turn()
  assert.equal(attempts, 1)
  assert.equal(tracker.connected, false)
  tracker.close()
})
