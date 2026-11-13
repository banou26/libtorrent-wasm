// Session.addPeerStream against the real engine: a stream a caller opened (a data channel, in a
// browser) becomes a peer when libtorrent dials an address the engine made up for it. The streams
// here are in-memory pipes, so nothing native is needed and nothing leaves the process.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { PEER_FLAG, Session } from '../build/index.js'
import { countingHost, inStreamRange } from './rig/counting-host.mjs'
import { magnetFor } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'
import { MiB, done, fixture, savedSha256, startEngine, startSeeder, teardown, tempDir } from './rig/stream-engine.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const magnetOf = (byte) => `magnet:?xt=urn:btih:${byte.toString(16).padStart(2, '0').repeat(20)}`

test('two engines on one stream move a torrent from a magnet, each dialling its end within 2 s', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, 8 * MiB)
  const seeder = await startSeeder(defer, fx)
  const leech = await startEngine(defer, path.join(fx.root, 'leech'))
  const handle = await leech.running(leech.session.addMagnet(magnetFor(fx.meta.infoHash, fx.meta.name), '/dl'))

  const [a, b] = streamPipe()
  const handedOver = performance.now()
  const seederEnd = seeder.session.addPeerStream(seeder.handle, a)
  const leechEnd = leech.session.addPeerStream(handle, b)
  for (const end of [seederEnd, leechEnd]) {
    assert.ok(inStreamRange(end.address), `${end.address} is outside 100.64.0.0/10`)
    assert.equal(end.port, 6881)
  }

  await waitFor('the download', () => done(leech.session, handle), 60_000)
  assert.equal(savedSha256(leech, handle), fx.sha256)
  // both ends dial, so neither waits for the other's handshake
  for (const [name, end] of [['seeder', a], ['leech', b]]) {
    const ms = end.dialledAt - handedOver
    assert.ok(ms < 2000, `the ${name} dialled its end ${Math.round(ms)} ms after addPeerStream`)
  }
  assert.ok(a.written > fx.meta.size, 'the seeder did not send the torrent over the stream')
})

test('a session with a stream peer and a loopback tcp peer never hands its host a stream address', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, 8 * MiB)
  const block = (piece, offset, length) => fx.bytes.subarray(piece * fx.meta.pieceLength + offset, piece * fx.meta.pieceLength + offset + length)
  const seeder = await startSeeder(defer, fx)
  const host = countingHost()
  const leech = await startEngine(defer, path.join(fx.root, 'leech'), { host, reserveListenPort: true })
  const { session } = leech
  // every address the shim asks the session's table for, which is every dial into the range
  const asked = []
  const take = session.mod.fkn.takeStream
  session.mod.fkn.takeStream = (address) => { asked.push(address); return take(address) }
  // a stream address with nothing behind it, as a peer or an old magnet could name one
  const STALE = '100.64.1.2'
  const handle = await leech.running(session.addMagnet(magnetFor(fx.meta.infoHash, fx.meta.name, [{ host: STALE, port: 6881 }]), '/dl'))

  // paced, so the tcp peer is asked for its share
  const [a, b] = streamPipe({ bytesPerSecond: 2 * MiB })
  seeder.session.addPeerStream(seeder.handle, a)
  const { address } = session.addPeerStream(handle, b)
  await waitFor('the metadata, over the stream', () => session.files(handle))

  // the ordinary peer dials the session's listener, and holds its blocks until the peer list is read
  let serving = false
  const tcpSeed = new ScriptedPeer({
    infoHash: fx.meta.infoHash,
    port: session.reachable().port,
    serve: (piece, offset, length) => (serving ? block(piece, offset, length) : null),
  })
  defer(() => tcpSeed.close())
  await waitFor('the listener', () => session.reachable().listening.tcp)
  await tcpSeed.connect()
  await waitFor('a request to the tcp peer', () => tcpSeed.requests.length > 0)

  const peers = await session.peers(handle)
  assert.deepEqual(peers.filter((p) => /^100\./.test(p.endpoint)), [], 'a made-up address is shown as a peer address')
  const connected = peers.filter((p) => !(p.flags & PEER_FLAG.connecting))
  const webrtc = connected.filter((p) => p.transport === 'webrtc')
  assert.equal(webrtc.length, 1, `stream peers in ${JSON.stringify(connected.map((p) => [p.endpoint, p.transport]))}`)
  assert.match(webrtc[0].endpoint, /^webrtc:\d+$/)
  const tcp = connected.filter((p) => p.transport === 'tcp')
  assert.equal(tcp.length, 1)
  assert.match(tcp[0].endpoint, /^127\.0\.0\.1:\d+$/)

  serving = true
  for (const r of tcpSeed.requests.slice()) tcpSeed.send(r.piece, r.offset, block(r.piece, r.offset, r.length))
  await waitFor('the download', () => done(session, handle), 60_000)
  assert.equal(savedSha256(leech, handle), fx.sha256)
  assert.ok(b.received > MiB, `the stream peer delivered ${b.received} bytes`)

  // libtorrent tries the stale address over uTP first, then dials it
  await waitFor('the dial of the stale address', () => asked.includes(STALE), 30_000)
  assert.deepEqual(asked.filter((x) => x !== STALE), [address], 'the stream was dialled once, and answered from the table')
  assert.deepEqual(host.connects.filter((c) => inStreamRange(c.address)), [], 'a connect to the stream range reached the host')
  assert.deepEqual(host.datagrams.filter((d) => inStreamRange(d.address)), [], 'a datagram to the stream range reached the host')
  const dropped = session.mod.__FKN.stats.sendto - host.datagrams.length
  assert.ok(dropped >= 1, 'no datagram was ever sent toward the stale address, so the count above proves nothing')
  assert.equal(session.reachable().inbound, 1, 'only the tcp peer dialled in')
})

test('a stream libtorrent does not dial is destroyed after 10 s, and one for a torrent the engine does not hold at once', async (t) => {
  const defer = teardown(t)
  const { session, running } = await startEngine(defer, tempDir(defer))

  const paused = await running(session.addMagnet(magnetOf(0xa1), '/dl'))
  session.pauseTorrent(paused)
  await waitFor('the pause', () => session.status(paused)?.paused)
  const [held, remote] = streamPipe()
  let remoteClosed = false
  remote.on('close', () => { remoteClosed = true })
  const handedOver = performance.now()
  session.addPeerStream(paused, held)

  const removed = await running(session.addMagnet(magnetOf(0xb2), '/dl'))
  session.removeTorrent(removed)
  const [gone] = streamPipe()
  session.addPeerStream(removed, gone)
  assert.ok(gone.destroyed, 'the stream of a removed torrent was left open')
  assert.match(gone.destroyError.message, /no torrent/)

  // a torrent the engine has added and the caller has not pumped an alert for yet is not that case
  const fresh = session.addMagnet(magnetOf(0xd4), '/dl')
  for (let i = 0; i < 10; i++) session.tick()
  const [early] = streamPipe()
  session.addPeerStream(fresh, early)
  assert.equal(early.destroyed, false, `destroyed at once: ${early.destroyError?.message}`)

  await sleep(5000)
  assert.equal(held.destroyed, false, 'destroyed long before its 10 s were up')
  await waitFor('the deadline', () => held.destroyed, 8000)
  const ms = performance.now() - handedOver
  assert.ok(ms > 9500 && ms < 11_500, `destroyed after ${Math.round(ms)} ms`)
  assert.match(held.destroyError.message, /did not dial/)
  assert.equal(held.dialledAt, null, 'a paused torrent dialled its stream')
  await waitFor('the remote end to see the stream close', () => remoteClosed)
})

test('destroying the session destroys the streams it still holds', async (t) => {
  const defer = teardown(t)
  const { session, running } = await startEngine(defer, tempDir(defer))
  const paused = await running(session.addMagnet(magnetOf(0xc3), '/dl'))
  session.pauseTorrent(paused)
  await waitFor('the pause', () => session.status(paused)?.paused)
  const [held] = streamPipe()
  session.addPeerStream(paused, held)
  session.destroy()
  assert.ok(held.destroyed, 'the stream outlived its session')
  assert.match(held.destroyError.message, /session was destroyed/)
})

const TEXT_ALERT = 66
const REC_PEERS = 0xf0000005

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b }
const str = (text) => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)])

/**
 * A Session over a module that is nothing but an alert stream: `records` are [type, body] pairs,
 * laid out as the wrapper lays them out (u32 type, u32 length, body) and read by one popAlerts().
 */
const sessionOver = (t, records, mod = {}) => {
  const heap = new Uint8Array(4096)
  let size = 0
  for (const [type, body] of records) {
    heap.set(Buffer.concat([u32(type), u32(body.length), body]), size)
    size += 8 + body.length
  }
  const session = new Session({
    HEAPU8: heap,
    UTF8ToString: (ptr, length) => Buffer.from(heap.subarray(ptr, ptr + length)).toString(),
    _lt_session_create: () => 0,
    _lt_session_destroy: () => {},
    _lt_session_tick: () => {},
    _lt_session_pump_alerts: () => {},
    _lt_alerts_size: () => size,
    _lt_alerts_data: () => 0,
    _lt_alerts_clear: () => { size = 0 },
    ...mod,
  }, { tickIntervalMs: 1 << 30 })
  t.after(() => session.destroy())
  return session
}

test('a connection from a stream address is not counted as inbound', (t) => {
  const session = sessionOver(t, [
    [TEXT_ALERT, Buffer.from('incoming connection from 100.64.3.9:6881 (TCP)')],
    [TEXT_ALERT, Buffer.from('incoming connection from 192.0.2.7:51413 (uTP)')],
  ])
  session.popAlerts()
  const reach = session.reachable()
  assert.equal(reach.inbound, 1)
  assert.deepEqual(reach.inboundByTransport, { utp: 1 })
  assert.equal(reach.lastInbound.endpoint, '192.0.2.7:51413')
})

test('the peer list says what carries each peer, and hides an address only inside 100.64.0.0/10', (t) => {
  // a peer row as the wrapper writes it: endpoint, client, flags, then 60 bytes of counters
  const row = (endpoint, flags = 0) => Buffer.concat([str(endpoint), str('client'), u32(flags), Buffer.alloc(60)])
  const rows = [
    row('192.0.2.7:51413'),
    row('198.51.100.9:6881', PEER_FLAG.utpSocket),
    // the address before the range, its first, its last, and the address after it
    row('100.63.255.255:6881'),
    row('100.64.0.0:6881'),
    row('100.127.255.255:6881'),
    row('100.128.0.0:6881'),
  ]
  const HANDLE = 7
  const session = sessionOver(t, [[REC_PEERS, Buffer.concat([u32(HANDLE), u32(rows.length), ...rows])]])
  session.popAlerts()
  assert.deepEqual(session.lastPeers(HANDLE).map((p) => [p.endpoint, p.transport]), [
    ['192.0.2.7:51413', 'tcp'],
    ['198.51.100.9:6881', 'utp'],
    ['100.63.255.255:6881', 'tcp'],
    ['webrtc:0', 'webrtc'],
    ['webrtc:4194303', 'webrtc'],
    ['100.128.0.0:6881', 'tcp'],
  ])
})

test('a stream answers one dial: a later dial of its address finds nothing', (t) => {
  const fkn = {}
  const session = sessionOver(t, [], { fkn, _lt_torrent_add_channel_peer: () => 0 })
  const [ours] = streamPipe()
  const { address } = session.addPeerStream(1, ours)
  assert.equal(fkn.takeStream(address), ours)
  // libtorrent dials a peer again about a minute after its stream closed
  assert.equal(fkn.takeStream(address), undefined, 'a second dial was answered with a stream that had been handed over')
})
