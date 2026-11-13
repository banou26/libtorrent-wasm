// rtcLinks, the one function that drives a class shaped like RTCPeerConnection, against an in-memory class
// (always) and against libdatachannel through node-datachannel (when its native module loads).

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { LinksFull, rtcLinks } from '../../build/webtorrent/index.js'
import { advance, fakeRtc, handlersOf, pair, reached, reading, settle, turn, until, within, writeAll } from './fakes.mjs'

const KIB = 1024
const MIB = 1024 * KIB

test('an offer, its answer and the accept open a stream at both ends, and bytes cross both ways intact', async () => {
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: fakeRtc() }))
  const [fromA, fromB] = [crypto.randomBytes(300 * KIB), crypto.randomBytes(200 * KIB)]
  const [atA, atB] = [reading(a.socket), reading(b.socket)]
  await Promise.all([writeAll(a.socket, fromA), writeAll(b.socket, fromB)])
  await until('everything arrived', () => atB.length === fromA.length && atA.length === fromB.length)
  assert.equal(Buffer.compare(atB.bytes, fromA), 0)
  assert.equal(Buffer.compare(atA.bytes, fromB), 0)
  assert.equal(a.socket.backpressure, true)
  assert.equal('maxRecvQueue' in a.socket, false, 'how much may sit unread is the engine’s number, not the stream’s')
})

test('what the remote sent before anything read the stream is kept and delivered in order', async () => {
  const Class = fakeRtc()
  const links = rtcLinks({ RTCPeerConnection: Class })
  const offer = await links.offer()
  const answer = await links.answer(offer.sdp)
  // Both ends speak the moment their channel opens, as a BitTorrent peer does, and nobody reads yet.
  const streams = []
  for (const [name, link] of [['offerer', offer.link], ['answerer', answer.link]]) {
    link.onopen = socket => {
      streams.push(socket)
      socket.write(Buffer.from(`hello from the ${name}, `))
      socket.write(Buffer.from('twice'))
    }
  }
  await offer.link.accept(answer.sdp)
  await settle()
  assert.equal(Class.stats.lost, 0, 'no message reached a channel that had no handler')
  const heard = streams.map(socket => reading(socket).bytes.toString()).sort()
  assert.deepEqual(heard, ['hello from the answerer, twice', 'hello from the offerer, twice'])
})

test('a message that comes before the open event opens the stream, and it is kept', async () => {
  const Class = fakeRtc()
  const { link } = await rtcLinks({ RTCPeerConnection: Class }).offer()
  let socket = null
  link.onopen = opened => { socket = opened }
  Class.all[0].channel.onmessage({ data: Uint8Array.of(1, 2, 3).buffer })
  assert.deepEqual([...reading(socket).bytes], [1, 2, 3])
  link.close()
})

test('a message handed over as a view of a larger buffer is read as its own bytes only', async () => {
  const Class = fakeRtc()
  const { a } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const got = reading(a.socket)
  Class.all[0].channel.onmessage({ data: Buffer.from('..handshake..').subarray(2, 11) })
  assert.equal(got.bytes.toString(), 'handshake')
  assert.equal(a.closes, 0)
})

test('a stream that nothing reads keeps at most 1 MiB, then ends with an error and closes the link', async () => {
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: fakeRtc() }))
  await writeAll(a.socket, Buffer.alloc(MIB + 64 * KIB))
  await until('the link closed', () => b.closes === 1)
  const heard = []
  b.socket.on('error', error => heard.push(error.message))
  b.socket.on('close', () => heard.push('close'))
  await turn()
  assert.match(heard[0], /before anything read the stream/)
  assert.equal(heard[1], 'close')
})

test('a write is cut to 16 KiB messages, or to the limit the remote description names when that is smaller', async () => {
  for (const [named, largest] of [[262144, 16 * KIB], [null, 16 * KIB], [1200, 1200]]) {
    const Class = fakeRtc({ maxMessageSize: named })
    const { a, b } = await pair(rtcLinks({ RTCPeerConnection: Class }))
    const sent = crypto.randomBytes(100 * KIB + 7)
    const got = reading(b.socket)
    await writeAll(a.socket, sent)
    await until('everything arrived', () => got.length === sent.length)
    assert.equal(Class.stats.maxMessage, largest, `with ${named} named`)
    assert.equal(Buffer.compare(got.bytes, sent), 0)
  }
})

test('with a slow remote the channel holds about 1 MiB, write says false and drain follows', async () => {
  const Class = fakeRtc({ rate: 48 * KIB })
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const sent = crypto.randomBytes(8 * MIB)
  const got = reading(b.socket)
  const { waits } = await writeAll(a.socket, sent)
  await until('everything arrived', () => got.length === sent.length, 4000)
  assert.ok(waits > 0, 'the writer was told to wait')
  assert.ok(Class.stats.maxBuffered <= MIB + 16 * KIB, `at most ${Class.stats.maxBuffered} bytes were queued in the channel`)
  assert.ok(Class.stats.maxBuffered >= MIB, 'and it was filled to the mark')
  assert.equal(Class.all[0].channel.bufferedAmountLowThreshold, 256 * KIB, 'the channel says when it is back down to 256 KiB, not when it is empty')
  assert.equal(Buffer.compare(got.bytes, sent), 0)
})

test('a message the channel refuses ends the stream with an error, and write() does not throw', async () => {
  const Class = fakeRtc()
  const { a } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const errors = []
  a.socket.on('error', error => errors.push(error.message))
  Class.all[0].channel.send = () => { throw new Error('OperationError') }
  assert.equal(a.socket.write(Buffer.from('refused')), true)
  assert.deepEqual(errors, ['the data channel refused a message'])
  assert.equal(a.closes, 1)
})

test('a description is read 3 s after the request from a class that never finishes gathering', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const links = rtcLinks({ RTCPeerConnection: fakeRtc({ gathering: {} }) })
  let made = null
  links.offer().then(result => { made = result })
  await settle()
  t.mock.timers.tick(2999)
  await settle()
  assert.equal(made, null)
  t.mock.timers.tick(1)
  await settle()
  assert.match(made.sdp, /typ host/)
  made.link.close()
})

test('it is read 300 ms after the first reflexive candidate, and carries that candidate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const links = rtcLinks({ RTCPeerConnection: fakeRtc({ gathering: { reflexiveMs: 100 } }) })
  let made = null
  links.offer().then(result => { made = result })
  await settle()
  await advance(t, 399, 1)
  assert.equal(made, null)
  await advance(t, 1, 1)
  assert.match(made.sdp, /typ srflx/)
  made.link.close()
})

test('it is read as soon as gathering completes, and at once from a class that completes at once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const slow = rtcLinks({ RTCPeerConnection: fakeRtc({ gathering: { reflexiveMs: 10, completeMs: 50 } }) })
  let made = null
  slow.offer().then(result => { made = result })
  await settle()
  t.mock.timers.tick(49)
  await settle()
  assert.equal(made, null)
  t.mock.timers.tick(1)
  await settle()
  assert.ok(made)
  made.link.close()

  const instant = rtcLinks({ RTCPeerConnection: fakeRtc({ gathering: 'instant' }) })
  const offer = await within('the offer', instant.offer())
  const answer = await within('the answer', instant.answer(offer.sdp))
  assert.match(answer.sdp, /typ host/)
  offer.link.close()
  answer.link.close()
})

for (const completion of ['state', 'candidate']) {
  test(`the end of gathering is heard when the class tells it by ${completion} alone`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const links = rtcLinks({ RTCPeerConnection: fakeRtc({ completion }) })
    const { sdp, link } = await within('the offer', links.offer())
    assert.match(sdp, /typ host/)
    link.close()
  })
}

test('a connection that fails while it gathers gives no description', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const Class = fakeRtc({ gathering: {} })
  const refused = assert.rejects(rtcLinks({ RTCPeerConnection: Class }).offer(), /closed before it had a description/)
  await settle()
  const [pc] = Class.all
  pc.connectionState = 'failed'
  pc.onconnectionstatechange({})
  await advance(t, 3000, 1000)
  await within('the refusal', refused)
  assert.equal(pc.closed, true)
})

test('close() ends both ends, tells the remote, and is silent toward its own caller', async () => {
  const Class = fakeRtc()
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const heard = { a: [], b: [] }
  for (const side of ['a', 'b']) for (const event of ['end', 'close']) ({ a, b })[side].socket.on(event, () => heard[side].push(event))
  a.link.close()
  await settle()
  assert.deepEqual(heard, { a: ['end', 'close'], b: ['end', 'close'] })
  assert.equal(a.closes, 0)
  assert.equal(b.closes, 1)
  assert.equal(a.socket.write(Buffer.from('late')), true, 'a write after the end is taken and dropped')
  for (const pc of Class.all) assert.deepEqual(handlersOf(pc), [], 'a closed link holds no handler on its connection')
  await reached('both connections closed', () => Class.all.every(pc => pc.closed))
})

test('destroy() on the stream closes the link and says so, since the swarm has to hear of it', async () => {
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: fakeRtc() }))
  a.socket.destroy()
  await settle()
  assert.equal(a.closes, 1)
  assert.equal(b.closes, 1)
})

test('a listener added after the stream ended still hears the end', async () => {
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: fakeRtc() }))
  a.socket.write(Buffer.from('last words'))
  await settle()
  a.link.close()
  await settle()
  const heard = []
  b.socket.on('data', bytes => heard.push(Buffer.from(bytes).toString()))
  b.socket.on('end', () => heard.push('end'))
  b.socket.on('close', () => heard.push('close'))
  await turn()
  assert.deepEqual(heard, ['last words', 'end', 'close'])
})

test('a connection that fails ends the link', async () => {
  const Class = fakeRtc()
  const { a } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const pc = Class.all[0]
  pc.connectionState = 'failed'
  pc.onconnectionstatechange({})
  assert.equal(a.closes, 1)
})

test('a channel that reports an error ends the stream with one', async () => {
  const Class = fakeRtc()
  const { a } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const errors = []
  a.socket.on('error', error => errors.push(error.message))
  Class.all[0].channel.onerror({})
  assert.deepEqual(errors, ['the data channel failed'])
  assert.equal(a.closes, 1)
})

test('a text message ends the stream with an error', async () => {
  const Class = fakeRtc()
  const { a, b } = await pair(rtcLinks({ RTCPeerConnection: Class }))
  const errors = []
  b.socket.on('error', error => errors.push(error.message))
  Class.all[0].channel.send('text')
  await settle()
  assert.deepEqual(errors, ['a message that is not bytes'])
  assert.equal(b.closes, 1)
  assert.equal(a.closes, 1)
})

test('an answer the class refuses rejects accept() and closes the link', async () => {
  const links = rtcLinks({ RTCPeerConnection: fakeRtc() })
  const offer = await links.offer()
  let closes = 0
  offer.link.onclose = () => closes++
  await assert.rejects(offer.link.accept('v=0\r\na=fake:999999\r\n'), /no such description/)
  assert.equal(closes, 1)
})

test('an offer the class refuses rejects answer(), and the attempt leaves no connection open', async () => {
  const Class = fakeRtc()
  await assert.rejects(rtcLinks({ RTCPeerConnection: Class }).answer('v=0\r\na=fake:999999\r\n'), /no such description/)
  const [pc] = Class.all
  assert.deepEqual(handlersOf(pc), [])
  await reached('the connection closed', () => pc.closed)
})

test('a constructor that throws, whatever it throws, is LinksFull, for an offer and for an answer', async () => {
  const Typed = class { constructor() { throw new TypeError('not a constructor here') } }
  for (const RTCPeerConnection of [fakeRtc({ capacity: 0 }), Typed]) {
    const links = rtcLinks({ RTCPeerConnection })
    await assert.rejects(links.offer(), LinksFull)
    await assert.rejects(links.answer('v=0\r\na=fake:1\r\n'), LinksFull)
  }
})

const NOW = 1_700_000_000_000

/** The timers and the clock under the case's hand: the in-memory class reads the clock the links read. */
const clocked = t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })

/** How long after its last signalling step each connection was closed, null for one still open. */
const closedAfter = Class => Class.all.map(pc => pc.closed ? pc.closedAt - pc.steppedAt : null)

const REFUSED = 'v=0\r\na=fake:999999\r\n'

// Each ends one or two links in the same millisecond as their last signalling step.
const ENDINGS = {
  'close() on an offer nobody answered': async links => (await links.offer()).link.close(),
  'an offer the class refuses': links => links.answer(REFUSED).catch(() => {}),
  'an answer the class refuses': async links => (await links.offer()).link.accept(REFUSED).catch(() => {}),
  'close() on an open link, and the remote’s close at the other end': async links => (await pair(links)).a.link.close(),
  'the reader destroying its stream': async links => (await pair(links)).a.socket.destroy(),
  'the connection failing': async (links, Class) => {
    await pair(links)
    Class.all[0].connectionState = 'failed'
    Class.all[0].onconnectionstatechange({})
  },
  'the channel reporting an error': async (links, Class) => {
    await pair(links)
    Class.all[0].channel.onerror({})
  },
  'a message that is not bytes': async (links, Class) => {
    await pair(links)
    Class.all[0].channel.send('text')
  },
}

for (const [name, end] of Object.entries(ENDINGS)) {
  test(`a connection is closed 5 ms after its last signalling step and no sooner, when its link ends by ${name}`, async t => {
    clocked(t)
    const Class = fakeRtc()
    await end(rtcLinks({ RTCPeerConnection: Class }), Class)
    await settle()
    const none = Class.all.map(() => null)
    assert.deepEqual(closedAfter(Class), none, 'not in the task its link ended in')
    t.mock.timers.tick(4)
    await settle()
    assert.deepEqual(closedAfter(Class), none, 'not 4 ms later')
    t.mock.timers.tick(1)
    await settle()
    assert.deepEqual(closedAfter(Class), Class.all.map(() => 5))
    assert.equal(Class.stats.early, 0)
  })
}

// Each step takes 6 ms here, so the step before the failing one is more than 5 ms old when the link ends:
// what counts is the step that failed.
const FAILING = [
  ['offer', 'createOffer'], ['offer', 'setLocalDescription'],
  ['answer', 'setRemoteDescription'], ['answer', 'createAnswer'], ['answer', 'setLocalDescription'],
  ['accept', 'setRemoteDescription'],
]

for (const [call, fails] of FAILING) {
  test(`${call}() whose ${fails} fails closes its connection 5 ms after that step settled`, async t => {
    clocked(t)
    const Class = fakeRtc({ stepMs: 6, fails })
    const links = rtcLinks({ RTCPeerConnection: Class })
    const remote = rtcLinks({ RTCPeerConnection: fakeRtc() })
    let rejected = false
    const refused = () => { rejected = true }
    if (call === 'answer') links.answer((await remote.offer()).sdp).catch(refused)
    else {
      const made = links.offer()
      made.catch(refused)
      if (call === 'accept') {
        await advance(t, 12, 1)
        const { sdp, link } = await made
        link.accept((await remote.answer(sdp)).sdp).catch(refused)
      }
    }
    const [pc] = Class.all
    // Counted: 40 ms is more than any of these takes, and a connection that never closes fails the case below.
    for (let ms = 0; ms < 40 && !pc.closed; ms++) await advance(t, 1, 1)
    assert.equal(rejected, true)
    assert.deepEqual(closedAfter(Class), [5])
    assert.equal(Class.stats.early, 0)
  })
}

test('a link that ends more than 5 ms after its last signalling step closes its connection at once', async t => {
  clocked(t)
  const Class = fakeRtc()
  const links = rtcLinks({ RTCPeerConnection: Class })
  const [first, second] = [await links.offer(), await links.offer()]
  t.mock.timers.tick(5)
  first.link.close()
  assert.deepEqual(closedAfter(Class), [null, null], 'at 5 ms it still waits')
  t.mock.timers.tick(1)
  second.link.close()
  assert.deepEqual(closedAfter(Class), [null, 6])
  t.mock.timers.tick(4)
  assert.deepEqual(closedAfter(Class), [10, 6])
  assert.equal(Class.stats.early, 0)
})

test('a link closed while a signalling step is in flight closes its connection 5 ms after that step settled', async t => {
  clocked(t)
  const Class = fakeRtc({ stepMs: 3 })
  let offer = null
  rtcLinks({ RTCPeerConnection: Class }).offer().then(made => { offer = made })
  await advance(t, 6, 1)
  await settle()
  const answer = await rtcLinks({ RTCPeerConnection: fakeRtc() }).answer(offer.sdp)
  const [pc] = Class.all

  // Applying the answer takes 3 ms, and the link is closed 1 ms into it.
  offer.link.accept(answer.sdp).catch(() => {})
  await advance(t, 1, 1)
  assert.equal(pc.stepping, 1)
  offer.link.close()
  await advance(t, 6, 1)
  assert.equal(pc.closed, false, 'not while the step was in flight, and not 4 ms after it settled')
  await advance(t, 1, 1)
  assert.deepEqual(closedAfter(Class), [5])
  assert.equal(Class.stats.early, 0)
})

test('accept() on a closed link rejects and takes no signalling step, so the close keeps its time', async t => {
  clocked(t)
  const Class = fakeRtc()
  const offer = await rtcLinks({ RTCPeerConnection: Class }).offer()
  const answer = await rtcLinks({ RTCPeerConnection: fakeRtc() }).answer(offer.sdp)
  offer.link.close()
  t.mock.timers.tick(3)
  await assert.rejects(offer.link.accept(answer.sdp), /the link is closed/)
  t.mock.timers.tick(2)
  assert.deepEqual(closedAfter(Class), [5])
  assert.equal(Class.stats.early, 0)
})

test('the remote address is the selected pair’s where the class has one, else undefined', async () => {
  const links = rtcLinks({ RTCPeerConnection: fakeRtc({ address: '192.0.2.7' }) })
  const { a, b } = await pair(links)
  assert.equal(links.remoteAddress(a.link), '192.0.2.7')
  assert.equal(links.remoteAddress(b.link), '192.0.2.7')
  assert.equal(links.remoteAddress({}), undefined)

  const Bare = fakeRtc()
  const bare = rtcLinks({ RTCPeerConnection: class extends Bare { get sctp() { return null } set sctp(_) {} } })
  const other = await pair(bare)
  assert.equal(bare.remoteAddress(other.a.link), undefined)
})

test('the ICE servers reach the class as they were given, and none are added', async () => {
  const Class = fakeRtc()
  await rtcLinks({ RTCPeerConnection: Class }).offer()
  await rtcLinks({ RTCPeerConnection: Class, iceServers: [{ urls: 'stun:stun.test:3478' }] }).offer()
  assert.deepEqual(Class.all.map(pc => pc.configuration), [
    { iceServers: [] },
    { iceServers: [{ urls: 'stun:stun.test:3478' }] },
  ])
})

const native = await import('node-datachannel/polyfill').then(module => module.RTCPeerConnection, () => null)

test('libdatachannel: both ends open, 2 MiB cross each way intact, early bytes are kept, close reaches the remote', { skip: !native && 'node-datachannel did not load' }, async () => {
  const links = rtcLinks({ RTCPeerConnection: native, iceServers: [] })
  const started = Date.now()
  const offer = await links.offer()
  const answer = await links.answer(offer.sdp)
  const sides = { a: { link: offer.link, closes: 0 }, b: { link: answer.link, closes: 0 } }
  const opened = Object.values(sides).map(side => new Promise(resolve => {
    side.link.onclose = () => side.closes++
    side.link.onopen = socket => {
      side.socket = socket
      socket.write(Buffer.from('BitTorrent protocol'))
      resolve()
    }
  }))
  await offer.link.accept(answer.sdp)
  await within('both ends open', Promise.all(opened), 10_000)
  const openedMs = Date.now() - started
  const { a, b } = sides

  await new Promise(resolve => setTimeout(resolve, 200))
  const [atA, atB] = [reading(a.socket), reading(b.socket)]
  assert.equal(atA.bytes.toString(), 'BitTorrent protocol')
  assert.equal(atB.bytes.toString(), 'BitTorrent protocol')

  const [fromA, fromB] = [crypto.randomBytes(2 * MIB), crypto.randomBytes(2 * MIB)]
  await Promise.all([writeAll(a.socket, fromA), writeAll(b.socket, fromB)])
  const deadline = Date.now() + 20_000
  while ((atA.length < fromB.length + 19 || atB.length < fromA.length + 19) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(Buffer.compare(atB.bytes.subarray(19), fromA), 0)
  assert.equal(Buffer.compare(atA.bytes.subarray(19), fromB), 0)
  // Whether an address was read, never the address: it is this machine's.
  console.log(`# libdatachannel pair: open in ${openedMs} ms, remote address ${links.remoteAddress(a.link) ? 'read' : 'not read'}`)

  a.link.close()
  const until2 = Date.now() + 10_000
  while (b.closes === 0 && Date.now() < until2) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(b.closes, 1)
  assert.equal(a.closes, 0)
})
