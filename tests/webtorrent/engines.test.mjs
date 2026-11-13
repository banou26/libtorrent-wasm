// The engine and the signalling together, with nothing standing in for either: two sessions on offlineHost(),
// each with a swarm over it, find each other through the reference tracker on a loopback socket and move a
// file each way over the streams the swarms hand them. The engines can reach nothing but those streams, and
// every ask they make of their host is counted.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { TORRENT_STATE, offlineHost } from '../../build/index.js'
import { rtcLinks, webtorrentPeers } from '../../build/webtorrent/index.js'
import { bdecode, bencode, magnetFor } from '../rig/make-torrent.mjs'
import { waitFor } from '../rig/peer-handshake.mjs'
import { MiB, done, fixture, savedSha256, startEngine, teardown, tempDir } from '../rig/stream-engine.mjs'
import { fakeRtc, nativeRtc, referenceTracker, releaseNativeRtc } from './fakes.mjs'

after(releaseNativeRtc)

// The name both torrents give their tracker. The swarm opens no socket to a loopback name a torrent gives,
// so the socket class below is a network on which this public name is the reference tracker.
const TRACKER = 'wss://tracker.test/'

const routedWebSocket = (url) => class extends WebSocket {
  static opened = []
  constructor(asked) {
    Routed.opened.push(asked)
    if (asked !== TRACKER) throw new Error(`a socket to ${asked}`)
    super(url)
  }
}
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

/**
 * What the swarm reads of a session, with every stream it hands over recorded in `handed`. `cut` refuses
 * each one. `checks` holds the state the engine passes through when a magnet's metadata arrives for half a
 * second, which is how a pump that read it at that moment leaves it until its next round.
 */
const seenThrough = (session, handed, { cut = false, checks = false }) => {
  const since = new Map()
  return {
    torrents: () => session.torrents(),
    infohash: (handle) => session.infohash(handle),
    status: (handle) => {
      const status = session.status(handle)
      if (!checks || !status?.hasMetadata) return status
      if (!since.has(handle)) since.set(handle, Date.now())
      return Date.now() - since.get(handle) < 500 ? { ...status, state: TORRENT_STATE.checkingResumeData } : status
    },
    isPrivate: (handle) => session.isPrivate(handle),
    webSocketTrackers: (handle) => session.webSocketTrackers(handle),
    hasStreamWindow: (handle) => session.hasStreamWindow(handle),
    addPeerStream: (handle, socket) => {
      handed.push(handle)
      if (cut) throw new Error('this session takes no stream')
      return session.addPeerStream(handle, socket)
    },
  }
}

/** An engine that can reach nothing, and a swarm over its session, as it is or seen through `seenThrough`. */
const side = async (defer, dir, RTCPeerConnection, through) => {
  const host = countedHost()
  const engine = await startEngine(defer, dir, { host })
  const handed = []
  const peers = webtorrentPeers(through ? seenThrough(engine.session, handed, through) : engine.session, {
    links: rtcLinks({ RTCPeerConnection, iceServers: [] }), WebSocket: Routed,
  })
  defer(() => peers.close())
  return { ...engine, host, peers, handed, of: (handle) => peers.snapshot().torrents.find((torrent) => torrent.handle === handle) }
}

/** `from` holds the fixture and seeds it under `savePath`, and the tracker lists it. */
const seed = async (from, fx, savePath) => {
  fs.mkdirSync(path.join(from.dir, savePath), { recursive: true })
  fs.writeFileSync(path.join(from.dir, savePath, fx.meta.name), fx.bytes)
  const torrent = bencode({ ...bdecode(fx.meta.torrent), announce: TRACKER })
  const handle = await from.running(from.session.addTorrentFile(torrent, `/${savePath}`))
  await waitFor('the seed to hold every piece', () => from.session.status(handle)?.numPiecesHave === fx.meta.pieces)
  // a download that announced before its seed is told of nobody, and asks again only at the tracker's interval
  await waitFor('the tracker to list the seed', () => from.of(handle)?.trackers[0]?.seeders === 1)
  return handle
}

/**
 * `to` adds the fixture's magnet. Resolves once it holds the file, with its handle and what carried its peers
 * meanwhile (two seeds drop each other, so the peer is gone soon after). Rejects after `ms`.
 */
const download = async (to, fx, savePath, ms) => {
  const magnet = `${magnetFor(fx.meta.infoHash, fx.meta.name)}&tr=${encodeURIComponent(TRACKER)}`
  const handle = await to.running(to.session.addMagnet(magnet, `/${savePath}`))
  const carriedBy = new Set()
  await waitFor('the download', () => {
    void to.session.peers(handle)
    for (const peer of to.session.lastPeers(handle)) carriedBy.add(peer.transport)
    return done(to.session, handle)
  }, ms)
  return { handle, carriedBy: [...carriedBy] }
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

test('libdatachannel: the same two engines over real ICE, DTLS and SCTP on this machine', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  await bothWays(t, nativeRtc.RTCPeerConnection)
})

test('libdatachannel: with a session that takes no stream the download never starts', { skip: !nativeRtc && 'node-datachannel did not load' }, async (t) => {
  await cutOff(t, nativeRtc.RTCPeerConnection)
})
