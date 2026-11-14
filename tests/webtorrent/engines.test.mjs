// The engine and the signalling together, with nothing standing in for either: two sessions on offlineHost(),
// each with a swarm over it, find each other through the reference tracker on a loopback socket and move a
// file each way over the streams the swarms hand them. The engines can reach nothing but those streams, and
// every ask they make of their host is counted.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { PRIORITY, TORRENT_FLAG, offlineHost } from '../../build/index.js'
import { rtcLinks, webtorrentPeers } from '../../build/webtorrent/index.js'
import { bdecode, bencode, magnetFor, makeTorrent } from '../rig/make-torrent.mjs'
import { waitFor } from '../rig/peer-handshake.mjs'
import { ScriptedPeer } from '../rig/scripted-peer.mjs'
import { MiB, fixture, savedSha256, startEngine, teardown, tempDir } from '../rig/stream-engine.mjs'
import { TRACKER, download, finished, magnetOf, routedWebSocket, seed, swarmOver } from './engine-swarm.mjs'
import { FakeSession, fakeRtc, nativeRtc, referenceTracker, releaseNativeRtc } from './fakes.mjs'

after(releaseNativeRtc)

// the network of the case that is running: the tracker's public name, and nothing else
let Routed

/** offlineHost() with every ask of it counted. */
const countedHost = () => {
  const host = offlineHost()
  const asked = { lookups: 0, connects: 0, datagrams: 0 }
  return {
    asked,
    dnsLookup: (...args) => { asked.lookups++; return host.dnsLookup(...args) },
    net: { ...host.net, connect: (...args) => { asked.connects++; return host.net.connect(...args) } },
    dgram: {
      createSocket: (...args) => {
        const socket = host.dgram.createSocket(...args)
        const send = socket.send
        socket.send = (...sent) => { asked.datagrams++; return send(...sent) }
        return socket
      },
    },
  }
}

/** An engine that can reach nothing, and a swarm over its session, as it is or seen through `seenThrough`. */
const side = async (defer, dir, RTCPeerConnection, through) => {
  const host = countedHost()
  const engine = await startEngine(defer, dir, { host })
  return { ...engine, host, ...swarmOver(defer, engine, { links: rtcLinks({ RTCPeerConnection, iceServers: [] }), WebSocket: Routed }, through) }
}

const bothWays = async (t, RTCPeerConnection) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  // the engine's own lookup over HTTPS, which a session with a dnsLookup never uses
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('offline') }
  defer(() => { globalThis.fetch = realFetch })

  const there = fixture(defer, 4 * MiB)
  const back = fixture(defer, 4 * MiB, undefined, 0x51f15eed)
  assert.notEqual(there.meta.infoHash, back.meta.infoHash)

  const a = await side(defer, path.join(there.root, 'a'), RTCPeerConnection)
  const b = await side(defer, path.join(there.root, 'b'), RTCPeerConnection)

  await seed(a, there, 'there')
  const atB = await download(b, there, 'there', 30_000)
  assert.equal(savedSha256(b, atB.handle), there.sha256)
  // the metadata came over the stream too
  assert.equal(b.session.isPrivate(atB.handle), false)

  await seed(b, back, 'back')
  const atA = await download(a, back, 'back', 30_000)
  assert.equal(savedSha256(a, atA.handle), back.sha256)
  assert.deepEqual([atB.carriedBy, atA.carriedBy], [['webrtc'], ['webrtc']])

  for (const end of [a, b]) {
    assert.deepEqual(end.host.asked, { lookups: 0, connects: 0, datagrams: 0 }, 'an engine asked its host for something')
    const { dropped, unmade, torrents } = end.peers.snapshot()
    assert.deepEqual([dropped, unmade, torrents.length], [0, 0, 2])
    for (const torrent of torrents) {
      assert.deepEqual(torrent.trackers.map((tracker) => [tracker.url, tracker.connected, tracker.failure]), [[TRACKER, true, null]])
      assert.ok(torrent.lastPeerAt, 'a torrent that moved a file never had a peer')
      assert.equal(torrent.silent, 0)
    }
  }
  assert.equal(fetches, 0, 'a name left through the engine\'s own lookup')
  assert.deepEqual([...new Set(Routed.opened)], [TRACKER])
}

const cutOff = async (t, RTCPeerConnection) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  const there = fixture(defer, 4 * MiB)
  const a = await side(defer, path.join(there.root, 'a'), RTCPeerConnection)
  const b = await side(defer, path.join(there.root, 'b'), RTCPeerConnection, { cut: true })
  await seed(a, there, 'there')
  // several times what the transfer takes when the stream is handed over
  await assert.rejects(download(b, there, 'there', 8000), /timed out after 8000ms waiting for the download/)
  assert.ok(b.handed.length >= 1, 'the swarm never had a channel to hand over')
  const [handle] = b.session.torrents()
  assert.equal(b.session.status(handle).hasMetadata, false)
  assert.deepEqual(await b.session.peers(handle), [])
}

/**
 * `b` downloads what `a` seeds, is paused once its channel is open and its metadata in (as ripple parks a
 * download page's torrent), and is resumed. With `cut`, `a` takes no stream, so each end sees the other silent.
 * With `mute`, `b` is paused as its first channel opens, before a byte from `a` arrived (`a` sends none on it).
 * Null without the reference tracker.
 */
const pausedAndResumed = async (t, RTCPeerConnection, { cut = false, mute = false } = {}) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return null
  Routed = routedWebSocket(reference.url)
  const there = fixture(defer, 4 * MiB)
  const a = await side(defer, path.join(there.root, 'a'), RTCPeerConnection, cut || mute ? { cut, mute } : undefined)
  const b = await side(defer, path.join(there.root, 'b'), RTCPeerConnection, {})
  await seed(a, there, 'there')
  // far from done when it is paused
  b.session.setRateLimits({ download: 64 * 1024 })
  const handle = await b.running(b.session.addMagnet(magnetOf(there), '/there'))
  if (cut) await waitFor('the seed to be silent', () => b.of(handle)?.silent === 1)
  // a pause ends only a stream the engine has dialled; one it has not is closed by the swarm's own stop
  else if (mute) await waitFor('a channel the engine dialled', () => {
    void b.session.peers(handle)
    return b.of(handle)?.open === 1 && b.session.lastPeers(handle).length === 1
  })
  else await waitFor('a channel and the metadata', () => b.of(handle)?.open === 1 && b.session.status(handle)?.hasMetadata)
  b.session.pauseTorrent(handle)
  await waitFor('the swarm to stop it', () => !b.of(handle))
  b.session.resumeTorrent(handle)
  await waitFor('the swarm to run it again', () => b.of(handle))
  return { a, b, there, handle }
}

// The seed left the id whose channel closed alone for 60 s, and the next offer waited for the tracker's interval,
// 120 s at the reference tracker.
const backAtOnce = async (t, RTCPeerConnection, options) => {
  const run = await pausedAndResumed(t, RTCPeerConnection, options)
  if (!run) return t.skip('bittorrent-tracker is not installed')
  const { b, there, handle } = run
  await waitFor('a channel again', () => b.of(handle)?.open === 1, 10_000)
  b.session.setRateLimits({ download: 0 })
  await finished(b, handle, 20_000)
  assert.equal(savedSha256(b, handle), there.sha256)
}

// ripple's held download page: added in upload mode, which drops the seed once the metadata is in, and let go of it
const heldAndLetGo = async (t, RTCPeerConnection) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  const there = fixture(defer, 4 * MiB)
  const a = await side(defer, path.join(there.root, 'a'), RTCPeerConnection)
  const b = await side(defer, path.join(there.root, 'b'), RTCPeerConnection, {})
  await seed(a, there, 'there')
  const handle = b.session.addMagnet(magnetOf(there), '/there')
  // as ripple holds one: the add run and registered first, or the flag lands on nothing
  b.session.tick()
  b.alerts.push(...b.session.popAlerts().map((alert) => alert.message))
  b.session.setFlags(handle, TORRENT_FLAG.uploadMode, TORRENT_FLAG.uploadMode)
  await b.running(handle)
  await waitFor('the hold', () => b.session.status(handle).flags & TORRENT_FLAG.uploadMode)
  await waitFor('the metadata, and the seed dropped', () => b.session.status(handle)?.hasMetadata && b.handed.length === 1 && b.of(handle)?.open === 0)
  assert.equal(b.session.status(handle).totalWantedDone, 0)
  b.session.setFlags(handle, 0, TORRENT_FLAG.uploadMode)
  await waitFor('a channel again', () => b.of(handle)?.open === 1, 10_000)
  await finished(b, handle, 20_000)
  assert.equal(savedSha256(b, handle), there.sha256)
}

const silentStays = async (t, RTCPeerConnection) => {
  const run = await pausedAndResumed(t, RTCPeerConnection, { cut: true })
  if (!run) return t.skip('bittorrent-tracker is not installed')
  const { b, handle } = run
  // several times what a channel takes to open again after a resume
  await new Promise((resolve) => setTimeout(resolve, 8000))
  assert.deepEqual([b.handed.length, b.of(handle)?.silent], [1, 1])
}

test('the counted host counts: a magnet that names a tracker and a peer has the engine ask for a name, a datagram and a connect', async (t) => {
  const defer = teardown(t)
  const host = countedHost()
  const { session, running } = await startEngine(defer, tempDir(defer), { host })
  const tracker = encodeURIComponent('udp://tracker.test:6969')
  const handle = await running(session.addMagnet(`${magnetFor('00112233445566778899aabbccddeeff00112233', 'asks')}&tr=${tracker}&x.pe=192.0.2.10:6881`, '/dl'))
  // the peer is tried over uTP first and dialled about 5 s later, which is also when no uTP connect is left
  // in progress: a session destroyed during one aborts
  await waitFor('the engine to ask its host', () => host.asked.lookups > 0 && host.asked.datagrams > 0 && host.asked.connects > 0)
  session.removeTorrent(handle)
})

test('two engines that can reach nothing but each other\'s streams find each other through a tracker and move a file each way', async (t) => {
  await bothWays(t, fakeRtc())
})

test('with a session that takes no stream the same download never starts: the streams are the only way', async (t) => {
  await cutOff(t, fakeRtc())
})

test('a download paused once its channel is open and resumed has its seed back at once, and finishes', async (t) => {
  await backAtOnce(t, fakeRtc())
})

// libtorrent ends a paused torrent's streams itself: one that opened a moment before says nothing about its remote.
test('a download paused as its channel opens, before a byte from the seed, has the seed back at once when resumed', async (t) => {
  await backAtOnce(t, fakeRtc(), { mute: true })
})

test('a seed that never spoke is still left alone after the download that saw it is paused and resumed', async (t) => {
  await silentStays(t, fakeRtc())
})

test('a download held in upload mode, which drops its seed at the metadata, has the seed back at once when let go, and finishes', async (t) => {
  await heldAndLetGo(t, fakeRtc())
})

test('a magnet that names no tracker finds its seed through a tracker the caller passed, and downloads', async (t) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  const RTCPeerConnection = fakeRtc()
  const there = fixture(defer, 4 * MiB)
  const a = await side(defer, path.join(there.root, 'a'), RTCPeerConnection)
  await seed(a, there, 'there')

  const b = await startEngine(defer, path.join(there.root, 'b'))
  const peers = webtorrentPeers(b.session, { links: rtcLinks({ RTCPeerConnection, iceServers: [] }), WebSocket: Routed, trackers: [TRACKER] })
  defer(() => peers.close())
  const handle = await b.running(b.session.addMagnet(magnetFor(there.meta.infoHash, there.meta.name), '/there'))
  assert.deepEqual([b.session.webSocketTrackers(handle), b.session.isPrivate(handle)], [[], undefined])
  // held to its own trackers until its metadata says, it would be announced nowhere and wait for ever
  await finished(b, handle, 20_000)
  assert.equal(savedSha256(b, handle), there.sha256)
  assert.equal(b.session.isPrivate(handle), false)
  assert.deepEqual(peers.snapshot().torrents[0].trackers.map((tracker) => [tracker.url, tracker.connected, tracker.failure]), [[TRACKER, true, null]])
})

test('a torrent that is private when it is added, from its file or from resume data, is never announced to a tracker the caller passed', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const marked = makeTorrent({ file: path.join(fx.root, 'fixture.bin'), pieceLength: 256 * 1024, private: true })
  // a network with nobody on it: what counts is whether a socket is asked for
  const asked = []
  class Asked {
    readyState = 0
    constructor(url) { asked.push(url) }
    send() {}
    close() {}
  }
  const b = await startEngine(defer, path.join(fx.root, 'b'))
  const peers = webtorrentPeers(b.session, { links: rtcLinks({ RTCPeerConnection: fakeRtc(), iceServers: [] }), WebSocket: Asked, trackers: [TRACKER] })
  defer(() => peers.close())
  // The engine has nothing to say of a torrent until its add was pumped, and then says all of it at once. The
  // swarm reads at every turn of the event loop here, so in every state an add passes through.
  const taken = async (handle) => {
    const running = b.running(handle)
    const deadline = performance.now() + 20_000
    while (!peers.snapshot().torrents.some((torrent) => torrent.handle === handle)) {
      assert.ok(performance.now() < deadline, 'the swarm never took the torrent')
      peers.refresh()
      await new Promise((resolve) => setImmediate(resolve))
    }
    await running
  }

  const handle = b.session.addTorrentFile(marked.torrent, '/dl')
  await taken(handle)
  assert.equal(b.session.isPrivate(handle), true)
  const resume = await b.session.saveResumeData(handle)
  b.session.removeTorrent(handle)
  peers.refresh()
  await taken(b.session.addTorrentWithResume(resume, '/dl'))
  assert.deepEqual(asked, [])
})

test('a magnet whose metadata says it is private leaves the tracker the caller passed, told no size, and keeps the peer it found there', async (t) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  const links = rtcLinks({ RTCPeerConnection: fakeRtc(), iceServers: [] })
  const fx = fixture(defer, MiB)
  const marked = makeTorrent({ file: path.join(fx.root, 'fixture.bin'), pieceLength: 256 * 1024, private: true })

  // An engine that holds a private torrent from its file serves no metadata, so two of ours cannot play this.
  // The peer is another client at the same tracker: it holds the metadata, serves it, and has no piece.
  const holder = new FakeSession()
  const shaken = []
  holder.addPeerStream = (_, socket) => {
    shaken.push(new ScriptedPeer({ infoHash: marked.infoHash, socket, metadata: bencode(bdecode(marked.torrent).info) }).connect())
  }
  holder.add(1, { infoHash: marked.infoHash, left: 0 })
  const holding = webtorrentPeers(holder, { links, WebSocket: Routed, trackers: [TRACKER] })
  defer(() => holding.close())
  await waitFor('the tracker to list the holder', () => holding.snapshot().torrents[0]?.trackers[0]?.seeders === 1)

  // every announce the engine's swarm sends
  const sent = []
  class Recorded extends Routed {
    send(data) {
      const { event, left, offers } = JSON.parse(data)
      sent.push([event, left, offers?.length])
      super.send(data)
    }
  }
  const b = await startEngine(defer, path.join(fx.root, 'b'))
  const peers = webtorrentPeers(b.session, { links, WebSocket: Recorded, trackers: [TRACKER] })
  defer(() => peers.close())
  const handle = await b.running(b.session.addMagnet(magnetFor(marked.infoHash, marked.name), '/dl'))
  assert.deepEqual([b.session.webSocketTrackers(handle), b.session.isPrivate(handle)], [[], undefined])
  await waitFor('the metadata to say private', () => b.session.isPrivate(handle) === true)
  await Promise.all(shaken)
  await waitFor('the passed tracker to be told', () => sent.at(-1)[0] === 'stopped')
  // two more of the swarm's reads
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.deepEqual(sent, [['started', 16 * 1024, 0], [undefined, 16 * 1024, 1], ['stopped', 16 * 1024, 0]])
  const [{ trackers, open }] = peers.snapshot().torrents
  assert.deepEqual(trackers, [])
  assert.equal(open, 1, 'the swarm closed the channel that was open')
  assert.equal((await b.session.peers(handle)).length, 1, 'the engine let go of the peer that brought the metadata')
})

test('a download whose session reports a check as its metadata arrives keeps the channel that brought it', async (t) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  const RTCPeerConnection = fakeRtc()
  const there = fixture(defer, 4 * MiB)
  const a = await side(defer, path.join(there.root, 'a'), RTCPeerConnection)
  const b = await side(defer, path.join(there.root, 'b'), RTCPeerConnection, { checks: true })
  // slow enough that the swarm reads the session while the download is under way
  b.session.setRateLimits({ download: MiB })
  await seed(a, there, 'there')
  // a swarm that stopped the torrent for the check closed its only channel, and the seed then left it alone for a minute
  const { handle } = await download(b, there, 'there', 20_000)
  assert.equal(savedSha256(b, handle), there.sha256)
  assert.deepEqual(b.handed, [handle], 'the download took more than the one stream it began on')
})

test('a torrent that holds a file it skips, larger than what it still wants, finds the seed and gets the rest', async (t) => {
  const defer = teardown(t)
  const reference = await referenceTracker(t)
  if (!reference) return t.skip('bittorrent-tracker is not installed')
  Routed = routedWebSocket(reference.url)
  const RTCPeerConnection = fakeRtc()
  const root = tempDir(defer)
  const pieceLength = 256 * 1024
  const files = [{ name: 'held.bin', bytes: crypto.randomBytes(2 * MiB) }, { name: 'wanted.bin', bytes: crypto.randomBytes(MiB) }]
  const all = Buffer.concat(files.map((file) => file.bytes))
  const pieces = []
  for (let at = 0; at < all.length; at += pieceLength) pieces.push(crypto.createHash('sha1').update(all.subarray(at, at + pieceLength)).digest())
  const torrent = bencode({
    announce: TRACKER,
    info: { files: files.map((file) => ({ length: file.bytes.length, path: [file.name] })), name: 'pack', 'piece length': pieceLength, pieces: Buffer.concat(pieces) },
  })
  /** The pack on an engine that has `held` of its files on disk already. */
  const holding = async (engine, held) => {
    fs.mkdirSync(path.join(engine.dir, 'dl', 'pack'), { recursive: true })
    for (const file of held) fs.writeFileSync(path.join(engine.dir, 'dl', 'pack', file.name), file.bytes)
    const handle = await engine.running(engine.session.addTorrentFile(torrent, '/dl'))
    const bytes = held.reduce((sum, file) => sum + file.bytes.length, 0)
    await waitFor('the files on disk to be counted', () => engine.session.status(handle)?.totalDone === bytes)
    return handle
  }

  const a = await side(defer, path.join(root, 'a'), RTCPeerConnection)
  const seeded = await holding(a, files)
  await waitFor('the tracker to list the seed', () => a.of(seeded)?.trackers[0]?.seeders === 1)

  // ripple's ordinary torrent: a pack with one file watched earlier and skipped now, and another wanted
  const b = await startEngine(defer, path.join(root, 'b'))
  const handle = await holding(b, files.slice(0, 1))
  b.session.setFilePriorities(handle, Uint8Array.from([PRIORITY.skip, PRIORITY.normal]))
  await waitFor('the skip to show', () => b.session.status(handle)?.totalWanted === MiB)
  // all it holds is more than all it wants, and none of it is wanted
  const { totalDone, totalWantedDone } = b.session.status(handle)
  assert.deepEqual({ totalDone, totalWantedDone }, { totalDone: 2 * MiB, totalWantedDone: 0 })

  const peers = webtorrentPeers(b.session, { links: rtcLinks({ RTCPeerConnection, iceServers: [] }), WebSocket: Routed })
  defer(() => peers.close())
  // a swarm that read it as a seed made no offer, and the seed makes none either
  await waitFor('the wanted file', () => b.session.status(handle)?.numPiecesHave === pieces.length, 20_000)
  const saved = fs.readFileSync(b.storage.filePath(b.session.files(handle).storageIndex, 1))
  assert.ok(saved.equals(files[1].bytes), 'the file that arrived is not the one the seed holds')
})

test('libdatachannel: the same two engines over real ICE, DTLS and SCTP on this machine', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  await bothWays(t, nativeRtc.RTCPeerConnection)
})

test('libdatachannel: with a session that takes no stream the download never starts', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  await cutOff(t, nativeRtc.RTCPeerConnection)
})

test('libdatachannel: a download paused and resumed has its seed back at once', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  await backAtOnce(t, nativeRtc.RTCPeerConnection)
})

test('libdatachannel: a download let go of upload mode has its seed back at once', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  await heldAndLetGo(t, nativeRtc.RTCPeerConnection)
})
