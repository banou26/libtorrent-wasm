// The relay mode whole, as a caller wires it, with nothing standing in for any part: the engine over a host
// with real sockets, the WebRTC entry's factory over one more UDP socket, and the swarm with `relay` over the
// entry's class, in the session that also holds ordinary peers. Everything is on loopback: a session is
// reached at 127.0.0.1, an ordinary peer at 127.0.0.2, and another WebRTC stack at 127.0.0.3, so the swarm
// can tell them apart by address as it does behind a relay.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createWebRTC } from '../../build/webrtc.js'
import { rtcLinks, webtorrentPeers } from '../../build/webtorrent/index.js'
import { countingHost } from '../rig/counting-host.mjs'
import { waitFor } from '../rig/peer-handshake.mjs'
import { MiB, dialTcp, fixture, savedSha256, startEngine, startSeeder, teardown, tempDir } from '../rig/stream-engine.mjs'
import { TRACKER, download, finished, magnetOf, routedWebSocket, seed, swarmOver } from './engine-swarm.mjs'
import { FakeSession, nativeRtc, referenceTracker, releaseNativeRtc } from './fakes.mjs'

after(releaseNativeRtc)

const wasm = new WebAssembly.Module(fs.readFileSync(new URL('../../build/webrtc.wasm', import.meta.url)))
const ORDINARY = '127.0.0.2'
const ELSEWHERE = '127.0.0.3'

/** The WebRTC entry's class over a UDP socket of its own at `address`, both closed with the test. */
const stackAt = async (defer, address) => {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve) => socket.bind(0, address, resolve))
  defer(() => new Promise((resolve) => socket.close(resolve)))
  // loopback is a private address: a relay's socket reaches none, this one reaches nothing else
  const webrtc = await createWebRTC({ socket, address, port: socket.address().port, wasm, allowPrivateCandidates: true })
  defer(() => webrtc.close())
  return webrtc.RTCPeerConnection
}

/** A session with real sockets, a listen port and the relay mode's swarm, its WebRTC socket at `address`. */
const relaySide = async (defer, dir, Routed, { address = '127.0.0.1', through = {} } = {}) => {
  const host = countingHost()
  const engine = await startEngine(defer, dir, { host, reserveListenPort: true })
  const RTCPeerConnection = await stackAt(defer, address)
  return { ...engine, host, ...swarmOver(defer, engine, { links: rtcLinks({ RTCPeerConnection }), WebSocket: Routed, relay: true }, through) }
}

/** A session that holds the whole fixture and serves it to ordinary peers alone, at `bytesPerSecond`. */
const ordinarySeed = async (defer, fx, bytesPerSecond) => {
  const seeder = await startSeeder(defer, fx, 'ordinary', { host: countingHost(), reserveListenPort: true })
  seeder.session.setRateLimits({ upload: bytesPerSecond })
  await waitFor('its listener', () => seeder.session.reachable().listening.tcp)
  return seeder
}

/**
 * A WebRTC peer that wants the fixture: the entry's class at `address` under a swarm, over a session that
 * reads each stream it is handed and says nothing. Its `streams` are those, with the bytes each brought.
 */
const leecherAt = async (defer, Routed, address, fx) => {
  const session = new FakeSession()
  session.add(1, { infoHash: fx.meta.infoHash, trackers: [TRACKER], left: fx.meta.size })
  const peers = webtorrentPeers(session, { links: rtcLinks({ RTCPeerConnection: await stackAt(defer, address) }), WebSocket: Routed })
  defer(() => peers.close())
  return { streams: session.streams, torrent: () => peers.snapshot().torrents[0], leave: () => peers.close() }
}

const begin = async (t) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) {
    t.skip('bittorrent-tracker is not installed')
    return null
  }
  return { defer, Routed: routedWebSocket(reference.url) }
}

test('two engines over real sockets, each with the WebRTC entry under its swarm, move a file each way', async (t) => {
  const rig = await begin(t)
  if (!rig) return
  const { defer, Routed } = rig
  const there = fixture(defer, 4 * MiB)
  const back = fixture(defer, 4 * MiB, undefined, 0x51f15eed)
  const a = await relaySide(defer, path.join(there.root, 'a'), Routed)
  const b = await relaySide(defer, path.join(there.root, 'b'), Routed)

  const seeded = await seed(a, there, 'there')
  const atB = await download(b, there, 'there', 30_000)
  assert.equal(savedSha256(b, atB.handle), there.sha256)
  // Two connections between one pair of the entry's sockets cannot be told apart, so the second torrent's
  // connects once the first's is gone, which two seeds see to themselves.
  await waitFor('the two seeds to let each other go', () => a.of(seeded)?.open === 0 && b.of(atB.handle)?.open === 0)
  await seed(b, back, 'back')
  const atA = await download(a, back, 'back', 30_000)
  assert.equal(savedSha256(a, atA.handle), back.sha256)

  // the sockets were there to use, and the channels are still what carried both files
  assert.deepEqual([atB.carriedBy, atA.carriedBy], [['webrtc'], ['webrtc']])
  assert.deepEqual([a.handed.length, b.handed.length], [2, 2])
  for (const end of [a, b]) {
    assert.deepEqual(end.host.connects, [], 'an engine dialled somebody over tcp')
    const { dropped, unmade, torrents } = end.peers.snapshot()
    assert.deepEqual([dropped, unmade, torrents.map((torrent) => torrent.silent)], [0, 0, [0, 0]])
  }
  assert.deepEqual([...new Set(Routed.opened)], [TRACKER])
})

test('with a session that takes no stream the same download never starts, real sockets or not', async (t) => {
  const rig = await begin(t)
  if (!rig) return
  const { defer, Routed } = rig
  const there = fixture(defer, 4 * MiB)
  const a = await relaySide(defer, path.join(there.root, 'a'), Routed)
  const b = await relaySide(defer, path.join(there.root, 'b'), Routed, { through: { cut: true } })
  await seed(a, there, 'there')
  // several times what the transfer takes when the stream is handed over
  await assert.rejects(download(b, there, 'there', 8000), /timed out after 8000ms waiting for the download/)
  assert.ok(b.handed.length >= 1, 'the swarm never had a channel to hand over')
  assert.equal(b.session.status(b.session.torrents()[0]).hasMetadata, false)
})

test('one session takes pieces of one torrent from an ordinary tcp peer and from a WebRTC peer', async (t) => {
  const rig = await begin(t)
  if (!rig) return
  const { defer, Routed } = rig
  const fx = fixture(defer, 8 * MiB)
  // each seed is held to a rate, so neither can serve the whole file before the other is asked
  const ordinary = await ordinarySeed(defer, fx, MiB)
  const rtc = await relaySide(defer, path.join(fx.root, 'rtc'), Routed)
  rtc.session.setRateLimits({ upload: MiB })
  await seed(rtc, fx, 'dl')

  const leech = await relaySide(defer, path.join(fx.root, 'leech'), Routed)
  const handle = await leech.running(leech.session.addMagnet(magnetOf(fx), '/dl'))
  dialTcp(leech.session, handle, ORDINARY, ordinary.session.reachable().port)
  const { delivered } = await finished(leech, handle, 40_000)

  assert.equal(savedSha256(leech, handle), fx.sha256)
  assert.deepEqual(Object.keys(delivered).sort(), ['tcp', 'webrtc'])
  for (const kind of ['tcp', 'webrtc']) assert.ok(delivered[kind] >= MiB, `the ${kind} peer delivered ${delivered[kind]} bytes of ${fx.meta.size}`)
  assert.deepEqual(leech.handed, [handle], 'the session was handed more than its one channel')
  assert.ok(leech.host.connects.length >= 1 && leech.host.connects.every((dial) => dial.address === ORDINARY), 'the session dialled somebody else')
})

test('a channel from an address that is, or was, an ordinary peer of the torrent is closed and never reaches libtorrent', async (t) => {
  const rig = await begin(t)
  if (!rig) return
  const { defer, Routed } = rig
  const fx = fixture(defer, 4 * MiB)
  // slow, so that the first channel arrives while the ordinary peer is still connected
  const ordinary = await ordinarySeed(defer, fx, 256 * 1024)
  const leech = await relaySide(defer, path.join(fx.root, 'leech'), Routed)
  const { session } = leech
  const handle = await leech.running(session.addMagnet(magnetOf(fx), '/dl'))
  dialTcp(session, handle, ORDINARY, ordinary.session.reachable().port)
  await waitFor('bytes from the ordinary peer', () => session.status(handle)?.totalDone > 0)

  /** A leecher at `address` has its channel with us open and end without a byte from us, and leaves the swarm. */
  const refused = async (address) => {
    const remote = await leecherAt(defer, Routed, address, fx)
    await waitFor('its channel to open and end', () => remote.torrent()?.silent === 1)
    assert.deepEqual(remote.streams.map((stream) => Buffer.concat(stream.bytes).length), [0])
    remote.leave()
  }

  // it is: the ordinary peer is connected, and a WebRTC peer shows up from its address
  await refused(ORDINARY)
  assert.ok((await session.peers(handle)).some((peer) => peer.endpoint.startsWith(`${ORDINARY}:`)), 'the ordinary peer had left already')
  assert.deepEqual(leech.handed, [])

  // it was: the download ends, the two seeds let each other go, and the address is still remembered
  ordinary.session.setRateLimits({ upload: 0 })
  await finished(leech, handle, 30_000)
  await waitFor('the ordinary peer to leave', () => {
    void session.peers(handle)
    return session.lastPeers(handle).length === 0
  })
  await refused(ORDINARY)
  assert.deepEqual(leech.handed, [])

  // a channel from any other address is handed over, and libtorrent speaks on it
  const other = await leecherAt(defer, Routed, ELSEWHERE, fx)
  await waitFor('the handshake of our engine', () => Buffer.concat(other.streams[0]?.bytes ?? []).length >= 68)
  assert.deepEqual(leech.handed, [handle])
  assert.equal(other.torrent().silent, 0)
  assert.equal(savedSha256(leech, handle), fx.sha256)
})

test('libdatachannel: an engine with the WebRTC entry and an engine with libdatachannel move a file each way', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  const rig = await begin(t)
  if (!rig) return
  const { defer, Routed } = rig
  // libdatachannel offers the addresses of this machine's interfaces, which a socket on loopback cannot reach
  class OnLoopback extends nativeRtc.RTCPeerConnection {
    constructor(configuration) {
      super({ ...configuration, bindAddress: ELSEWHERE })
    }
  }
  const there = fixture(defer, 4 * MiB)
  const back = fixture(defer, 4 * MiB, undefined, 0x51f15eed)
  const ours = await relaySide(defer, path.join(there.root, 'ours'), Routed)
  const engine = await startEngine(defer, path.join(there.root, 'theirs'))
  const theirs = { ...engine, ...swarmOver(defer, engine, { links: rtcLinks({ RTCPeerConnection: OnLoopback, iceServers: [] }), WebSocket: Routed }) }

  await seed(ours, there, 'there')
  const atTheirs = await download(theirs, there, 'there', 30_000)
  assert.equal(savedSha256(theirs, atTheirs.handle), there.sha256)
  await seed(theirs, back, 'back')
  const atOurs = await download(ours, back, 'back', 30_000)
  assert.equal(savedSha256(ours, atOurs.handle), back.sha256)
  assert.deepEqual([atTheirs.carriedBy, atOurs.carriedBy], [['webrtc'], ['webrtc']])
  assert.deepEqual(ours.handed.length, 2)
  assert.deepEqual(ours.peers.snapshot().torrents.map((torrent) => torrent.silent), [0, 0])
})

test('after a relay outage a swarm and a factory made again on a new socket have WebRTC bytes moving within 10 s', async (t) => {
  if (!await import('bittorrent-tracker').catch(() => null)) return t.skip('bittorrent-tracker is not installed')
  const out = tempDir(teardown(t))
  // tests/rig/rel-outage.mjs in a process of its own: a download with a uTP peer and a WebRTC peer, behind a
  // relay that is taken away for 3 s
  const outage = async (mode) => {
    const json = path.join(out, `${mode}.json`)
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../rig/rel-outage.mjs', import.meta.url)),
      '--mode', mode, '--outage', '3000', '--size', '16', '--at', '0.05', '--watch', '12000', '--json', json,
    ], { timeout: 50_000 })
    return JSON.parse(fs.readFileSync(json, 'utf8')).summary
  }
  const [rebuilt, left] = await Promise.all([outage('rebuild'), outage('none')])

  assert.equal(rebuilt.factoriesMade, 2)
  assert.ok(rebuilt.webrtcAgainAfterRestoreMs !== null && rebuilt.webrtcAgainAfterRestoreMs <= 10_000, `WebRTC bytes again after ${rebuilt.webrtcAgainAfterRestoreMs} ms`)
  assert.equal(rebuilt.sameChannel, false)
  t.diagnostic(`WebRTC bytes again ${rebuilt.webrtcAgainAfterRestoreMs} ms after the relay came back, uTP bytes ${rebuilt.utpAgainAfterRestoreMs} ms`)

  // left alone, the factory has ended with its socket, and the download goes on over uTP alone
  assert.equal(left.webrtcAgainAfterRestoreMs, null)
  assert.ok(left.utpAgainAfterRestoreMs !== null && left.done < left.size, `the control ended at ${left.done} of ${left.size} bytes`)
})
