// The two halves of the page links, across real MessagePorts: servePeerLinks where the peer connections are
// made, pageLinks where the engine is. Most cases run both halves in this thread with a tap on each port; the
// last runs the page half in a thread of its own with its timers taken away.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import v8 from 'node:v8'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'

import { LinksFull, pageLinks, rtcLinks } from '../../build/webtorrent/index.js'
import { servePeerLinks } from '../../build/webtorrent/page.js'
import { advance, fakeRtc, handlersOf, pair, reached, reading, settle, until, within, writeAll } from './fakes.mjs'

// The collector on demand, without a flag on the command line.
v8.setFlagsFromString('--expose-gc')
const collect = vm.runInNewContext('gc')

const KIB = 1024
const MIB = 1024 * KIB

/**
 * A port that counts what it carries each way: the bytes, and the messages of each kind it `said` and `heard`.
 * `queued` is what was posted as data and not acknowledged yet.
 */
const tap = port => {
  const stats = { dataOut: 0, ackIn: 0, dataIn: 0, maxQueued: 0, maxData: 0, oninput: null, said: {}, heard: {} }
  const count = (kinds, kind) => { kinds[kind] = (kinds[kind] ?? 0) + 1 }
  return {
    stats,
    get onmessage() { return port.onmessage },
    set onmessage(listener) {
      port.onmessage = listener && (event => {
        count(stats.heard, event.data.t)
        if (event.data.t === 'data') stats.dataIn += event.data.bytes.byteLength
        if (event.data.t === 'ack') stats.ackIn += event.data.bytes
        stats.oninput?.()
        listener(event)
      })
    },
    postMessage(message, transfer) {
      count(stats.said, message.t)
      if (message.t === 'data') {
        stats.dataOut += message.bytes.byteLength
        stats.maxData = Math.max(stats.maxData, message.bytes.byteLength)
        stats.maxQueued = Math.max(stats.maxQueued, stats.dataOut - stats.ackIn)
      }
      port.postMessage(message, transfer)
    },
  }
}

/** One page and its worker: `links` is what the worker holds, `page` and `worker` are the taps. */
const half = (t, RTCPeerConnection) => {
  const { port1, port2 } = new MessageChannel()
  const page = tap(port1)
  const worker = tap(port2)
  const stop = servePeerLinks(page, { RTCPeerConnection })
  t.after(() => {
    stop()
    port1.close()
    port2.close()
  })
  return { links: pageLinks(worker), page: page.stats, worker: worker.stats, stop }
}

test('an offer, its answer and the accept cross the port, both ends open, and bytes cross both ways intact', async t => {
  const Class = fakeRtc()
  const sender = half(t, Class)
  const { a, b } = await pair(sender.links, half(t, Class).links)
  const [fromA, fromB] = [crypto.randomBytes(700 * KIB + 3), crypto.randomBytes(300 * KIB)]
  const [atA, atB] = [reading(a.socket), reading(b.socket)]
  await Promise.all([writeAll(a.socket, fromA), writeAll(b.socket, fromB)])
  await until('everything arrived', () => atB.length === fromA.length && atA.length === fromB.length)
  assert.equal(Buffer.compare(atB.bytes, fromA), 0)
  assert.equal(Buffer.compare(atA.bytes, fromB), 0)
  assert.equal(Class.stats.maxMessage, 16 * KIB)
  assert.equal(sender.worker.maxData, 16 * KIB, 'a write crosses the port in 16 KiB slices')
  assert.equal(a.socket.backpressure, true)
  assert.equal('maxRecvQueue' in a.socket, false)
})

test('what the remote sent before the worker read the stream is kept and delivered in order', async t => {
  const Class = fakeRtc()
  const [one, two] = [half(t, Class).links, half(t, Class).links]
  const offer = await one.offer()
  const answer = await two.answer(offer.sdp)
  const streams = []
  for (const link of [offer.link, answer.link]) {
    link.onopen = socket => {
      streams.push(socket)
      socket.write(Buffer.from('BitTorrent protocol'))
    }
  }
  await offer.link.accept(answer.sdp)
  await until('both opened', () => streams.length === 2)
  await settle(40)
  assert.equal(Class.stats.lost, 0)
  for (const socket of streams) assert.equal(reading(socket).bytes.toString(), 'BitTorrent protocol')
})

test('a fast writer behind a slow channel: the worker queue, the page queue and the channel all stay bounded', async t => {
  const Class = fakeRtc({ rate: 48 * KIB })
  const sender = half(t, Class)
  const { a, b } = await pair(sender.links, half(t, Class).links)
  let pageQueue = 0
  sender.page.oninput = () => { pageQueue = Math.max(pageQueue, sender.page.dataIn - Class.stats.sent) }

  const sent = crypto.randomBytes(8 * MIB)
  const got = reading(b.socket)
  const { waits } = await writeAll(a.socket, sent)
  await until('everything arrived', () => got.length === sent.length, 20_000)

  assert.ok(waits > 0, 'the writer was told to wait')
  const bound = MIB + 256 * KIB
  assert.ok(sender.worker.maxQueued <= bound, `the worker had ${sender.worker.maxQueued} bytes posted and not passed on`)
  assert.ok(sender.worker.maxQueued >= MIB, 'and it filled to the mark')
  assert.ok(pageQueue <= bound, `the page held ${pageQueue} bytes the channel had not taken`)
  assert.ok(Class.stats.maxBuffered <= MIB + 16 * KIB, `the channel held ${Class.stats.maxBuffered}`)
  assert.equal(Buffer.compare(got.bytes, sent), 0)
  console.log(`# 8 MiB behind a 48 KiB a task channel: worker queue ${sender.worker.maxQueued}, page queue ${pageQueue}, channel ${Class.stats.maxBuffered}, ${waits} waits`)
})

test('a slow writer on a fast channel is never told to wait and nothing queues', async t => {
  const Class = fakeRtc()
  const sender = half(t, Class)
  const { a, b } = await pair(sender.links, half(t, Class).links)
  const got = reading(b.socket)
  let refused = 0
  for (let i = 0; i < 64; i++) {
    if (!a.socket.write(crypto.randomBytes(32 * KIB))) refused++
    await settle(6)
  }
  await until('everything arrived', () => got.length === 64 * 32 * KIB)
  assert.equal(refused, 0)
  assert.ok(sender.worker.maxQueued <= 32 * KIB, `at most one write was in flight, saw ${sender.worker.maxQueued}`)
})

test('a fast remote in front of a worker that keeps up: every byte is acknowledged, so 34 MiB cross one link', async t => {
  const Class = fakeRtc()
  const receiver = half(t, Class)
  const { a, b } = await pair(half(t, Class).links, receiver.links)
  const got = reading(b.socket)
  const sent = crypto.randomBytes(34 * MIB)
  await writeAll(a.socket, sent)
  await until('everything arrived', () => got.length === sent.length || b.closes > 0, 80_000)
  assert.equal(b.closes, 0, 'the link is not given up: nothing was left untaken')
  assert.equal(Buffer.compare(got.bytes, sent), 0)
  assert.equal(receiver.page.dataOut, sent.length)
  await until('the last acknowledgement', () => receiver.page.ackIn === sent.length)
})

test('a worker that falls 32 MiB behind loses the link, so the page never holds more', async t => {
  const Class = fakeRtc()
  const { port1, port2 } = new MessageChannel()
  t.after(() => {
    port1.close()
    port2.close()
  })
  const page = tap(port1)
  servePeerLinks(page, { RTCPeerConnection: Class })
  // A worker that asks for an offer and then never reads its port again.
  let offer = null
  port2.onmessage = ({ data }) => { if (data.t === 'sdp') offer = data.sdp }
  port2.postMessage({ t: 'offer', id: 0 })
  await until('the page gathered', () => Class.all[0]?.iceGatheringState === 'complete')
  port2.postMessage({ t: 'flush', id: 0 })
  await until('the offer came back', () => offer !== null)

  const remote = rtcLinks({ RTCPeerConnection: Class })
  const answer = await remote.answer(offer)
  let closes = 0
  let socket = null
  answer.link.onopen = opened => { socket = opened }
  answer.link.onclose = () => closes++
  port2.postMessage({ t: 'accept', id: 0, sdp: answer.sdp })
  await until('the remote opened', () => socket !== null)

  const block = Buffer.alloc(MIB)
  for (let i = 0; i < 40 && closes === 0; i++) {
    await writeAll(socket, block)
    await settle(4)
  }
  await until('the page closed the link', () => closes === 1)
  assert.ok(page.stats.dataOut > 32 * MIB && page.stats.dataOut <= 34 * MIB, `the page forwarded ${page.stats.dataOut} bytes, then stopped`)
})

test('close crosses the port in both directions, and a closed link leaves nothing in the page', async t => {
  const Class = fakeRtc()
  const [one, two] = [half(t, Class), half(t, Class)]

  const first = await pair(one.links, two.links)
  const heard = []
  first.a.socket.on('close', () => heard.push('a closed'))
  first.b.socket.on('close', () => heard.push('b closed'))
  first.a.link.close()
  await until('the remote heard', () => first.b.closes === 1)
  await settle()
  assert.deepEqual(heard.sort(), ['a closed', 'b closed'])
  assert.equal(first.a.closes, 0, 'close() is silent toward its own caller')

  const second = await pair(one.links, two.links)
  second.a.socket.destroy()
  await until('both ends heard', () => second.a.closes === 1 && second.b.closes === 1)

  await settle()
  for (const pc of Class.all) {
    assert.equal(pc.closed, true)
    assert.deepEqual(handlersOf(pc), [])
  }
})

test('the page keeps no reference to a connection whose link ended, however it ended: each can be collected', async t => {
  const Class = fakeRtc()
  const Remote = fakeRtc()
  const made = []
  let ending = ''
  class Watched extends Class {
    constructor(configuration) {
      super(configuration)
      made.push({ ending, connection: new WeakRef(this) })
    }
  }
  const { links } = half(t, Watched)

  // Each ending in a function of its own, so that nothing of the link stays on this one's stack.
  const opened = async () => {
    const { a, b } = await pair(links, rtcLinks({ RTCPeerConnection: Remote }))
    return { ours: a.link, theirs: b.link }
  }
  const endings = {
    'the worker closed it while open': async () => (await opened()).ours.close(),
    'the remote closed it': async () => (await opened()).theirs.close(),
    'the worker closed it before it opened': async () => (await links.offer()).link.close(),
    'it could not be made': () => links.answer('v=0\r\na=fake:999999\r\n').catch(() => {}),
  }
  for (const [name, end] of Object.entries(endings)) {
    ending = name
    await end()
    await settle(40)
  }
  ending = 'held on purpose'
  const held = new Watched({ iceServers: [] })

  // The classes list their instances for the other cases: that is this file's reference, not the page's.
  Class.all.length = 0
  Remote.all.length = 0
  for (let i = 0; i < 6; i++) {
    await settle()
    collect()
  }
  const reachable = made.filter(({ connection }) => connection.deref()).map(({ ending }) => ending)
  assert.deepEqual(reachable, ['held on purpose'], 'and the check can tell: the one this case holds is still there')
  assert.equal(made.length, 5, 'one connection for each ending, and the one held')
  held.close()
})

test('a constructor the browser refuses reaches the worker as LinksFull', async t => {
  const { links } = half(t, fakeRtc({ capacity: 0 }))
  await assert.rejects(links.offer(), LinksFull)
  await assert.rejects(links.answer('v=0\r\na=fake:1\r\n'), LinksFull)
})

test('an answer the page cannot apply closes the link on the worker side', async t => {
  const { links } = half(t, fakeRtc())
  const offer = await links.offer()
  let closes = 0
  offer.link.onclose = () => closes++
  await offer.link.accept('v=0\r\na=fake:999999\r\n')
  await until('the worker heard', () => closes === 1)
})

test('the page says nothing of the remote address', async t => {
  const Class = fakeRtc({ address: '192.0.2.7' })
  const one = half(t, Class)
  const { a } = await pair(one.links, half(t, Class).links)
  assert.equal(one.links.remoteAddress(a.link), undefined)
})

test('stopping the page half closes every link it made', async t => {
  const Class = fakeRtc()
  const one = half(t, Class)
  const { b } = await pair(one.links, half(t, Class).links)
  one.stop()
  await until('the remote heard', () => b.closes === 1)
  assert.equal(Class.all.filter(pc => !pc.closed).length, 0)
})

test('the page says when gathering completes, so the worker waits for no timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { links } = half(t, fakeRtc())
  const { sdp, link } = await within('the offer', links.offer())
  assert.match(sdp, /typ host/)
  link.close()
})

test('the page says when it sees a reflexive candidate, and the worker reads the description 300 ms later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { links } = half(t, fakeRtc({ gathering: { reflexiveMs: 100 } }))
  let made = null
  links.offer().then(result => { made = result })
  await settle()
  await advance(t, 100, 1)
  await settle()
  await advance(t, 299, 1)
  await settle()
  assert.equal(made, null)
  await advance(t, 1, 1)
  await reached('the offer', () => made !== null)
  assert.match(made.sdp, /typ srflx/)
  made.link.close()
})

test('a flush that reaches the page before its connection can be waited on is kept, so a late page still answers', async t => {
  // A page so late that the worker's 3 s cap passes before the connection has its local description.
  let catchUp
  const late = new Promise(resolve => { catchUp = resolve })
  class Late extends fakeRtc({ gathering: {} }) {
    async setLocalDescription(description) {
      await late
      return super.setLocalDescription(description)
    }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const one = half(t, Late)
  let made = null
  one.links.offer().then(result => { made = result })
  await advance(t, 3000)
  await reached('the flush at the page', () => one.page.heard.flush === 1)
  catchUp()
  await reached('the offer', () => made !== null)
  made.link.close()
  await reached('the page closed its connection', () => Late.all.every(pc => pc.closed))
})

test('the gathering cap is the worker’s: a page with no timers still answers, 3 s after the request', async t => {
  const thread = new Worker(new URL('./page-thread.mjs', import.meta.url))
  t.after(() => thread.terminate())
  const said = () => new Promise(resolve => thread.once('message', resolve))
  await said()

  const channels = [new MessageChannel(), new MessageChannel()]
  t.after(() => channels.forEach(channel => channel.port2.close()))
  thread.postMessage({ ports: channels.map(channel => channel.port1) }, channels.map(channel => channel.port1))
  const [one, two] = channels.map(channel => pageLinks(channel.port2))

  // The thread needs wall time, not the mocked time of this one.
  const idle = async ms => {
    const start = performance.now()
    await reached('the wait', () => performance.now() - start >= ms, 10 * ms)
  }

  t.mock.timers.enable({ apis: ['setTimeout'] })
  let offer = null
  one.offer().then(made => { offer = made })
  // Long enough for the page thread to have gathered and to be waiting on the worker's word.
  await idle(300)
  await advance(t, 2999)
  assert.equal(offer, null, 'no description before the worker’s cap')
  await advance(t, 1)
  await reached('the offer', () => offer !== null, 10_000)

  let answer = null
  two.answer(offer.sdp).then(made => { answer = made })
  await idle(300)
  await advance(t, 3000)
  await reached('the answer', () => answer !== null, 10_000)

  const sockets = []
  offer.link.onopen = socket => sockets.push(socket)
  answer.link.onopen = socket => sockets.push(socket)
  await offer.link.accept(answer.sdp)
  await reached('both ends open', () => sockets.length === 2, 10_000)
  const got = reading(sockets[1])
  const sent = crypto.randomBytes(MIB)
  sockets[0].write(sent)
  await reached('the bytes', () => got.length === sent.length, 10_000)
  assert.equal(Buffer.compare(got.bytes, sent), 0)

  offer.link.close()
  let closes = 0
  answer.link.onclose = () => closes++
  await reached('the close', () => closes === 1, 10_000)

  thread.postMessage({ report: true })
  const report = await said()
  assert.deepEqual(report, { timers: [], made: 2, open: 0, handlers: 0 })
})
