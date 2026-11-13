// The swarm's rules, one case each, against a tracker written for the tests, an in-memory connection class
// and a fake session, under mocked time. Remote peers are scripted: they offer and answer through the tracker
// as another client would.

import assert from 'node:assert/strict'
import test from 'node:test'

import { LIMITS, pageLinks, rtcLinks, webtorrentPeers } from '../../build/webtorrent/index.js'
import { servePeerLinks } from '../../build/webtorrent/page.js'
import { advance, binary, fakeRtc, fakeWebSocket, FakeSession, hashOf, settle, TestTracker, until } from './fakes.mjs'

const NOW = 1_700_000_000_000
const TRACKER = 'wss://tracker.test/'
const SECOND = 1000
/** How long a connection is kept after its last signalling step before it is closed. */
const CLOSING = 5

const mocked = new WeakSet()

/** One swarm over fakes. `defaults: null` passes no tracker list at all. */
const rig = (t, { rtc = fakeRtc(), more = {}, defaults = [TRACKER], ...options } = {}) => {
  if (!mocked.has(t)) t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW })
  mocked.add(t)
  const tracker = new TestTracker()
  const WebSocket = fakeWebSocket({ [TRACKER]: tracker, ...more })
  const session = new FakeSession()
  const peers = webtorrentPeers(session, {
    links: rtcLinks({ RTCPeerConnection: rtc }), WebSocket, trackers: defaults ?? undefined, ...options,
  })
  t.after(() => peers.close())
  t.after(() => assert.equal(rtc.stats.early, 0, 'a connection was closed during a signalling step, or sooner than 5 ms after one'))
  const self = {
    t, tracker, WebSocket, rtc, session, peers,
    socket: (of = tracker) => [...of.sockets][0],
    /** The announces of a torrent that carried offers, and the ones that carried none. */
    offered: handle => tracker.announces(hashOf(handle)).filter(message => message.offers.length),
    plain: handle => tracker.announces(hashOf(handle)).filter(message => !message.offers.length),
    answers: () => tracker.received.filter(message => message.answer),
    /** Connections of the connection class still open, the scripted remotes' included. */
    open: () => rtc.all.filter(pc => !pc.closed).length,
    /** Connections the swarm holds, pending or open. */
    live: () => peers.snapshot().torrents.reduce((count, torrent) => count + torrent.pending + torrent.open, 0),
    start: async (handle, view) => {
      session.add(handle, view)
      await settle()
    },
  }
  return self
}

/** Links whose offers and answers are not made until `open()` is called. */
const gated = links => {
  let open
  const gate = new Promise(resolve => { open = resolve })
  return {
    open,
    links: {
      offer: () => gate.then(() => links.offer()),
      answer: sdp => gate.then(() => links.answer(sdp)),
      remoteAddress: link => links.remoteAddress(link),
    },
  }
}

const gatedRig = (t, options = {}) => {
  const rtc = fakeRtc()
  const gate = gated(rtcLinks({ RTCPeerConnection: rtc }))
  return { gate, r: rig(t, { rtc, links: gate.links, ...options }) }
}

let remotes = 0

/** A scripted peer of another client. Its id sorts below ours with `-AA` and above with `-ZZ`. */
class Remote {
  sockets = []
  closes = 0
  /** Its links that opened and have not closed. */
  opened = new Set()

  /** Its connections are the rig's class unless it is given one of its own. */
  constructor(rig, prefix = '-XX0001-', rtc = rig.rtc) {
    this.rig = rig
    this.id = prefix + String(remotes++).padStart(12, '0')
    this.links = rtcLinks({ RTCPeerConnection: rtc })
  }

  watch(link) {
    link.onopen = socket => {
      this.sockets.push(socket)
      this.opened.add(link)
    }
    link.onclose = () => {
      this.closes++
      this.opened.delete(link)
    }
    return link
  }

  relay(handle, offerId, description) {
    this.rig.socket().deliver({ action: 'announce', info_hash: binary(hashOf(handle)), peer_id: this.id, offer_id: offerId, ...description })
  }

  /** Sends the swarm an offer through the tracker. */
  async offer(handle) {
    const offerId = `remote-offer-${remotes++}`.padEnd(20, '.')
    const made = await this.links.offer()
    this.relay(handle, offerId, { offer: { type: 'offer', sdp: made.sdp } })
    await settle()
    return { link: this.watch(made.link), offerId }
  }

  /** Applies the swarm's answer to that offer. False when the swarm sent none. */
  async accept({ link, offerId }) {
    const answer = this.rig.answers().find(message => message.offer_id === offerId && message.to_peer_id === this.id)
    if (!answer) return false
    const accepted = await link.accept(answer.answer.sdp).then(() => true, () => false)
    await settle()
    return accepted
  }

  /** Offers, and completes the exchange when the swarm answers. True when a stream opened. */
  async connect(handle) {
    const opened = this.sockets.length
    await this.accept(await this.offer(handle))
    return this.sockets.length > opened
  }

  /** Answers one offer the swarm announced: an entry of a received announce's `offers`. */
  async answer(handle, offer) {
    const made = await this.links.answer(offer.offer.sdp)
    this.watch(made.link)
    this.relay(handle, offer.offer_id, { answer: { type: 'answer', sdp: made.sdp } })
    await settle()
    return made.link
  }
}

test('the first announce carries no offers and makes no connection; offers follow the count the tracker reports', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 3, incomplete: 2 }
  await r.start(1)
  const [first, second, ...rest] = r.tracker.announces()
  assert.equal(first.event, 'started')
  assert.equal(first.numwant, 0)
  assert.deepEqual(first.offers, [])
  assert.equal(second.event, undefined)
  assert.equal(second.numwant, 5)
  assert.equal(second.offers.length, 5, 'five others are listed, so five offers')
  assert.deepEqual(rest, [])
  assert.equal(r.rtc.stats.made, 5)
  for (const { offer_id: id, offer } of second.offers) {
    assert.match(id, /^[A-Za-z0-9]{20}$/)
    assert.equal(offer.type, 'offer')
  }
  assert.equal(new Set(second.offers.map(offer => offer.offer_id)).size, 5)
})

// How long each class takes to have a description to send is its own (links.test.mjs has the cap). Nothing
// is added to it: no beat, no interval, no timer of the swarm's.
const DESCRIBING = [
  { name: 'that completes gathering at once', gathering: 'instant', ms: 0 },
  { name: 'that completes it one task later', gathering: 'task', ms: 0 },
  { name: 'whose reflexive candidate comes after 100 ms', gathering: { reflexiveMs: 100 }, ms: 400 },
  { name: 'that completes after 150 ms', gathering: { reflexiveMs: 100, completeMs: 150 }, ms: 150 },
  { name: 'that never completes', gathering: {}, ms: 3000 },
]

for (const { name, gathering, ms } of DESCRIBING) {
  test(`the first seconds, with a class ${name}: offers are on the wire ${ms} ms after the tracker’s first reply, and an answer ${ms} ms after an offer came`, async t => {
    const r = rig(t, { rtc: fakeRtc({ gathering }) })
    r.tracker.phantoms = { complete: 3, incomplete: 0 }
    /** Lets the time a description takes pass, and says whether `sent()` was there a millisecond before the end. */
    const early = async sent => {
      if (ms) await advance(t, ms - 1, 1)
      await settle()
      const before = sent()
      if (ms) await advance(t, 1, 1)
      await settle()
      return ms > 0 && before
    }
    const sentAt = message => r.tracker.receivedAt[r.tracker.received.indexOf(message)]

    await r.start(1)
    const [first] = r.plain(1)
    assert.equal(await early(() => r.offered(1).length > 0), false)
    assert.equal(r.offered(1)[0]?.offers.length, 3)
    assert.equal(sentAt(r.offered(1)[0]) - sentAt(first), ms, 'the tracker answered in the millisecond it was asked')

    // Its own description is made beforehand, by a class that takes no time.
    const remote = new Remote(r, undefined, fakeRtc())
    const came = Date.now()
    await remote.offer(1)
    assert.equal(await early(() => r.answers().length > 0), false)
    assert.equal(r.answers().length, 1)
    assert.equal(sentAt(r.answers()[0]) - came, ms)
  })
}

test('a swarm with nobody else in it costs no connection at all', async t => {
  const r = rig(t)
  await r.start(1)
  await advance(t, 10 * SECOND)
  assert.equal(r.tracker.announces().length, 1)
  assert.equal(r.rtc.stats.made, 0)
})

test('at most ten offers go out in one announce, however many the tracker lists', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 40, incomplete: 40 }
  await r.start(1)
  assert.equal(r.offered(1)[0].offers.length, 10)
  assert.equal(r.offered(1).length, 1, 'and the reply to that announce is not followed by ten more')
})

test('offers already waiting count against the tracker’s number', async t => {
  const other = new TestTracker()
  const r = rig(t, { more: { 'wss://other.test/': other }, defaults: [TRACKER, 'wss://other.test'] })
  r.tracker.phantoms = other.phantoms = { complete: 6, incomplete: 0 }
  await r.start(1)
  const offers = [r.tracker, other].map(tracker => tracker.announces().reduce((count, message) => count + message.offers.length, 0))
  assert.equal(offers[0] + offers[1], 6, `the same six peers are not offered to twice: ${offers}`)
})

test('a seeding torrent makes no offers, and answers the ones it is sent', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 3, incomplete: 5 }
  await r.start(1, { left: 0 })
  assert.equal(r.tracker.announces()[0].left, 0)
  assert.equal(r.offered(1).length, 0)
  assert.equal(r.rtc.stats.made, 0)

  assert.equal(await new Remote(r).connect(1), true)
  assert.equal(r.session.streamsOf(1).length, 1)
})

test('before the metadata is known left is 16 KiB, and the torrent offers like any download', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1, { hasMetadata: false, left: 0 })
  assert.equal(r.tracker.announces()[0].left, 16 * 1024)
  assert.equal(r.offered(1)[0].offers.length, 2)
  assert.equal(r.offered(1)[0].left, 16 * 1024)
})

test('each torrent has its own tracker id, of the reference shape, and keeps it across a pause', async t => {
  const r = rig(t)
  await r.start(1)
  await r.start(2)
  const idOf = handle => r.tracker.announces(hashOf(handle)).map(message => message.peer_id)
  assert.match(idOf(1)[0], /^-RP0001-[A-Za-z0-9]{12}$/)
  assert.notEqual(idOf(1)[0], idOf(2)[0])
  r.session.pause(1)
  await settle()
  r.session.resume(1)
  await settle()
  assert.deepEqual([...new Set(idOf(1))], [idOf(1)[0]])
  assert.deepEqual(idOf(1).length, 3)

  r.session.remove(1)
  await settle()
  await r.start(1, { infoHash: hashOf(9) })
  assert.notEqual(r.tracker.announces(hashOf(9))[0].peer_id, idOf(1)[0], 'a handle that comes back as another torrent gets a new id')
})

test('an offer nobody answered is closed 50 s after its announce', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1)
  assert.equal(r.open(), 2)
  await advance(t, 49 * SECOND)
  assert.equal(r.open(), 2)
  await advance(t, 2 * SECOND)
  assert.equal(r.open(), 0)
  assert.equal(r.peers.snapshot().torrents[0].pending, 0)
})

test('an answered attempt that has not opened after 30 s is closed, whoever offered', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  // Our offer, answered by a remote that then never connects.
  const silent = new Remote(r)
  silent.links = rtcLinks({ RTCPeerConnection: fakeRtc({ mute: true }) })
  await silent.answer(1, r.offered(1)[0].offers[0])
  // A remote's offer, answered by us and never taken up.
  await new Remote(r).offer(1)
  assert.equal(r.answers().length, 1)
  assert.equal(r.live(), 2)
  await advance(t, 29 * SECOND)
  assert.equal(r.live(), 2)
  await advance(t, 2 * SECOND)
  assert.equal(r.live(), 0)
})

test('an open channel nothing dials within 10 s is closed, and a dialled one stays', async t => {
  const r = rig(t)
  await r.start(1)
  r.session.dials = false
  const undialled = new Remote(r)
  assert.equal(await undialled.connect(1), true)
  r.session.dials = true
  const dialled = new Remote(r)
  assert.equal(await dialled.connect(1), true)
  assert.equal(r.peers.snapshot().torrents[0].open, 2)

  await advance(t, 9 * SECOND)
  assert.equal(undialled.closes, 0)
  await advance(t, 2 * SECOND)
  assert.equal(undialled.closes, 1)
  await advance(t, 300 * SECOND, SECOND)
  assert.equal(dialled.closes, 0)
  assert.equal(r.peers.snapshot().torrents[0].open, 1)
})

test('an attempt whose description never comes is given up after 10 s, and closed if it comes late', async t => {
  const { gate, r } = gatedRig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1)
  assert.equal(r.live(), 2)
  await advance(t, 9 * SECOND)
  assert.equal(r.live(), 2)
  await advance(t, 2 * SECOND)
  assert.equal(r.live(), 0)
  gate.open()
  await settle()
  await advance(t, CLOSING)
  assert.equal(r.rtc.stats.made, 2)
  assert.equal(r.open(), 0)
  assert.equal(r.offered(1).length, 0)
})

test('a torrent that stops while its offers are being made announces none of them', async t => {
  const { gate, r } = gatedRig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1)
  await r.start(2, { left: 0 })
  r.session.pause(1)
  gate.open()
  await settle()
  await advance(t, CLOSING)
  assert.equal(r.offered(1).length, 0)
  assert.equal(r.open(), 0)
})

test('offers and answers that cannot be sent because the socket went are closed, not left waiting', async t => {
  const { gate, r } = gatedRig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1)
  await new Remote(r).offer(1)
  assert.equal(r.live(), 3, 'two offers and one answer are being made')
  r.tracker.drop()
  await settle()
  gate.open()
  await settle()
  await advance(t, CLOSING)
  assert.equal(r.live(), 0)
  assert.equal(r.open(), 1, 'only the remote’s own connection is left')
})

test('an answer the connection refuses closes that attempt', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  new Remote(r).relay(1, r.offered(1)[0].offers[0].offer_id, { answer: { type: 'answer', sdp: 'v=0\r\na=fake:999999\r\n' } })
  await settle()
  await advance(t, CLOSING)
  assert.equal(r.live(), 0)
  assert.equal(r.open(), 0)
})

test('the limits are the owner’s numbers', () => {
  assert.deepEqual(LIMITS, { torrentPeers: 20, sessionPeers: 60, connections: 80, perMinute: 40 })
})

const answeredOf = async (r, handle, count) => {
  const before = r.answers().length
  for (let i = 0; i < count; i++) await new Remote(r).offer(handle)
  return r.answers().length - before
}

test('a torrent takes 20 peers and no more', async t => {
  const r = rig(t, { limits: { perMinute: 1000 } })
  await r.start(1, { watched: true })
  assert.equal(await answeredOf(r, 1, 25), 20)
})

test('an answer to our offer is not taken once the torrent has its peers', async t => {
  const r = rig(t, { limits: { torrentPeers: 2 } })
  r.tracker.phantoms = { complete: 3, incomplete: 0 }
  await r.start(1)
  const [offer, other] = r.offered(1)[0].offers
  assert.ok(offer && other)
  assert.equal(await new Remote(r).connect(1), true)
  assert.equal(await new Remote(r).connect(1), true)
  await new Remote(r).answer(1, offer)
  assert.equal(r.session.streams.length, 2, 'the third remote gets no channel')
  assert.equal(r.live(), 3, 'the offer it answered is closed, and the other still waits')
})

test('a session takes 60 peers and no more', async t => {
  const r = rig(t, { limits: { perMinute: 1000 } })
  for (const handle of [1, 2, 3, 4]) await r.start(handle, { watched: true })
  let answered = 0
  for (const handle of [1, 2, 3, 4]) answered += await answeredOf(r, handle, 20)
  assert.equal(answered, 60)
})

test('a session holds 80 connections open or pending, unanswered offers included', async t => {
  const r = rig(t, { limits: { perMinute: 1000, sessionPeers: 1000 } })
  r.tracker.phantoms = { complete: 10, incomplete: 0 }
  for (const handle of [1, 2, 3, 4, 5]) await r.start(handle, { watched: true })
  assert.equal(r.live(), 50, 'ten offers each')
  let answered = 0
  for (const handle of [1, 2, 3, 4, 5]) answered += await answeredOf(r, handle, 10)
  assert.equal(answered, 30)
  assert.equal(r.live(), 80)
})

test('40 connections are made in a minute, and the allowance refills with time, never past 40', async t => {
  const r = rig(t, { limits: { torrentPeers: 1000, sessionPeers: 1000, connections: 1000 } })
  await r.start(1, { watched: true })
  assert.equal(await answeredOf(r, 1, 50), 40)
  await advance(t, 30 * SECOND, SECOND)
  assert.equal(await answeredOf(r, 1, 50), 20)
  await advance(t, 600 * SECOND, SECOND)
  assert.equal(await answeredOf(r, 1, 50), 40, 'ten quiet minutes save nothing up')
})

test('the watched torrent is served first: the others leave it ten of every session budget, seeding ones twenty', async t => {
  const r = rig(t, { limits: { torrentPeers: 1000, sessionPeers: 1000, perMinute: 1000, connections: 24 } })
  await r.start(1, { left: 0 })
  await r.start(2)
  await r.start(3, { watched: true })
  assert.equal(await answeredOf(r, 1, 8), 4, 'a seeding torrent stops twenty short of the limit')
  assert.equal(await answeredOf(r, 2, 20), 10, 'a download nobody watches stops ten short')
  assert.equal(await answeredOf(r, 3, 20), 10, 'the watched one takes what is left')
})

test('a connection the class would not make is counted and no error, nothing more is asked of it until the next announce, which tries again', async t => {
  const r = rig(t, { rtc: fakeRtc({ capacity: 3 }), limits: { perMinute: 1000 } })
  await r.start(1)
  const unmade = () => r.peers.snapshot().unmade
  await new Remote(r).offer(1)
  assert.equal(r.rtc.stats.made, 2, 'the remote’s and ours')
  let changes = 0
  r.peers.onchange = () => changes++
  await new Remote(r).offer(1)
  assert.equal(r.rtc.stats.made, 3, 'the remote’s; ours was refused')
  assert.equal(unmade(), 1, 'it is counted')
  assert.ok(changes > 0, 'and onchange said so')

  // The class has room again, and still nothing is asked of it: only an announce ends the wait.
  r.rtc.stats.made = -1000
  await advance(t, 100 * SECOND, SECOND)
  assert.equal(await answeredOf(r, 1, 3), 0)
  r.rtc.stats.made = 1000
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await advance(t, 20 * SECOND, SECOND)
  await settle()
  assert.equal(r.plain(1).length, 2, 'the next announce went out')
  assert.deepEqual([r.offered(1).length, unmade()], [0, 3], 'its two offers were tried, refused and counted')

  r.rtc.stats.made = -1000
  await advance(t, 120 * SECOND, SECOND)
  await settle()
  assert.deepEqual([r.offered(1).length, r.offered(1)[0]?.offers.length, unmade()], [1, 2, 3], 'and the announce after it makes them')
  assert.equal(await answeredOf(r, 1, 3), 3)
})

test('a remote with an open channel is not answered again', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r)
  assert.equal(await remote.connect(1), true)
  assert.equal(await remote.connect(1), false)
  assert.equal(r.answers().length, 1)
  assert.equal(r.session.streamsOf(1).length, 1)
})

test('a remote is the peer id of its tracker messages, never the one in its handshake, and what loses to its open channel is closed at our end', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r, undefined, fakeRtc())
  assert.equal(await remote.connect(1), true)
  // As a libtorrent 2.1 peer: the id in its BitTorrent handshake is not the one it gave the tracker.
  const inHandshake = '-LT2110-hhhhhhhhhhhh'
  remote.sockets[0].write(Buffer.concat([
    Buffer.from('\x13BitTorrent protocol'), Buffer.alloc(8), Buffer.alloc(20, 1), Buffer.from(inHandshake),
  ]))
  await settle()
  assert.equal(Buffer.concat(r.session.streams[0].bytes).length, 68)

  // Under its tracker id nothing opens beside the channel. It closes nothing: what loses is ours to close.
  assert.equal(await remote.connect(1), false, 'its offer is not answered')
  await remote.answer(1, r.offered(1)[0].offers[0])
  await advance(t, CLOSING)
  assert.equal(r.session.streams.length, 1, 'its answer to an offer of ours opens nothing')
  assert.equal(r.open(), 1, 'and our end of that offer is closed by us: the open channel is our only connection')
  assert.equal(remote.closes, 0)

  const stranger = new Remote(r, undefined, fakeRtc())
  stranger.id = inHandshake
  assert.equal(await stranger.connect(1), true, 'a remote whose tracker id is that handshake id is somebody else')
  assert.equal(r.session.streamsOf(1).length, 2)
})

test('an open channel made from our offer stands against that remote’s later offer, whatever the ids', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r, '-AA0001-')
  await remote.answer(1, r.offered(1)[0].offers[0])
  assert.equal(r.session.streamsOf(1).length, 1)
  await remote.offer(1)
  assert.equal(r.answers().length, 0)
  assert.equal(r.session.streamsOf(1).length, 1)
  assert.equal(remote.closes, 0)
})

test('an open channel made from a remote’s offer stands against its later answer to ours, whatever the ids', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r, '-ZZ0001-')
  assert.equal(await remote.connect(1), true)
  await remote.answer(1, r.offered(1)[0].offers[0])
  assert.equal(r.session.streams.length, 1)
  assert.equal(r.session.streamsOf(1).length, 1)
  assert.deepEqual([r.peers.snapshot().torrents[0].open, r.peers.snapshot().torrents[0].pending], [1, 0])
})

test('a remote that answers two of our offers at once gets one channel', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r)
  const offers = r.offered(1)[0].offers
  const answers = await Promise.all(offers.map(offer => remote.links.answer(offer.offer.sdp)))
  const opened = []
  answers.forEach(({ link, sdp }, i) => {
    link.onopen = () => opened.push(i)
    remote.relay(1, offers[i].offer_id, { answer: { type: 'answer', sdp } })
  })
  await settle()
  assert.deepEqual(opened, [0], 'its first answer stands')
  assert.equal(r.session.streams.length, 1)
  assert.equal(r.live(), 1)
})

test('a remote that sends two offers at once is answered once', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r, '-AA0001-')
  const offers = await Promise.all([remote.links.offer(), remote.links.offer()])
  offers.forEach(({ sdp }, i) => remote.relay(1, `twice-${i}`.padEnd(20, '.'), { offer: { type: 'offer', sdp } }))
  await settle()
  assert.equal(r.answers().length, 1)
  assert.equal(r.live(), 1)
})

test('an offer of a remote that is being answered stands against its later one, whatever the ids', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r, '-AA0001-')
  const first = await remote.offer(1)
  await remote.offer(1)
  assert.equal(r.answers().length, 1)
  assert.equal(await remote.accept(first), true)
  assert.equal(r.session.streamsOf(1).length, 1)
})

for (const [prefix, kept] of [['-AA0001-', 'theirs'], ['-ZZ0001-', 'ours']]) {
  /** What must hold once both attempts met: `answering` is the remote's end of our offer, `theirs` of its own. */
  const oneLeft = (r, remote, answering, theirs) => {
    assert.equal(r.session.streamsOf(1).length, 1, 'exactly one channel reached libtorrent')
    assert.equal(r.peers.snapshot().torrents[0].pending, 0)
    assert.deepEqual([remote.opened.has(theirs), remote.opened.has(answering)], [kept === 'theirs', kept === 'ours'], 'the attempt that goes on is the smaller id’s offer')
    assert.equal(r.open(), 1, 'and the other one’s connection is closed at our end: this remote closes nothing, so it is ours to close')
  }

  test(`of our offer and a remote's, both pending, the one from the smaller id is kept: ${kept} against ${prefix}`, async t => {
    const r = rig(t)
    r.tracker.phantoms = { complete: 1, incomplete: 0 }
    await r.start(1)
    const remote = new Remote(r, prefix, fakeRtc())
    const [offer] = r.offered(1)[0].offers
    // The remote answers our offer and, before either end opens, its own offer arrives.
    const theirs = await remote.links.offer()
    const answering = await remote.links.answer(offer.offer.sdp)
    remote.watch(answering.link)
    remote.relay(1, offer.offer_id, { answer: { type: 'answer', sdp: answering.sdp } })
    remote.relay(1, 'their-offer'.padEnd(20, '.'), { offer: { type: 'offer', sdp: theirs.sdp } })
    remote.watch(theirs.link)
    await settle()
    const answered = await remote.accept({ link: theirs.link, offerId: 'their-offer'.padEnd(20, '.') })
    await advance(t, CLOSING)
    assert.equal(answered, kept === 'theirs')
    oneLeft(r, remote, answering.link, theirs.link)
  })

  test(`and the same when the remote's offer came first: ${kept} against ${prefix}`, async t => {
    const r = rig(t)
    r.tracker.phantoms = { complete: 1, incomplete: 0 }
    await r.start(1)
    const remote = new Remote(r, prefix, fakeRtc())
    const [offer] = r.offered(1)[0].offers
    const theirs = await remote.offer(1)
    const answering = await remote.answer(1, offer)
    // The remote is not told which attempt we dropped, and goes on with both.
    assert.equal(await remote.accept(theirs), true)
    await advance(t, CLOSING)
    oneLeft(r, remote, answering, theirs.link)
  })
}

test('a remote whose channel closed is not answered for 60 s', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r)
  assert.equal(await remote.connect(1), true)
  remote.sockets[0].write(Buffer.of(19))
  await settle()
  remote.sockets[0].destroy()
  await settle()
  assert.equal(r.peers.snapshot().torrents[0].open, 0)

  await advance(t, 59 * SECOND, SECOND)
  assert.equal(await remote.connect(1), false)
  await advance(t, 2 * SECOND, SECOND)
  assert.equal(await remote.connect(1), true)
})

// Two of ours whose offers cross each see the other close its losing attempt. Were the answer that follows
// refused as well, they would end with no channel.
test('a remote left alone for those 60 s still has its answer to an offer of ours taken', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r)
  assert.equal(await remote.connect(1), true)
  remote.sockets[0].write(Buffer.of(19))
  await settle()
  remote.sockets[0].destroy()
  await settle()
  assert.equal(await remote.connect(1), false, 'its offer is not answered')
  await remote.answer(1, r.offered(1)[0].offers[0])
  assert.equal(r.session.streams.length, 2, 'its answer is taken')
  assert.equal(r.peers.snapshot().torrents[0].silent, 0)
})

/** The engine gives a stream up, as libtorrent does one whose remote never sent its handshake. */
const giveUp = async stream => {
  stream.socket.destroy()
  await settle()
}

/** The connection of ours that made an offer we announced. */
const ourEnd = (r, offer) => r.rtc.all.find(pc => pc.id === Number(/a=fake:(\d+)/.exec(offer.offer.sdp)[1]))

test('a remote that never sent a byte before the engine gave its stream up is left alone for ten minutes, and counted', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r)
  assert.equal(await remote.connect(1), true)
  await advance(t, 11 * SECOND, SECOND)
  await giveUp(r.session.streams[0])
  const silent = () => r.peers.snapshot().torrents[0].silent
  assert.equal(silent(), 1)

  // Past the 60 s any ended attempt costs, and on to the next announce, which leaves an offer of ours waiting.
  await advance(t, 110 * SECOND, SECOND)
  assert.equal(await remote.connect(1), false, 'its offer is not answered')
  const [offer] = r.offered(1).at(-1).offers
  assert.equal(ourEnd(r, offer).closed, false)
  await remote.answer(1, offer)
  assert.equal(r.session.streams.length, 1, 'its answer to an offer of ours is not taken')
  assert.equal(ourEnd(r, offer).closed, true, 'and our end of that offer is closed by us')
  assert.equal(r.live(), 0)

  await advance(t, 488 * SECOND, SECOND)
  assert.equal(await remote.connect(1), false, 'not at 609 s either')
  assert.equal(silent(), 1)
  let changes = 0
  r.peers.onchange = () => changes++
  await advance(t, SECOND, SECOND)
  assert.deepEqual([silent(), changes], [1, 0])
  await advance(t, SECOND, SECOND)
  assert.deepEqual([silent(), changes], [0, 1], 'ten minutes after the stream was given up it is forgotten, and onchange says so')
  assert.equal(await remote.connect(1), true)
})

test('a remote that sent even one byte is never counted silent, nor one whose stream the engine let go without reading it, nor one we gave up ourselves', async t => {
  const r = rig(t)
  await r.start(1)
  const spoke = new Remote(r)
  assert.equal(await spoke.connect(1), true)
  spoke.sockets[0].write(Buffer.of(19))
  await settle()
  assert.equal(Buffer.concat(r.session.streams[0].bytes).length, 1)
  await giveUp(r.session.streams[0])

  // The engine's own deadline ends a stream libtorrent never dialled: that says nothing about the remote.
  r.session.dials = false
  const undialled = new Remote(r)
  assert.equal(await undialled.connect(1), true)
  await giveUp(r.session.streams[1])

  // Nor does the swarm closing a channel nothing dialled, 10 s after it opened.
  const dropped = new Remote(r)
  assert.equal(await dropped.connect(1), true)
  await advance(t, 11 * SECOND, SECOND)
  assert.equal(dropped.closes, 1)
  r.session.dials = true

  assert.deepEqual([r.peers.snapshot().torrents[0].silent, r.live()], [0, 0])
  await advance(t, 61 * SECOND, SECOND)
  for (const remote of [spoke, undialled, dropped]) assert.equal(await remote.connect(1), true, 'each is answered again after the 60 s')
})

// What Chrome 156 sees of a libtorrent 2.1 peer that has no use for a channel: it ends 0 to 1 ms after it opened.
for (const dialled of [true, false]) {
  test(`a remote that ends its channel before it has sent a byte is left alone for ten minutes too, ${dialled ? 'read by the engine by then' : 'before the engine read it'}`, async t => {
    const r = rig(t)
    r.tracker.phantoms = { complete: 1, incomplete: 0 }
    await r.start(1)
    r.session.dials = dialled
    const remote = new Remote(r, undefined, fakeRtc())
    assert.equal(await remote.connect(1), true)
    remote.sockets[0].destroy()
    await settle()
    assert.deepEqual([r.peers.snapshot().torrents[0].silent, r.live()], [1, 1], 'it is counted, and our offer still waits')

    await advance(t, 121 * SECOND, SECOND)
    assert.equal(await remote.connect(1), false, 'its offer is not answered after the 60 s of a closed channel')
    const [offer] = r.offered(1).at(-1).offers
    await remote.answer(1, offer)
    assert.equal(r.session.streams.length, 1, 'and its answer to an offer of ours is not taken')
    await advance(t, 480 * SECOND, SECOND)
    assert.equal(await remote.connect(1), true, 'ten minutes later it is')
  })
}

// What libdatachannel as our end sees of the same peer: the channel is closed under us before its open event
// is handled, so the engine's first write, made while it is handed the stream, is what ends it.
test('a remote whose channel is already closed when the engine first writes to it is left alone too', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  r.session.speaks = true
  const remote = new Remote(r, undefined, fakeRtc())
  const [offer] = r.offered(1)[0].offers
  const made = await remote.links.answer(offer.offer.sdp)
  made.link.onopen = socket => socket.destroy()
  remote.relay(1, offer.offer_id, { answer: { type: 'answer', sdp: made.sdp } })
  await settle()
  assert.equal(r.session.streams.length, 1, 'the stream was handed over')
  assert.deepEqual([r.peers.snapshot().torrents[0].silent, r.live()], [1, 0])
  await advance(t, 121 * SECOND, SECOND)
  assert.equal(await remote.connect(1), false)
})

// The browser's arrangement: the swarm in the engine worker, its connections made by the page half.
test('through the page half a silent remote is told the same way, whichever end closed the channel', async t => {
  const rtc = fakeRtc()
  const { port1, port2 } = new MessageChannel()
  const stop = servePeerLinks(port1, { RTCPeerConnection: rtc })
  t.after(() => {
    stop()
    port1.close()
    port2.close()
  })
  const r = rig(t, { rtc, links: pageLinks(port2) })
  await r.start(1)
  const silent = () => r.peers.snapshot().torrents[0].silent
  /** A remote with an open channel to the swarm, and the stream the session was handed for it. */
  const connected = async () => {
    const remote = new Remote(r)
    const handed = r.session.streams.length
    const offer = await remote.offer(1)
    await until('our answer', () => r.answers().some(message => message.offer_id === offer.offerId))
    await remote.accept(offer)
    await until('the stream is handed over', () => r.session.streams.length > handed)
    return { remote, stream: r.session.streams[handed] }
  }

  const closing = await connected()
  closing.remote.sockets[0].destroy()
  await until('a remote that ended its channel without a byte is counted', () => silent() === 1)

  const refusing = await connected()
  await giveUp(refusing.stream)
  await until('and one whose stream the engine gave up', () => silent() === 2)

  const speaking = await connected()
  speaking.remote.sockets[0].write(Buffer.of(19))
  await until('its byte arrived', () => speaking.stream.bytes.length === 1)
  speaking.remote.sockets[0].destroy()
  await until('its channel closed', () => r.live() === 0)
  assert.equal(silent(), 2, 'a remote that sent a byte is not')
})

test('a silent remote is still left alone after its torrent was paused and resumed', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r)
  assert.equal(await remote.connect(1), true)
  await giveUp(r.session.streams[0])
  r.session.pause(1)
  await settle()
  r.session.resume(1)
  await settle()
  assert.equal(r.peers.snapshot().torrents[0].silent, 1)
  await advance(t, 61 * SECOND, SECOND)
  assert.equal(await remote.connect(1), false)
})

test('a torrent leaves at most 200 remotes alone at a time, and forgets the oldest first', async t => {
  const BOUND = 200
  const r = rig(t, { limits: { perMinute: 1_000_000 } })
  await r.start(1)
  const remotes = []
  // Counted, and it stops at the first count over the bound: with the bound gone this fails, it does not grow.
  for (let i = 0; i < BOUND + 10; i++) {
    remotes.push(new Remote(r))
    assert.equal(await remotes[i].connect(1), true, `remote ${i} connected`)
    await giveUp(r.session.streams[i])
    const held = r.peers.snapshot().torrents[0].silent
    assert.ok(held <= BOUND, `${held} remotes are remembered after ${i + 1} went silent: the bound is ${BOUND}`)
  }
  assert.equal(r.peers.snapshot().torrents[0].silent, BOUND)
  assert.equal(await remotes[BOUND + 9].connect(1), false, 'the newest is still left alone')
  assert.equal(await remotes[0].connect(1), true, 'the oldest was forgotten to make room')
})

/** A scripted peer whose channels come from that address. */
const from = (r, address) => new Remote(r, undefined, fakeRtc({ address }))

test('with the relay flag the address a silent remote came from is left alone too, under any id', async t => {
  const r = rig(t, { relay: true })
  await r.start(1)
  assert.equal(await from(r, '198.51.100.7').connect(1), true)
  await giveUp(r.session.streams[0])
  const again = from(r, '198.51.100.7')
  await again.connect(1)
  assert.equal(r.session.streams.length, 1, 'another id from that address gets no stream')
  assert.equal(again.closes, 1)
  const left = from(r, '198.51.100.8')
  assert.equal(await left.connect(1), true)
  assert.equal(r.session.streams.length, 2, 'another address does')
  left.sockets[0].write(Buffer.of(19))
  await settle()
  left.sockets[0].destroy()
  await settle()
  assert.equal(await from(r, '198.51.100.8').connect(1), true)
  assert.equal(r.session.streams.length, 3, 'and an address whose remote spoke before its channel closed is not kept')

  const plain = rig(t)
  await plain.start(1)
  assert.equal(await from(plain, '198.51.100.7').connect(1), true)
  await giveUp(plain.session.streams[0])
  assert.equal(await from(plain, '198.51.100.7').connect(1), true)
  assert.equal(plain.session.streams.length, 2, 'without the flag no address is kept')
})

test('an open channel is handed to the session, and closed when the session refuses it', async t => {
  const r = rig(t)
  await r.start(1)
  const welcome = new Remote(r)
  assert.equal(await welcome.connect(1), true)
  const [stream] = r.session.streams
  assert.equal(stream.handle, 1)
  welcome.sockets[0].write(Buffer.from('to libtorrent'))
  stream.socket.write(Buffer.from('from libtorrent'))
  const got = []
  welcome.sockets[0].on('data', bytes => got.push(Buffer.from(bytes)))
  await settle()
  assert.equal(Buffer.concat(stream.bytes).toString(), 'to libtorrent')
  assert.equal(Buffer.concat(got).toString(), 'from libtorrent')

  r.session.refuses = true
  const refused = new Remote(r)
  await refused.connect(1)
  assert.equal(refused.closes, 1)
  assert.equal(r.peers.snapshot().torrents[0].open, 1)
})

test('a stream the session destroys as it takes it is no peer: nothing is counted and nothing is dated', async t => {
  const r = rig(t)
  await r.start(1)
  r.session.destroys = true
  const remote = new Remote(r)
  await remote.connect(1)
  const { open, pending, lastPeerAt } = r.peers.snapshot().torrents[0]
  assert.deepEqual({ open, pending, lastPeerAt }, { open: 0, pending: 0, lastPeerAt: null })
  assert.equal(remote.closes, 1)
})

test('a torrent that stopped between the answer and the open gets no channel', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r)
  const offer = await remote.offer(1)
  // Stopped with no event, as the queue does it: the swarm has not heard yet when the channel opens.
  r.session.set(1, { running: false })
  await remote.accept(offer)
  assert.equal(r.session.streams.length, 0)
  assert.equal(remote.closes, 1)
})

test('with the relay flag a channel whose remote address is already an ordinary peer is closed, and only then', async t => {
  const r = rig(t, { relay: true })
  await r.start(1)
  r.session.ordinary.set(1, [{ endpoint: '198.51.100.7:51413' }, { endpoint: '[2001:db8::7]:6881' }])
  for (const address of ['198.51.100.7', '2001:db8::7']) {
    const known = from(r, address)
    await known.connect(1)
    assert.equal(r.session.streams.length, 0, `${address} is an ordinary peer`)
    assert.equal(known.closes, 1)
  }
  assert.equal(await from(r, '198.51.100.8').connect(1), true)
  assert.equal(r.session.streams.length, 1, 'an address no ordinary peer has is taken')

  const plain = rig(t)
  await plain.start(1)
  plain.session.ordinary.set(1, [{ endpoint: '198.51.100.7:51413' }])
  assert.equal(await from(plain, '198.51.100.7').connect(1), true)
  assert.equal(plain.session.streams.length, 1, 'without the flag the address is not looked at')
})

test('with the relay flag an address that was an ordinary peer earlier in the session is closed too, a pause later as well', async t => {
  const r = rig(t, { relay: true })
  await r.start(1)
  r.session.ordinary.set(1, [{ endpoint: '198.51.100.7:51413' }])
  await advance(t, SECOND)
  r.session.ordinary.set(1, [])
  const refused = async (address, why) => {
    const before = r.session.streams.length
    const remote = from(r, address)
    await remote.connect(1)
    assert.deepEqual([r.session.streams.length - before, remote.closes], [0, 1], why)
  }
  await refused('198.51.100.7', 'it left, and its address is still not taken')
  r.session.pause(1)
  await settle()
  r.session.resume(1)
  await settle()
  await refused('198.51.100.7', 'nor after the torrent was paused and resumed')
  assert.equal(await from(r, '198.51.100.8').connect(1), true)
  assert.equal(JSON.stringify(r.peers.snapshot()).includes('198.51.100'), false, 'what the swarm reports names no address')
})

test('with the relay flag a channel whose remote closed it while the ordinary peers were read is not handed over, and its remote is silent like any other', async t => {
  const r = rig(t, { relay: true })
  await r.start(1)
  let answer
  r.session.peers = () => new Promise(resolve => { answer = resolve })
  const remote = from(r, '198.51.100.7')
  assert.equal(await remote.connect(1), true)
  remote.sockets[0].destroy()
  await settle()
  answer([])
  await settle()
  assert.equal(r.session.streams.length, 0)
  assert.equal(r.peers.snapshot().torrents[0].silent, 1, 'it ended its channel without a byte')

  r.session.peers = async () => []
  await advance(t, 61 * SECOND, SECOND)
  assert.equal(await remote.connect(1), false, 'so its offer is not answered after the 60 s of a closed channel')
  const again = from(r, '198.51.100.7')
  await again.connect(1)
  assert.deepEqual([r.session.streams.length, again.closes], [0, 1], 'and its address is left alone under another id')
})

test('with the relay flag the ordinary peers of a torrent are read every 10 s, and never without it', async t => {
  const r = rig(t, { relay: true })
  await r.start(1)
  await advance(t, 35 * SECOND, SECOND)
  assert.deepEqual(r.session.lookedAt.map(at => (at - NOW) / SECOND), [1, 11, 21, 31], 'at the first beat, then every 10 s')
  const plain = rig(t)
  await plain.start(1)
  await advance(t, 35 * SECOND, SECOND)
  assert.deepEqual(plain.session.lookedAt, [])
})

test('a torrent remembers the addresses of 1000 ordinary peers, forgets the oldest first, and never one that is still there', async t => {
  const BOUND = 1000
  const address = i => `2001:db8::${(i + 1).toString(16)}`
  const peer = i => ({ endpoint: `[${address(i)}]:6881` })
  const r = rig(t, { relay: true })
  await r.start(1)
  const taken = async i => {
    const before = r.session.streams.length
    await from(r, address(i)).connect(1)
    return r.session.streams.length > before
  }

  // Peer 0 first, then 999 more beside it: the torrent remembers exactly as many as it may.
  r.session.ordinary.set(1, [peer(0)])
  await advance(t, SECOND)
  r.session.ordinary.set(1, Array.from({ length: BOUND }, (_, i) => peer(i)))
  await advance(t, 10 * SECOND, SECOND)
  assert.equal(r.session.lookedAt.length, 2)

  // One more appears while peer 0 is still there. Something has to go, and it is not peer 0.
  r.session.ordinary.set(1, [peer(0), peer(BOUND)])
  assert.equal(await taken(0), false, 'the oldest address is still an ordinary peer, so it is kept and refused')

  // Ten more, and everybody leaves. With the bound gone the oldest would still be refused: this fails, nothing grows.
  r.session.ordinary.set(1, Array.from({ length: 10 }, (_, i) => peer(BOUND + 1 + i)))
  assert.equal(await taken(BOUND + 5), false)
  r.session.ordinary.set(1, [])
  assert.equal(await taken(1), true, 'the oldest that left is forgotten')
  assert.equal(await taken(11), true, 'and so is the eleventh')
  assert.equal(await taken(12), false, 'the twelfth is the oldest still remembered')
  assert.equal(await taken(0), false, 'with the one that was still there')
})

test('a torrent is announced to its own ws and wss trackers and to the defaults, on one socket per tracker', async t => {
  const own = new TestTracker()
  const r = rig(t, { more: { 'ws://own.test/announce': own } })
  await r.start(1, { trackers: ['ws://own.test/announce', 'udp://tracker.test:6969', 'https://tracker.test/announce'] })
  await r.start(2, { trackers: ['WSS://Tracker.Test'] })
  assert.equal(own.announces(hashOf(1)).length, 1)
  assert.equal(r.tracker.announces(hashOf(1)).length, 1)
  assert.equal(r.tracker.announces(hashOf(2)).length, 1)
  assert.deepEqual(r.WebSocket.opened.sort(), ['ws://own.test/announce', TRACKER])
})

test('a tracker name that is the person’s own machine or network is never opened', async t => {
  const r = rig(t)
  await r.start(1, {
    trackers: [
      'wss://localhost', 'ws://localhost:8000/announce', 'wss://tracker.localhost', 'ws://127.0.0.1:8000', 'wss://127.1',
      'ws://0x7f000001', 'wss://10.0.0.5', 'wss://172.16.4.4', 'wss://192.168.1.4:443', 'wss://169.254.10.10',
      'wss://100.64.0.9', 'wss://0.0.0.0', 'wss://[::1]', 'wss://[::]', 'wss://[fe80::1]', 'wss://[fd00::7]',
      'wss://[::ffff:192.168.1.4]', 'wss://nas', 'wss://printer.local', 'not a url', 'wss://',
    ],
  })
  assert.deepEqual(r.WebSocket.opened, [TRACKER])
})

test('a private torrent is announced to its own trackers only', async t => {
  const own = new TestTracker()
  const r = rig(t, { more: { 'wss://private.test/': own } })
  await r.start(1, { private: true, trackers: ['wss://private.test'] })
  await r.start(2, { private: true })
  await advance(t, 5 * SECOND)
  assert.equal(own.announces(hashOf(1)).length, 1)
  assert.equal(r.tracker.announces().length, 0)
  assert.deepEqual(r.WebSocket.opened, ['wss://private.test/'])
})

test('a magnet is not announced to the defaults until its private flag is known', async t => {
  const own = new TestTracker()
  const r = rig(t, { more: { 'wss://own.test/': own } })
  await r.start(1, { hasMetadata: false, private: undefined, trackers: ['wss://own.test'] })
  await r.start(2, { hasMetadata: false, private: undefined, trackers: ['wss://own.test'] })
  await advance(t, 5 * SECOND)
  assert.equal(own.announces().length, 2)
  assert.equal(r.tracker.announces().length, 0)

  r.session.set(1, { hasMetadata: true, private: false })
  r.session.set(2, { hasMetadata: true, private: true })
  await advance(t, 2 * SECOND)
  assert.equal(r.tracker.announces(hashOf(1)).length, 1, 'the public one joins the defaults within a beat')
  assert.equal(r.tracker.announces(hashOf(2)).length, 0)
})

test('a torrent that is not running is not announced, and one that stops says so and loses its attempts', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1, { running: false })
  await advance(t, 5 * SECOND)
  assert.equal(r.tracker.announces().length, 0)

  await r.start(2)
  assert.equal(r.open(), 2)
  const remote = new Remote(r)
  assert.equal(await remote.connect(2), true)
  r.session.pause(2)
  await settle()
  await advance(t, CLOSING)
  assert.equal(r.tracker.announces(hashOf(2)).at(-1).event, 'stopped')
  assert.equal(r.open(), 0, 'its offers and its channel are closed')
  assert.equal(remote.closes, 1)
  assert.deepEqual(r.peers.snapshot().torrents, [])

  // Another torrent keeps the tracker socket, so an offer for the paused one can still arrive.
  r.tracker.phantoms = { complete: 0, incomplete: 0 }
  await r.start(3)
  assert.equal(await new Remote(r).connect(2), false, 'a paused torrent takes no offer')
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  r.session.resume(2)
  await settle()
  assert.equal(r.tracker.announces(hashOf(2)).at(-2).event, 'started')
})

test('a torrent paused and resumed before the tracker has answered the pause still offers after the resume', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  // Another torrent keeps the tracker socket, so the reply to `stopped` comes back on it after `started` went out.
  await r.start(2, { left: 0 })
  await r.start(1)
  assert.equal(r.offered(1).length, 1)
  r.session.pause(1)
  r.session.resume(1)
  await settle()
  assert.deepEqual(r.tracker.announces(hashOf(1)).slice(-3).map(message => message.event), ['stopped', 'started', undefined])
  assert.equal(r.offered(1).length, 2, 'the count that left us out is not the one the offers follow')
})

test('a torrent paused by the queue, with no event, is noticed within a beat', async t => {
  const r = rig(t)
  await r.start(1)
  r.session.set(1, { running: false })
  await advance(t, 1100)
  assert.equal(r.tracker.announces(hashOf(1)).at(-1).event, 'stopped')
})

test('a torrent that left the session with no event is noticed within a beat', async t => {
  const r = rig(t)
  await r.start(1)
  r.session.views.delete(1)
  await advance(t, 1100)
  assert.equal(r.tracker.announces(hashOf(1)).at(-1).event, 'stopped')
  assert.deepEqual(r.peers.snapshot().torrents, [])
})

test('a removed torrent says stopped, and its tracker socket is closed once no torrent uses it', async t => {
  const r = rig(t)
  await r.start(1)
  assert.equal(r.tracker.sockets.size, 1)
  r.session.remove(1)
  await settle()
  assert.equal(r.tracker.announces(hashOf(1)).at(-1).event, 'stopped')
  assert.equal(r.tracker.sockets.size, 0)
})

test('completed is said once, when a download that had bytes left has none', async t => {
  const r = rig(t)
  await r.start(1, { left: 500 })
  r.session.set(1, { left: 0, downloaded: 500 })
  await advance(t, 3 * SECOND)
  const events = r.tracker.announces(hashOf(1)).map(message => message.event)
  assert.deepEqual(events, ['started', 'completed'])
  assert.equal(r.tracker.announces(hashOf(1))[1].downloaded, 500)

  await r.start(2, { left: 0 })
  await advance(t, 3 * SECOND)
  assert.deepEqual(r.tracker.announces(hashOf(2)).map(message => message.event), ['started'], 'a torrent that was complete all along completes nothing')

  await r.start(3, { hasMetadata: false, left: 0 })
  r.session.set(3, { hasMetadata: true })
  await advance(t, 3 * SECOND)
  assert.deepEqual(r.tracker.announces(hashOf(3)).map(message => message.event), ['started'], 'nor does a magnet whose files turn out to be here already')
})

test('the swarm keeps announcing at the tracker’s interval, kept between 60 and 600 s, and offers again by the new count', async t => {
  const r = rig(t)
  r.tracker.interval = 5
  await r.start(1)
  await advance(t, 59 * SECOND, SECOND)
  assert.equal(r.plain(1).length, 1)
  await advance(t, 2 * SECOND, SECOND)
  assert.equal(r.plain(1).length, 2)
  assert.equal(r.plain(1)[1].event, undefined)

  r.tracker.interval = 86_400
  r.tracker.phantoms = { complete: 0, incomplete: 3 }
  await advance(t, 60 * SECOND, SECOND)
  assert.equal(r.plain(1).length, 3)
  assert.equal(r.offered(1).length, 1, 'somebody appeared, so this announce is followed by offers')
  assert.equal(r.offered(1)[0].offers.length, 3)
  await advance(t, 598 * SECOND, SECOND)
  assert.equal(r.plain(1).length, 3)
  await advance(t, 3 * SECOND, SECOND)
  assert.equal(r.plain(1).length, 4)
  assert.equal(r.offered(1).length, 2)
})

test('a tracker that never answers is asked again every 120 s', async t => {
  const r = rig(t)
  r.tracker.silent = true
  await r.start(1)
  await advance(t, 119 * SECOND, SECOND)
  assert.equal(r.tracker.announces().length, 1)
  await advance(t, 2 * SECOND, SECOND)
  assert.equal(r.tracker.announces().length, 2)
})

test('after the tracker socket comes back every torrent on it is announced as started again', async t => {
  const r = rig(t)
  await r.start(1)
  await r.start(2)
  r.tracker.drop()
  await settle()
  assert.equal(r.peers.snapshot().torrents[0].trackers[0].connected, false)
  await advance(t, 13 * SECOND)
  const events = handle => r.tracker.announces(hashOf(handle)).map(message => message.event)
  assert.deepEqual(events(1), ['started', 'started'])
  assert.deepEqual(events(2), ['started', 'started'])
  assert.equal(r.peers.snapshot().torrents[0].trackers[0].connected, true)
})

test('an answer to an offer we never made, or a second answer to one, changes nothing', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 1, incomplete: 0 }
  await r.start(1)
  const [offer] = r.offered(1)[0].offers
  const first = new Remote(r)
  const stranger = new Remote(r)
  const made = await stranger.links.offer()
  stranger.relay(1, 'never-offered'.padEnd(20, '.'), { answer: { type: 'answer', sdp: made.sdp } })
  await first.answer(1, offer)
  await new Remote(r).answer(1, offer)
  assert.equal(r.session.streamsOf(1).length, 1)
  assert.equal(first.sockets.length, 1)
  await advance(t, 40 * SECOND, SECOND)
  assert.equal(r.session.streamsOf(1).length, 1, 'the channel that opened is not set back to waiting')
  assert.equal(first.closes, 0)
})

test('on the wire our peer id and every offer id are exactly 20 bytes, and every id and hash is a JSON string of 20 characters of one byte each', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 3, incomplete: 0 }
  await r.start(1, { left: 500 })
  // A hash with a quote, a backslash, a control byte and bytes above 127 in it, and a remote id of the same kind.
  await r.start(2, { infoHash: '225c0a7f80a0e9ff' + 'c5'.repeat(12) })
  const remote = new Remote(r, undefined, fakeRtc())
  remote.id = Buffer.from('2d4c54323131302d000a225c7f809fa0e9feff41', 'hex').toString('latin1')
  assert.equal(await remote.connect(1), true)
  r.session.set(1, { left: 0 })
  await advance(t, SECOND)
  r.session.pause(1)
  await settle()

  /** A string as a libtorrent 2.1 peer takes an id: one byte from each character, and none above 255. */
  const bytesOf = id => [...id].map(character => character.codePointAt(0))
  const twenty = (id, what) => {
    assert.equal(typeof id, 'string', what)
    assert.equal(bytesOf(id).length, 20, `${what} is 20 characters`)
    assert.ok(bytesOf(id).every(byte => byte <= 255), `${what} has one byte in each character`)
  }
  const kinds = new Set()
  for (const frame of r.WebSocket.frames) {
    // What the socket carries, and the same with one character for each byte of it.
    const wire = Buffer.from(frame, 'utf8')
    const text = wire.toString('latin1')
    const message = JSON.parse(wire.toString('utf8'))
    const kind = message.answer ? 'answer' : message.offers.length ? 'offers' : message.event ?? 'no event'
    kinds.add(kind)
    twenty(message.info_hash, `the info hash of ${kind}`)
    const ours = [['peer_id', message.peer_id], ...(message.answer ? [] : message.offers.map(offer => ['offer_id', offer.offer_id]))]
    for (const [name, id] of ours) {
      twenty(id, `the ${name} of ${kind}`)
      assert.ok(text.includes(`"${name}":"${id}"`), `the ${name} of ${kind} is 20 bytes between its quotes: ${JSON.stringify(id)}`)
    }
    if (message.answer) {
      assert.equal(message.to_peer_id, remote.id, 'the remote’s id goes back as it came')
      twenty(message.offer_id, 'the offer id an answer names')
    }
  }
  assert.deepEqual(kinds, new Set(['started', 'offers', 'answer', 'completed', 'stopped']), 'every kind of frame was read')
  assert.equal(r.WebSocket.frames.filter(frame => JSON.parse(frame).offers?.length).flatMap(frame => JSON.parse(frame).offers).length, 6)
})

test('our own id coming back from the tracker is ignored', async t => {
  const r = rig(t)
  await r.start(1)
  const remote = new Remote(r)
  remote.id = r.tracker.announces()[0].peer_id
  await remote.offer(1)
  assert.equal(r.answers().length, 0)
})

test('the snapshot says what each tracker last answered, what is pending and open, and when a peer last connected', async t => {
  const r = rig(t)
  let changes = 0
  r.peers.onchange = () => changes++
  await r.start(1)
  const nobody = r.peers.snapshot()
  assert.deepEqual(nobody, {
    dropped: 0,
    unmade: 0,
    torrents: [{
      handle: 1,
      trackers: [{ url: TRACKER, connected: true, seeders: 0, leechers: 1, answeredAt: NOW, failure: null }],
      pending: 0, open: 0, lastPeerAt: null, silent: 0,
    }],
  })
  assert.ok(changes > 0)

  // Nobody yet is not final: the next announce is asked and answered, and the snapshot says when.
  await advance(t, 121 * SECOND, SECOND)
  const later = r.peers.snapshot().torrents[0]
  assert.ok(later.trackers[0].answeredAt >= NOW + 120 * SECOND)
  assert.equal(later.lastPeerAt, null)

  const before = changes
  const remote = new Remote(r)
  const offer = await remote.offer(1)
  assert.equal(r.peers.snapshot().torrents[0].pending, 1)
  await remote.accept(offer)
  const found = r.peers.snapshot().torrents[0]
  assert.deepEqual({ pending: found.pending, open: found.open }, { pending: 0, open: 1 })
  assert.equal(found.lastPeerAt, Date.now())
  assert.ok(changes > before, 'onchange followed the peer')
})

test('a tracker’s refusal shows in the snapshot, with or without the torrent named, and the next announce still goes', async t => {
  const r = rig(t)
  r.tracker.silent = true
  await r.start(1)
  await r.start(2)
  r.socket().deliver({ action: 'announce', info_hash: binary(hashOf(1)), 'failure reason': 'not allowed here' })
  await settle()
  const failures = () => r.peers.snapshot().torrents.map(torrent => torrent.trackers[0].failure)
  assert.deepEqual(failures(), ['not allowed here', null])
  r.socket().deliver({ 'failure reason': 'invalid peer_id' })
  await settle()
  assert.deepEqual(failures(), ['not allowed here', 'invalid peer_id'], 'a refusal that names no torrent goes to the announce still waiting')

  r.tracker.silent = false
  await advance(t, 121 * SECOND, SECOND)
  assert.deepEqual(failures(), [null, null])
})

test('a message that does not validate is counted in the snapshot, and the swarm goes on', async t => {
  const r = rig(t)
  await r.start(1)
  r.socket().deliver('{"action":')
  r.socket().deliver({ action: 'announce', info_hash: binary(hashOf(1)), peer_id: 'short', offer_id: 'x', offer: { type: 'offer', sdp: 'v=0' } })
  await settle()
  assert.equal(r.peers.snapshot().dropped, 2)
  assert.equal(r.rtc.stats.made, 0)
  assert.equal(await new Remote(r).connect(1), true)

  r.session.remove(1)
  await settle()
  assert.equal(r.tracker.sockets.size, 0)
  assert.equal(r.peers.snapshot().dropped, 2, 'the count outlives the tracker socket it was made on')
})

test('close says stopped everywhere, closes every connection and socket, and nothing runs afterwards', async t => {
  const r = rig(t)
  r.tracker.phantoms = { complete: 2, incomplete: 0 }
  await r.start(1)
  const remote = new Remote(r)
  await remote.connect(1)
  let changes = 0
  r.peers.onchange = () => changes++
  r.peers.close()
  await settle()
  await advance(t, CLOSING)
  assert.equal(r.tracker.announces().at(-1).event, 'stopped')
  assert.equal(r.tracker.sockets.size, 0)
  assert.equal(r.open(), 0)
  assert.equal(remote.closes, 1)
  const count = r.tracker.received.length
  r.session.add(2)
  await advance(t, 300 * SECOND, SECOND)
  assert.equal(r.tracker.received.length, count)
  assert.equal(changes, 0)
  assert.deepEqual(r.session.listeners.add.size, 0)
})

test('nothing is contacted unless the caller names it: no default tracker is built in', async t => {
  const r = rig(t, { defaults: null })
  await r.start(1)
  await advance(t, 5 * SECOND)
  assert.deepEqual(r.WebSocket.opened, [])
  assert.deepEqual(r.peers.snapshot().torrents[0].trackers, [])
})
