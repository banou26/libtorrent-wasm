// What a details panel reads beside the peer and tracker lists: trackers added to a running
// torrent, how many peers have each piece, and the DHT's node count. Two engines on loopback, a
// tracker on this machine, and a host that lets nothing else out and looks no name up.

import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'
import {
  MiB, dialTcp, done, fixture, listen, savedSha256, startEngine, startSeeder, teardown,
} from './rig/stream-engine.mjs'

// a tracker at /announce (libtorrent announces to a loopback one only on that path), naming `peers`
const tracker = (defer, peers) => new Promise((resolve) => {
  const seen = { announces: [] }
  const compact = Buffer.concat(peers.map(({ address, port }) =>
    Buffer.from([...address.split('.').map(Number), port >> 8, port & 0xff])))
  const server = http.createServer((req, res) => {
    const escaped = /[?&]info_hash=([^&]*)/.exec(req.url)?.[1] ?? ''
    seen.announces.push(Buffer.from(escaped.replace(/%(..)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('hex'))
    res.end(Buffer.concat([Buffer.from(`d8:intervali1800e5:peers${compact.length}:`), compact, Buffer.from('e')]))
  })
  defer(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1', () => resolve(Object.assign(seen, { url: `http://127.0.0.1:${server.address().port}/announce` })))
})

const seedOptions = () => ({ host: countingHost(), reserveListenPort: true })

test('a tracker added to a running torrent is announced to, and the peer it names is used', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, 2 * MiB)
  const seed = await startSeeder(defer, fx, 'seeder', seedOptions())
  const announced = await tracker(defer, [{ address: '127.0.0.1', port: seed.session.reachable().port }])
  const leech = await startEngine(defer, path.join(fx.root, 'leech'), { host: countingHost() })
  const { session } = leech
  const handle = await leech.running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  assert.deepEqual(await session.trackers(handle), [])

  assert.deepEqual(session.addTrackers(handle, [announced.url]), [])
  await waitFor('an announce to the added tracker', () => announced.announces.includes(fx.meta.infoHash))
  await waitFor('the download from the peer it named', () => done(session, handle), 30_000)
  assert.equal(savedSha256(leech, handle), fx.sha256)

  assert.deepEqual(session.addTrackers(handle, [` ${announced.url}`]), [], 'a tracker it has was refused')
  assert.deepEqual((await session.trackers(handle)).map((row) => row.url), [announced.url])

  const ws = 'wss://tracker.example.invalid/announce'
  assert.deepEqual(session.addTrackers(handle, [ws, 'tracker.example.invalid', 'ftp://example.invalid/']),
    ['tracker.example.invalid', 'ftp://example.invalid/'])
  assert.deepEqual(session.addTrackers(handle, [ws]), [])
  await waitFor('the ws tracker to be kept', () => session.webSocketTrackers(handle).length)
  assert.deepEqual(session.webSocketTrackers(handle), [ws])
  assert.deepEqual((await session.trackers(handle)).map((row) => row.url), [announced.url])

  assert.deepEqual(session.addTrackers(0xDEADBEEF, [announced.url]), [announced.url])
})

test('a ws tracker added to a removed torrent, or to one a remove is taking away, is not kept for its re-add', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const leech = await startEngine(defer, path.join(fx.root, 'leech'), { host: countingHost() })
  const { session } = leech
  const handle = await leech.running(session.addTorrentFile(fx.meta.torrent, '/dl'))

  assert.deepEqual(session.addTrackers(handle, ['wss://before-remove.example.invalid/announce']), [])
  session.removeTorrent(handle)
  assert.deepEqual(session.addTrackers(handle, ['wss://after-remove.example.invalid/announce']), [])
  const again = await leech.running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  assert.equal(again, handle)

  const ws = 'wss://after-re-add.example.invalid/announce'
  assert.deepEqual(session.addTrackers(again, [ws]), [])
  await waitFor('the tracker added after the re-add', () => session.webSocketTrackers(again).includes(ws))
  assert.deepEqual(session.webSocketTrackers(again), [ws])
})

test('piece availability counts each connected peer that has a piece', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, 4 * MiB)
  const seed = await startSeeder(defer, fx, 'seeder', seedOptions())
  // slow enough that the leech is still missing pieces when the test ends, and keeps its count
  seed.session.setUploadLimit(seed.handle, 16 * 1024)

  // the scripted peer stands at another address, as libtorrent keeps one peer per address
  const leech = await startEngine(defer, path.join(fx.root, 'leech'), { host: countingHost({ routes: { '127.0.0.2': '127.0.0.1' } }) })
  const { session } = leech
  const added = session.addTorrentFile(fx.meta.torrent, '/dl')
  assert.equal(session.pieceAvailability(added), null, 'an answer before the torrent was ready')
  const handle = await leech.running(added)
  await waitFor('the torrent to be ready', () => session.files(handle))
  assert.deepEqual([...session.pieceAvailability(handle)], new Array(fx.meta.pieces).fill(0))

  dialTcp(session, handle, '127.0.0.1', seed.session.reachable().port)
  await waitFor('the seed to count once for every piece', () =>
    session.pieceAvailability(handle)?.every((n) => n === 1))

  // a peer that has the first half and never unchokes, so nothing comes from it
  const half = fx.meta.pieces / 2
  let socket
  const port = await listen(defer, (s) => {
    socket = s
    new ScriptedPeer({ infoHash: fx.meta.infoHash, socket: s }).connect().then(() => {
      for (let piece = 0; piece < half; piece++) {
        const have = Buffer.alloc(9)
        have.writeUInt32BE(5, 0)
        have.writeUInt8(4, 4)
        have.writeUInt32BE(piece, 5)
        s.write(have)
      }
    })
  })
  dialTcp(session, handle, '127.0.0.2', port)
  const expected = [...new Array(half).fill(2), ...new Array(fx.meta.pieces - half).fill(1)]
  await waitFor('the half peer to count for its pieces', () =>
    JSON.stringify([...session.pieceAvailability(handle)]) === JSON.stringify(expected))
  assert.ok(socket, 'the half peer was never dialled')
  assert.ok(!done(session, handle), 'the download ended, so the count says nothing')
})

test('the DHT node count is 0 without a DHT and moves once a node is known', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, 1 * MiB)
  const off = await startEngine(defer, path.join(fx.root, 'off'), { host: countingHost() })
  assert.equal(off.session.dhtNodes(), 0)

  const dht = { ...seedOptions(), enableDht: true }
  const seed = await startSeeder(defer, fx, 'seeder', dht)
  const leech = await startEngine(defer, path.join(fx.root, 'leech'), { ...dht, host: countingHost() })
  // no name resolves, so the bootstrap routers are never reached and nothing is known yet
  assert.equal(seed.session.dhtNodes(), 0)
  assert.equal(leech.session.dhtNodes(), 0)

  // each peer tells the other its DHT port in the handshake, and the DHT pings it. The seed first keeps
  // the leech in its replacement cache, which is not a node yet, for about 3 s.
  const handle = await leech.running(leech.session.addTorrentFile(fx.meta.torrent, '/dl'))
  dialTcp(leech.session, handle, '127.0.0.1', seed.session.reachable().port)
  await waitFor('one DHT node on each side', () => seed.session.dhtNodes() === 1 && leech.session.dhtNodes() === 1)
  assert.equal(off.session.dhtNodes(), 0)
})
