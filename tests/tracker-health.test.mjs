// A tracker row reads failed when its tracker fails, working when it answers, and not contacted when
// nobody asked it, on every kind of torrent and after a reannounce, a pause and a resume. Every
// tracker is on this machine, and the host lets nothing else out and looks no name up.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { startEngine, teardown, tempDir } from './rig/stream-engine.mjs'

const REASON = 'refused for this test'
const REFUSAL = `d14:failure reason${REASON.length}:${REASON}e`
const ANSWER = 'd8:intervali1800e5:peers0:e'

const v1 = () => `xt=urn:btih:${crypto.randomBytes(20).toString('hex')}`
const v2 = () => `xt=urn:btmh:1220${crypto.randomBytes(32).toString('hex')}`
const KINDS = [
  { kind: 'v1 only', xt: v1, slots: 1 },
  { kind: 'v2 only', xt: v2, slots: 1 },
  { kind: 'hybrid', xt: () => `${v1()}&${v2()}`, slots: 2 },
]

// libtorrent announces to a loopback http tracker only when its path is exactly /announce
const httpTracker = (defer, body) => new Promise((resolve) => {
  const tracker = { asked: 0, events: [] }
  const server = http.createServer((req, res) => {
    tracker.asked++
    tracker.events.push(/[?&]event=([a-z]+)/.exec(req.url)?.[1] ?? 'none')
    res.end(typeof body === 'function' ? body(req) : body)
  })
  defer(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1', () => resolve(Object.assign(tracker, { url: `http://127.0.0.1:${server.address().port}/announce` })))
})

const silentUdpTracker = (defer) => new Promise((resolve) => {
  const tracker = { asked: 0 }
  const socket = dgram.createSocket('udp4')
  socket.on('message', () => tracker.asked++)
  defer(() => socket.close())
  socket.bind(0, '127.0.0.1', () => resolve(Object.assign(tracker, { url: `udp://127.0.0.1:${socket.address().port}/announce` })))
})

const closedPort = () => new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

// the tracker rows once `settled` holds for them, or the last ones read after 10 s
const rowsWhen = async (session, handle, settled) => {
  const deadline = Date.now() + 10_000
  let rows = await session.trackers(handle)
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    rows = await session.trackers(handle)
  }
  return rows
}

// the hash an announce carries, as hex: its info_hash parameter is the 20 raw bytes, escaped
const infoHashOf = (req) => {
  const escaped = /[?&]info_hash=([^&]*)/.exec(req.url)[1]
  return Buffer.from(escaped.replace(/%(..)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('hex')
}

for (const { kind, xt, slots } of KINDS) {
  test(`${kind}: a tracker that fails reads failed with its reason, one that answers reads working`, async (t) => {
    const defer = teardown(t)
    const silent = await silentUdpTracker(defer)
    const refusing = await httpTracker(defer, REFUSAL)
    const closed = await closedPort()
    const closedUrl = `http://127.0.0.1:${closed}/announce`
    const answering = await httpTracker(defer, ANSWER)
    const unasked = await httpTracker(defer, ANSWER)

    const host = countingHost()
    const { session, running } = await startEngine(defer, tempDir(defer), { host })
    // A magnet puts each tracker in a tier of its own. libtorrent goes on to the next tier once the
    // one before has failed and stops at the first that answers, so the order decides who is asked.
    const urls = [silent.url, refusing.url, closedUrl, answering.url, unasked.url]
    const magnet = `magnet:?${xt()}&dn=${encodeURIComponent(kind)}${urls.map((url) => `&tr=${encodeURIComponent(url)}`).join('')}`
    const handle = await running(session.addMagnet(magnet, '/dl'))

    // reached only once every slot has failed at each tracker before it, the udp one timing out after 10 s
    await waitFor('every slot to reach the answering tracker', () => answering.asked >= slots, 40_000)
    const rows = await rowsWhen(session, handle, (list) => list.length === urls.length && list.every((r) => !r.updating) && list.find((r) => r.url === answering.url).verified)
    const row = (url) => rows.find((r) => r.url === url)
    const shown = JSON.stringify(rows.map(({ url, fails, message, verified }) => ({ url, fails, message, verified })))
    assert.equal(rows.length, urls.length, `the tracker list: ${shown}`)

    assert.ok(silent.asked > 0 && refusing.asked > 0 && host.connects.some((c) => c.port === closed), 'a failing tracker was never asked')
    for (const url of [silent.url, refusing.url, closedUrl]) {
      assert.ok(row(url).fails > 0, `${url} failed and reads ${row(url).fails} failures: ${shown}`)
      assert.notEqual(row(url).message, '', `${url} failed and reads no reason: ${shown}`)
    }
    assert.equal(row(refusing.url).message, REASON)

    assert.equal(row(answering.url).fails, 0, `the tracker that answered reads failures: ${shown}`)
    assert.equal(row(answering.url).verified, true)
    assert.equal(row(answering.url).message, '')

    assert.equal(unasked.asked, 0)
    assert.equal(row(unasked.url).fails, -1, `a tracker nobody asked reads as asked: ${shown}`)
  })
}

// A hybrid announces each of its two hashes on its own, so one tracker can answer one and refuse the other.
for (const answers of ['v1', 'v2']) {
  test(`hybrid: a tracker that answers only the ${answers} hash reads working`, async (t) => {
    const defer = teardown(t)
    const v1hex = crypto.randomBytes(20).toString('hex')
    const hashes = new Set()
    const tracker = await httpTracker(defer, (req) => {
      const hash = infoHashOf(req)
      hashes.add(hash)
      return (hash === v1hex) === (answers === 'v1') ? ANSWER : REFUSAL
    })
    const { session, running } = await startEngine(defer, tempDir(defer), { host: countingHost() })
    const handle = await running(session.addMagnet(`magnet:?xt=urn:btih:${v1hex}&${v2()}&tr=${encodeURIComponent(tracker.url)}`, '/dl'))

    await waitFor('both hashes to be announced', () => hashes.size === 2, 20_000)
    const [row] = await rowsWhen(session, handle, ([r]) => r && !r.updating)
    assert.equal(row.fails, 0, `answered the ${answers} hash and reads ${row.fails} failures: ${row.message}`)
    assert.equal(row.verified, true)
  })
}

// A forced reannounce gives every tracker a slot, asked or not, and a resume clears what libtorrent
// knows of the started announces. The reannounce asks the refusing tracker again at once, and the
// answering one only after its min interval, so the refusing one is what shows it has run.
for (const { kind, xt, slots } of KINDS) {
  test(`${kind}: a tracker nobody asked reads not contacted after a reannounce, a pause and a resume`, async (t) => {
    const defer = teardown(t)
    const refusing = await httpTracker(defer, REFUSAL)
    const answering = await httpTracker(defer, ANSWER)
    const unasked = await httpTracker(defer, ANSWER)
    const { session, running } = await startEngine(defer, tempDir(defer), { host: countingHost() })
    const urls = [refusing.url, answering.url, unasked.url]
    const handle = await running(session.addMagnet(`magnet:?${xt()}${urls.map((url) => `&tr=${encodeURIComponent(url)}`).join('')}`, '/dl'))
    const events = (name) => answering.events.filter((event) => event === name).length

    const check = async (step) => {
      const rows = await rowsWhen(session, handle, (list) => list.length === urls.length && list.every((r) => !r.updating))
      const row = (url) => rows.find((r) => r.url === url)
      const shown = JSON.stringify(rows.map(({ url, fails, verified }) => ({ url, fails, verified })))
      assert.ok(row(refusing.url).fails > 0, `${step}: the refusing tracker reads ${row(refusing.url).fails} failures: ${shown}`)
      assert.equal(row(answering.url).fails, 0, `${step}: the tracker that answered reads failures: ${shown}`)
      assert.equal(row(answering.url).verified, true, `${step}: ${shown}`)
      assert.equal(unasked.asked, 0, `${step}: the tracker after the answering one was asked`)
      assert.equal(row(unasked.url).fails, -1, `${step}: a tracker nobody asked reads as asked: ${shown}`)
    }

    await waitFor('every slot to reach the answering tracker', () => events('started') >= slots)
    await check('added')

    const refused = refusing.asked
    session.forceReannounce(handle)
    await waitFor('the reannounce', () => refusing.asked >= refused + slots)
    await check('reannounced')

    session.pauseTorrent(handle)
    await waitFor('the stopped announces', () => events('stopped') >= slots)
    await check('paused')

    session.resumeTorrent(handle)
    await waitFor('the started announces again', () => events('started') >= 2 * slots)
    await check('resumed')
  })
}
