// What the peer stream tests share: an engine with its pump, a fixture, and one teardown in order.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { TORRENT_STATE, createSession, offlineHost } from '../../build/index.js'
import { countingHost } from './counting-host.mjs'
import { makeTorrent, writeFixture } from './make-torrent.mjs'
import { NodeFSStorage } from './node-storage.mjs'
import { waitFor } from './peer-handshake.mjs'
import { ScriptedPeer } from './scripted-peer.mjs'
import { streamPipe } from './stream-pipe.mjs'

export const MiB = 1024 * 1024

/**
 * `defer(fn)` runs `fn` when the test ends, last deferred first. One hook, because the order is
 * load bearing: a session has to go before the directory it writes to. Every step runs even when
 * one throws, or a failed test leaves an engine ticking and the file never ends.
 */
export const teardown = (t) => {
  const undo = []
  t.after(async () => {
    let failure
    for (const fn of undo.reverse()) {
      try { await fn() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  })
  return (fn) => { undo.push(fn) }
}

/** A directory that goes with the test. */
export const tempDir = (defer) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-streams-'))
  defer(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

/** A directory for one test with a fixture in it, and the fixture's torrent and SHA-256. Another `seed` gives other bytes. */
export const fixture = (defer, size, pieceLength = 256 * 1024, seed = undefined) => {
  const root = tempDir(defer)
  const file = path.join(root, 'fixture.bin')
  writeFixture(file, size, seed)
  const bytes = fs.readFileSync(file)
  return {
    root, bytes,
    meta: makeTorrent({ file, pieceLength }),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }
}

/**
 * An engine with its alert pump. `host` defaults to offlineHost(), so nothing but the streams the
 * test hands over can reach it; pass a host with real sockets for a session that has both kinds.
 */
export const startEngine = async (defer, dir, { host = offlineHost(), ...options } = {}) => {
  const storage = new NodeFSStorage(dir)
  const session = await createSession({
    storage, enableDht: false, reserveListenPort: false, net: host.net, dgram: host.dgram, dnsLookup: host.dnsLookup,
    ...options,
  })
  for (let i = 0; i < 30; i++) session.tick()
  const handles = new Set()
  const alerts = []
  const pump = setInterval(() => {
    for (const a of session.popAlerts()) alerts.push(a.message)
    for (const h of handles) session.postStatus(h)
  }, 100)
  defer(() => {
    clearInterval(pump)
    // destroy() aborts inside the wasm while a uTP connect is in progress (a test that failed
    // early can leave one), and then never reaches the shim's teardown, which closes the sockets
    try { session.destroy() } finally { session.mod.__FKN?.teardown?.() }
  })

  /** Resolves once the torrent is added and libtorrent's queue has started it. */
  const running = async (handle) => {
    handles.add(handle)
    await waitFor('the torrent to start', () => {
      const st = session.status(handle)
      return st && !st.paused && st.state !== TORRENT_STATE.checkingFiles && st.state !== TORRENT_STATE.checkingResumeData
    })
    return handle
  }
  return { session, storage, alerts, running, dir }
}

/** An engine that holds the whole fixture and seeds it. */
export const startSeeder = async (defer, fx, name = 'seeder', options = {}) => {
  const dir = path.join(fx.root, name)
  fs.mkdirSync(path.join(dir, 'dl'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'dl', fx.meta.name), fx.bytes)
  const engine = await startEngine(defer, dir, options)
  const handle = await engine.running(engine.session.addTorrentFile(fx.meta.torrent, '/dl'))
  await waitFor('the seeder to hold every piece', () => engine.session.status(handle)?.numPiecesHave === fx.meta.pieces)
  return { ...engine, handle }
}

/**
 * Has libtorrent dial an ordinary peer over tcp within about a second, by naming it the way the
 * wrapper names a stream peer. A magnet's x.pe names one too, but it is tried over uTP first, and
 * the tcp dial then comes about 5 s later.
 */
export const dialTcp = (session, handle, address, port) => {
  const ipv4 = address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0)
  assert.equal(session.mod._lt_torrent_add_channel_peer(handle, ipv4, port), 0)
}

/** A loopback tcp listener that goes with the test. Resolves with its port. */
export const listen = (defer, onSocket) => new Promise((resolve) => {
  const sockets = []
  const server = net.createServer((socket) => { sockets.push(socket); onSocket(socket) })
  defer(() => { for (const socket of sockets) socket.destroy(); server.close() })
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

/** A compact peer list (6 bytes an entry) as `address:port` strings. */
export const endpoints = (compact = Buffer.alloc(0)) => {
  const out = []
  for (let i = 0; i + 6 <= compact.length; i += 6) out.push(`${compact.subarray(i, i + 4).join('.')}:${compact.readUInt16BE(i + 4)}`)
  return out
}

/**
 * An engine holding the fixture's torrent with two peers that have nothing: one at `address`,
 * which the host routes to this machine and libtorrent takes for an ordinary peer, and one on a
 * stream.
 */
export const startEngineWithBothKinds = async (defer, fx, address, options = {}) => {
  const infoHash = fx.meta.infoHash
  const answered = []
  const port = await listen(defer, (socket) => answered.push(new ScriptedPeer({ infoHash, socket }).connect()))
  const host = countingHost({ routes: { [address]: '127.0.0.1' } })
  const engine = await startEngine(defer, path.join(fx.root, 'engine'), { host, ...options })
  const { session } = engine
  const handle = await engine.running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  dialTcp(session, handle, address, port)
  const [ours, theirs] = streamPipe()
  const streamPeer = new ScriptedPeer({ infoHash, socket: theirs }).connect()
  const stream = session.addPeerStream(handle, ours)
  await waitFor('the ordinary peer to be dialled', () => answered.length === 1)
  await Promise.all([streamPeer, ...answered])
  await waitFor('both peers', () => session.status(handle)?.numPeers === 2)
  return { ...engine, handle, port, stream }
}

export const done = (session, handle) => {
  const st = session.status(handle)
  return !!st && st.hasMetadata && st.totalDone > 0 && st.totalDone >= st.totalWanted
    && (st.state === TORRENT_STATE.seeding || st.state === TORRENT_STATE.finished)
}

/** SHA-256 of what an engine saved for a single-file torrent. */
export const savedSha256 = (engine, handle) => {
  const file = engine.storage.filePath(engine.session.files(handle).storageIndex, 0)
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
