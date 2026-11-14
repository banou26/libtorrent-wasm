// node tests/rig/destroy-engine.mjs <variant> <ms>: a session destroyed <ms> after its uTP connects are out, then a
// second session in the same process downloads a torrent from a loopback peer and is destroyed too. Prints one JSON
// line and then has to end by itself, so the test that runs it can tell an abort, a hang and a clean end apart.
//
//   one     a magnet naming one peer (x.pe), which is tried over uTP first
//   four    a magnet naming four
//   pex     a peer on a stream serves the metadata and names four peers in peer exchange
//   remove  one peer, and the torrent removed in the same turn as the destroy
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
import { bdecode, bencode, makeTorrent, writeFixture } from './make-torrent.mjs'
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

const start = async (dir, host) => {
  const storage = new NodeFSStorage(dir)
  const session = await createSession({
    storage, enableDht: false, reserveListenPort: false,
    net: host.net, dgram: host.dgram, dnsLookup: host.dnsLookup,
  })
  for (let i = 0; i < 30; i++) session.tick()
  const handles = new Set()
  const pump = setInterval(() => {
    session.popAlerts()
    for (const h of handles) session.postStatus(h)
  }, 100)
  const running = (handle) => {
    handles.add(handle)
    return waitFor('the torrent to start', () => {
      const st = session.status(handle)
      return st && !st.paused && st.state !== TORRENT_STATE.checkingFiles && st.state !== TORRENT_STATE.checkingResumeData
    }).then(() => handle)
  }
  return { session, storage, running, stop: () => clearInterval(pump) }
}

const destroyed = (session, before = () => {}) => {
  const t0 = performance.now()
  let outcome = 'clean'
  try {
    before()
    session.destroy()
  } catch (error) {
    outcome = /Aborted/.test(String(error)) ? 'abort' : String(error).slice(0, 200)
  }
  return { outcome, ms: Math.round(performance.now() - t0) }
}

// the first session, destroyed during its uTP connects
const hostA = trackedHost()
const a = await start(path.join(root, 'a'), hostA)
let handle
let named
if (variant === 'pex') {
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
} else {
  named = Array.from({ length: variant === 'four' ? 4 : 1 }, (_, i) => `203.0.113.${50 + i}`)
  const hash = crypto.randomBytes(20).toString('hex')
  handle = await a.running(a.session.addMagnet(`magnet:?xt=urn:btih:${hash}${named.map((address) => `&x.pe=${address}:6881`).join('')}`, '/dl'))
}
await waitFor('a SYN to each named peer', () => named.every((address) => hostA.datagrams.some((d) => d.address === address)), 10_000)
await sleep(ms)
a.stop()
const first = { connects: hostA.connects.length, ...destroyed(a.session, () => { if (variant === 'remove') a.session.removeTorrent(handle) }) }
await waitFor('the first session\'s sockets to close', () => hostA.open().length === 0, 2000).catch(() => {})
first.open = hostA.open()
// what keeps this process alive, the destroyed session's part of it included; stdio is this script's own
first.resources = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap' && r !== 'PipeWrap')

// the second session, in the same process, takes a torrent from a peer on loopback over tcp
const file = path.join(root, 'seed.bin')
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
const SEED = '198.51.100.20'
const hostB = trackedHost({ routes: { [SEED]: '127.0.0.1' } })
const b = await start(path.join(root, 'b'), hostB)
const hb = await b.running(b.session.addTorrentFile(meta.torrent, '/dl'))
dialTcp(b.session, hb, SEED, server.address().port)
await waitFor('the second session\'s download', () => done(b.session, hb), 20_000)
const saved = fs.readFileSync(b.storage.filePath(b.session.files(hb).storageIndex, 0))
b.stop()
const second = {
  sameBytes: saved.equals(bytes),
  ...destroyed(b.session),
}
for (const socket of accepted) socket.destroy()
server.close()
await waitFor('the second session\'s sockets to close', () => hostB.open().length === 0, 2000).catch(() => {})
second.open = hostB.open()
fs.rmSync(root, { recursive: true, force: true })

console.log(JSON.stringify({ variant, ms, named: named.length, first, second }))
