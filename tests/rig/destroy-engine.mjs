// node tests/rig/destroy-engine.mjs <variant> <ms>: a session destroyed <ms> after its mark, then a second session in
// the same process downloads a torrent from a loopback peer and is destroyed too. Prints one JSON line and then has to
// end by itself, so the test that runs it can tell an abort, a hang and a clean end apart.
//
//   one      a magnet naming one peer (x.pe), which is tried over uTP first; the mark is a SYN to each named peer
//   four     a magnet naming four
//   pex      a peer on a stream serves the metadata and names four peers in peer exchange
//   remove   one peer, and the torrent removed in the same turn as the destroy
//   limited  a download under a ceiling from a seed engine over uTP; the mark is the first byte
//   in-write a download from a loopback peer over tcp, destroyed from inside the storage's first write after the mark,
//            which the engine makes from inside its own tick; the mark is the torrent started
//
// The named peers are in TEST-NET-3, whose datagrams the host drops, so each connect stays in progress until uTP
// gives up and the engine tries TCP instead, about 4 s after its first SYN.

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { TORRENT_STATE, createSession } from '../../build/index.js'
import { countingHost } from './counting-host.mjs'
import { bdecode, bencode, magnetFor, makeTorrent, writeFixture } from './make-torrent.mjs'
import { NodeFSStorage } from './node-storage.mjs'
import { waitFor } from './peer-handshake.mjs'
import { ScriptedPeer } from './scripted-peer.mjs'
import { dialTcp, done } from './stream-engine.mjs'
import { streamPipe } from './stream-pipe.mjs'

const [variant, msArg] = process.argv.slice(2)
const ms = Number(msArg)
const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-destroy-'))

/** countingHost, keeping every node socket it hands out so a destroyed session can be checked for one left open. */
const trackedHost = (options) => {
  const host = countingHost(options)
  const sockets = []
  const keep = (kind, socket) => {
    // a refused connect is a stand-in with no handle behind it
    if (typeof socket.once !== 'function') return socket
    const entry = { kind, closed: false }
    socket.once('close', () => { entry.closed = true })
    sockets.push(entry)
    return socket
  }
  return {
    ...host,
    net: {
      connect: (...args) => keep('tcp', host.net.connect(...args)),
      createServer: (...args) => keep('listener', host.net.createServer(...args)),
    },
    dgram: { createSocket: (...args) => keep('udp', host.dgram.createSocket(...args)) },
    open: () => sockets.filter((s) => !s.closed).map((s) => s.kind),
  }
}

/** NodeFSStorage, keeping the ids of every storage made, stopped or released, and removed. */
class CountingStorage extends NodeFSStorage {
  made = []
  released = []
  removed = []
  onNewStorage(id, ...rest) { this.made.push(id); return super.onNewStorage(id, ...rest) }
  stop(id) { this.released.push(id); return super.stop(id) }
  release(id) { this.released.push(id); return super.release(id) }
  onRemoveStorage(id) { this.removed.push(id); return super.onRemoveStorage(id) }
  onWrite = () => {}
  write(...args) { const written = super.write(...args); this.onWrite(); return written }
}

/** A torrent and a peer on loopback that serves it over tcp. */
const loopbackSeed = async (name) => {
  const file = path.join(root, name)
  writeFixture(file, 2 * 1024 * 1024, crypto.randomInt(1, 2 ** 31))
  const bytes = fs.readFileSync(file)
  const meta = makeTorrent({ file, pieceLength: 64 * 1024 })
  const accepted = []
  const server = net.createServer((socket) => {
    accepted.push(socket)
    const serve = (piece, offset, length) => bytes.subarray(piece * meta.pieceLength + offset, piece * meta.pieceLength + offset + length)
    new ScriptedPeer({ infoHash: meta.infoHash, socket, serve }).connect().catch(() => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const close = () => new Promise((resolve) => {
    for (const socket of accepted) socket.destroy()
    server.close(resolve)
  })
  return { meta, bytes, port: server.address().port, close }
}

const start = async (dir, host, options = {}) => {
  const storage = new CountingStorage(dir)
  const session = await createSession({
    storage, enableDht: false, reserveListenPort: false,
    net: host.net, dgram: host.dgram, dnsLookup: host.dnsLookup,
    ...options,
  })
  for (let i = 0; i < 30; i++) session.tick()
  const handles = new Set()
  const pump = setInterval(() => {
    session.popAlerts()
    for (const h of handles) session.postStatus(h)
  }, 100)
  const watch = (handle) => handles.add(handle)
  const running = (handle) => {
    watch(handle)
    return waitFor('the torrent to start', () => {
      const st = session.status(handle)
      return st && !st.paused && st.state !== TORRENT_STATE.checkingFiles && st.state !== TORRENT_STATE.checkingResumeData
    }).then(() => handle)
  }
  return { session, storage, watch, running, stop: () => clearInterval(pump) }
}

/**
 * Destroys the engine through `ask`. `storages` holds the ids of the storages it made, of those the destroy stopped or
 * released, and of those it removed, sorted.
 */
const destroyed = async ({ session, storage }, ask = () => session.destroy()) => {
  const t0 = performance.now()
  const releasedBefore = storage.released.length
  const removedBefore = storage.removed.length
  let outcome = 'clean'
  try {
    await ask()
  } catch (error) {
    outcome = /Aborted/.test(String(error)) ? 'abort' : String(error).slice(0, 200)
  }
  return {
    outcome,
    ms: Math.round(performance.now() - t0),
    storages: {
      made: [...storage.made].sort(),
      released: [...new Set(storage.released.slice(releasedBefore))].sort(),
      removed: storage.removed.slice(removedBefore).sort(),
    },
  }
}

// the first session, destroyed during its uTP connects, or under a ceiling while a seed engine sends it the torrent
const hostA = trackedHost()
const seedHost = trackedHost()
let seed = null
let a
let handle
let named = []
let transport
let source
if (variant === 'limited') {
  const file = path.join(root, 'seed', 'limited.bin')
  writeFixture(file, 32 * 1024 * 1024, crypto.randomInt(1, 2 ** 31))
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })
  seed = await start(root, seedHost, { reserveListenPort: true })
  const seeding = await seed.running(seed.session.addTorrentFile(meta.torrent, '/seed'))
  const port = await waitFor('the seed', () => seed.session.status(seeding)?.state === TORRENT_STATE.seeding && seed.session.reachable().port)
  a = await start(path.join(root, 'a'), hostA, { rateLimits: { download: 300 * 1024 } })
  handle = a.session.addMagnet(magnetFor(meta.infoHash, meta.name, [{ host: '127.0.0.1', port }]), '/dl')
  a.watch(handle)
  await waitFor('the first byte', () => a.session.status(handle)?.totalDone > 0, 30_000)
  transport = (await a.session.peers(handle)).map((p) => p.transport)
} else if (variant === 'pex') {
  a = await start(path.join(root, 'a'), hostA)
  const file = path.join(root, 'pex.bin')
  writeFixture(file, 256 * 1024, crypto.randomInt(1, 2 ** 31))
  const meta = makeTorrent({ file, pieceLength: 16 * 1024 })
  handle = await a.running(a.session.addMagnet(`magnet:?xt=urn:btih:${meta.infoHash}`, '/dl'))
  const [ours, theirs] = streamPipe()
  const peer = new ScriptedPeer({ infoHash: meta.infoHash, socket: theirs, metadata: bencode(bdecode(meta.torrent).info) })
  a.session.addPeerStream(handle, ours)
  await peer.connect()
  await waitFor('the engine to take peer exchange', () => peer.enginePexId)
  named = ['203.0.113.70', '203.0.113.71', '203.0.113.72', '203.0.113.73']
  peer.sendPex(named.map((address) => `${address}:6881`))
} else if (variant === 'in-write') {
  source = await loopbackSeed('in-write.bin')
  a = await start(path.join(root, 'a'), hostA)
  handle = await a.running(a.session.addTorrentFile(source.meta.torrent, '/dl'))
} else {
  a = await start(path.join(root, 'a'), hostA)
  named = Array.from({ length: variant === 'four' ? 4 : 1 }, (_, i) => `203.0.113.${50 + i}`)
  const hash = crypto.randomBytes(20).toString('hex')
  handle = await a.running(a.session.addMagnet(`magnet:?xt=urn:btih:${hash}${named.map((address) => `&x.pe=${address}:6881`).join('')}`, '/dl'))
}
await waitFor('a SYN to each named peer', () => named.every((address) => hostA.datagrams.some((d) => d.address === address)), 10_000)
await sleep(ms)
a.stop()
const ask = {
  remove: () => { a.session.removeTorrent(handle); a.session.destroy() },
  'in-write': () => new Promise((resolve, reject) => {
    a.storage.onWrite = () => {
      a.storage.onWrite = () => {}
      try { a.session.destroy() } catch (error) { reject(error); return }
      // queued behind the end destroy() deferred, so the storages are read once it has run and before any other task
      queueMicrotask(resolve)
    }
    dialTcp(a.session, handle, '127.0.0.1', source.port)
  }),
}[variant]
const first = { connects: hostA.connects.length, transport, ...await destroyed(a, ask) }
if (seed) {
  seed.stop()
  first.seed = await destroyed(seed)
}
await source?.close()
// what keeps this process alive, the destroyed session's part of it included; stdio is this script's own. A handle
// closing and a 16 ms tick timer go within a turn or two, so both are read once settled or after 2 s.
const holding = () => process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap' && r !== 'PipeWrap')
await waitFor('the first session to let go', () => hostA.open().length + seedHost.open().length === 0 && !holding().length, 2000).catch(() => {})
first.open = [...hostA.open(), ...seedHost.open()]
first.resources = holding()

// the second session, in the same process, takes a torrent from a peer on loopback over tcp
const seedB = await loopbackSeed('seed.bin')
const SEED = '198.51.100.20'
const hostB = trackedHost({ routes: { [SEED]: '127.0.0.1' } })
const b = await start(path.join(root, 'b'), hostB)
const hb = await b.running(b.session.addTorrentFile(seedB.meta.torrent, '/dl'))
dialTcp(b.session, hb, SEED, seedB.port)
await waitFor('the second session\'s download', () => done(b.session, hb), 20_000)
const saved = fs.readFileSync(b.storage.filePath(b.session.files(hb).storageIndex, 0))
b.stop()
const second = {
  sameBytes: saved.equals(seedB.bytes),
  ...await destroyed(b),
}
await seedB.close()
await waitFor('the second session\'s sockets to close', () => hostB.open().length === 0, 2000).catch(() => {})
second.open = hostB.open()
fs.rmSync(root, { recursive: true, force: true })

console.log(JSON.stringify({ variant, ms, named: named.length, first, second }))
