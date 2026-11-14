// A tracker row reads failed when its tracker fails and working when it answers, on every kind of
// torrent. Every tracker is on this machine, and the host lets nothing else out and looks no name up.

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
  const tracker = { asked: 0 }
  const server = http.createServer((req, res) => { tracker.asked++; res.end(body) })
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

for (const { kind, xt, slots } of KINDS) {
  test(`${kind}: a tracker that fails reads failed with its reason, one that answers reads working`, async (t) => {
    const defer = teardown(t)
    const silent = await silentUdpTracker(defer)
    const refusing = await httpTracker(defer, `d14:failure reason${REASON.length}:${REASON}e`)
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
    let rows = []
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      rows = await session.trackers(handle)
      if (rows.length === urls.length && rows.every((r) => !r.updating) && rows.find((r) => r.url === answering.url).verified) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
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
