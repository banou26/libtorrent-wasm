#!/usr/bin/env node
// The relay mode through a relay outage, timed: a download that has a uTP peer and a WebRTC peer, with
// the relay taken away part way and brought back. It says when the bytes of each kind stop and when they
// move again. Everything is on loopback: the uTP seed at 127.0.0.1, the WebRTC seed at 127.0.0.3.
//
//   node tests/rig/rel-outage.mjs [--mode rebuild|keep|none] [--remote entry|libdatachannel]
//                                 [--outage MS] [--moved] [--same-port] [--at FRACTION] [--watch MS]
//                                 [--size MB] [--up KBPS] [--json out.json] [--dir DIR]
//
// --mode says what is done with the WebRTC half when its socket ends:
//   rebuild  the swarm and the factory are closed, and made again on a new socket once the relay gives one
//            (what the README tells a caller to do): on any port, or with --same-port on the one it had
//   keep     the factory stays, over a socket that is replaced under it: on the port it had, or on any
//            port when that one is refused
//   none     nothing: the factory ends with its socket
// --remote is the WebRTC seed's stack: this package's entry, or libdatachannel (a port for each connection,
// as a browser and qBittorrent have). --moved brings the relay back with the ports its sockets held taken.
// --dir is where the run keeps its files, a directory of its own in the system's temporary one by default.
// It is removed when the run ends, also when the run is stopped.

import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSession, offlineHost } from '../../build/index.js'
import { createWebRTC } from '../../build/webrtc.js'
import { rtcLinks, webtorrentPeers } from '../../build/webtorrent/index.js'
import { bdecode, bencode, magnetFor, makeTorrent, writeFixture } from './make-torrent.mjs'
import { createNodeHost } from './node-host.mjs'
import { NodeFSStorage } from './node-storage.mjs'
import { createRelayHost } from './relay-host.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback
}
const MODE = arg('mode', 'rebuild')
const REMOTE = arg('remote', 'entry')
const OUTAGE_MS = Number(arg('outage', 20_000))
const MOVED = process.argv.includes('--moved')
const SAME_PORT = process.argv.includes('--same-port')
const AT = Number(arg('at', 0.15))
const WATCH_MS = Number(arg('watch', 40_000))
const SIZE_MB = Number(arg('size', 32))
const UP_KBPS = Number(arg('up', 256))

const TRACKER = 'wss://tracker.test/'
const OURS = '127.0.0.1'
const RTC_SEED = '127.0.0.3'
const REBIND_EVERY_MS = 500
const wasm = new WebAssembly.Module(fs.readFileSync(new URL('../../build/webrtc.wasm', import.meta.url)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = arg('dir', null) ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rel-outage-'))
const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)
const closing = []

// no name is ever looked up: a session without this asks 1.1.1.1 over HTTPS
const { dnsLookup } = offlineHost()

/** A session with its pump, closed at the end. */
const engine = async (name, host, options = {}) => {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'dl'), { recursive: true })
  const session = await createSession({ net: host.net, dgram: host.dgram, dnsLookup, storage: new NodeFSStorage(dir), enableDht: false, ...options })
  const handles = new Set()
  /** What the session said of its peers and its sockets, as { at, message }. */
  const alerts = []
  const pump = setInterval(() => {
    for (const { message } of session.popAlerts()) if (/connect|error|reset|refused|listen|timed out/i.test(message)) alerts.push({ at: now(), message })
    for (const handle of handles) session.postStatus(handle)
  }, 250)
  closing.push(() => {
    clearInterval(pump)
    try { session.destroy() } finally { session.mod.__FKN?.teardown?.() }
  })
  const until = async (what, pass, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (pass()) return
    throw new Error(`${name}: ${what} not within ${ms} ms`)
  }
  return { session, dir, handles, alerts, until }
}

/** A UDP socket bound through the relay. Rejects when the relay refuses the bind. */
const bound = (relay, port = 0) => new Promise((resolve, reject) => {
  const socket = relay.dgram.createSocket()
  socket.once('listening', () => resolve(socket))
  socket.once('error', reject)
  socket.bind(port)
})

/** Asks for a socket every REBIND_EVERY_MS until the relay gives one: on `port` first when one is named. */
const rebound = async (relay, port = 0) => {
  for (;;) {
    for (const ask of port ? [port, 0] : [0]) {
      try { return await bound(relay, ask) } catch { /* the relay is away, or somebody holds that port */ }
    }
    await sleep(REBIND_EVERY_MS)
  }
}

// relay-host's send takes (bytes, offset, length, port, address) alone, where node's and @fkn/lib's also
// take what the entry calls: (bytes, port, address, callback)
const asNode = (socket) => ({
  send: (data, port, address, callback) => { socket.send(data, 0, data.length, port, address); callback?.(null) },
  on: (event, listener) => socket.on(event, listener),
  off: (event, listener) => socket.off(event, listener),
})

const main = async () => {
  const file = path.join(root, 'fixture', 'fixture.bin')
  writeFixture(file, SIZE_MB * 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })
  const withTracker = bencode({ ...bdecode(meta.torrent), announce: TRACKER })

  const { Server } = await import('bittorrent-tracker')
  const tracker = new Server({ http: false, udp: false, ws: true, stats: false })
  tracker.on('warning', () => {})
  tracker.on('error', () => {})
  await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve))
  const clients = new Set()
  tracker.ws.on('connection', (client) => clients.add(client))
  closing.push(() => new Promise((resolve) => {
    for (const client of clients) client.terminate()
    tracker.close(resolve)
  }))
  const trackerUrl = `ws://127.0.0.1:${tracker.ws.address().port}`
  class Routed extends WebSocket {
    constructor(asked) {
      if (asked !== TRACKER) throw new Error(`a socket to ${asked}`)
      super(trackerUrl)
    }
  }

  const seeding = async (seed, torrent) => {
    fs.copyFileSync(file, path.join(seed.dir, 'dl', meta.name))
    const handle = seed.session.addTorrentFile(torrent, '/dl')
    seed.handles.add(handle)
    await seed.until('seeding', () => seed.session.status(handle)?.state === 5)
    return handle
  }

  // the uTP seed, on node's own sockets
  const utpSeed = await engine('utp-seed', createNodeHost(), { rateLimits: { upload: UP_KBPS * 1024 } })
  await seeding(utpSeed, meta.torrent)
  await utpSeed.until('its port', () => utpSeed.session.reachable().port)
  const utpPort = utpSeed.session.reachable().port

  // the WebRTC seed: reached through the tracker alone
  let RemoteClass
  let native = null
  if (REMOTE === 'libdatachannel') {
    native = await import('node-datachannel')
    const { RTCPeerConnection } = await import('node-datachannel/polyfill')
    RemoteClass = class extends RTCPeerConnection {
      constructor(configuration) {
        super({ ...configuration, bindAddress: RTC_SEED })
      }
    }
    closing.push(() => native.cleanup())
  } else {
    const socket = dgram.createSocket('udp4')
    await new Promise((resolve) => socket.bind(0, RTC_SEED, resolve))
    const remote = await createWebRTC({ socket, address: RTC_SEED, port: socket.address().port, wasm, allowPrivateCandidates: true })
    RemoteClass = remote.RTCPeerConnection
    closing.push(() => { remote.close(); socket.close() })
  }
  const rtcSeed = await engine('rtc-seed', offlineHost(), { reserveListenPort: false, rateLimits: { upload: UP_KBPS * 1024 } })
  await seeding(rtcSeed, withTracker)
  const seedPeers = webtorrentPeers(rtcSeed.session, { links: rtcLinks({ RTCPeerConnection: RemoteClass, iceServers: [] }), WebSocket: Routed })
  closing.push(() => seedPeers.close())
  await rtcSeed.until('the tracker to list it', () => seedPeers.snapshot().torrents[0]?.trackers[0]?.seeders === 1)

  // our session, behind the relay
  const relay = createRelayHost()
  closing.push(() => relay.close())
  const ours = await engine('ours', relay)
  const { session } = ours
  const handle = session.addMagnet(`${magnetFor(meta.infoHash, meta.name, [{ host: '127.0.0.1', port: utpPort }])}&tr=${encodeURIComponent(TRACKER)}`, '/dl')
  ours.handles.add(handle)

  // the tracker socket goes through the relay too: it ends with the relay, and fails to open while it is away
  const throughRelay = new Set()
  class RelayWebSocket extends Routed {
    constructor(asked) {
      super(asked)
      throughRelay.add(this)
      this.addEventListener('close', () => throughRelay.delete(this))
      if (!relay.up) this.close()
    }
  }

  // the relay mode's WebRTC half
  const half = { peers: null, webrtc: null, ports: [], made: 0, events: [] }
  let stopped = false
  const start = (socket, over = asNode(socket)) => createWebRTC({ socket: over, address: OURS, port: socket.address().port, wasm, allowPrivateCandidates: true }).then((webrtc) => {
    half.webrtc = webrtc
    half.made++
    half.ports.push(socket.address().port)
    half.peers = webtorrentPeers(session, { links: rtcLinks({ RTCPeerConnection: webrtc.RTCPeerConnection }), WebSocket: RelayWebSocket, relay: true })
    half.events.push({ at: now(), event: 'swarm made', port: socket.address().port })
  })
  const ended = (socket) => new Promise((resolve) => socket.once('close', resolve))
  if (MODE === 'rebuild') {
    void (async () => {
      while (!stopped) {
        const socket = await rebound(relay, SAME_PORT ? half.ports.at(-1) : 0)
        if (stopped) return socket.close()
        const end = ended(socket)
        await start(socket)
        await end
        half.events.push({ at: now(), event: 'socket ended' })
        half.peers.close()
        half.webrtc.close()
      }
    })()
  } else if (MODE === 'keep') {
    // one socket to the factory for good, the relay's socket replaced under it
    const facade = new EventEmitter()
    let current = null
    const attach = (socket) => {
      current = socket
      half.events.push({ at: now(), event: 'socket attached', port: socket.address().port })
      socket.on('message', (bytes, remote) => facade.emit('message', bytes, remote))
      const port = socket.address().port
      void ended(socket).then(async () => {
        current = null
        half.events.push({ at: now(), event: 'socket ended' })
        const next = await rebound(relay, port)
        if (stopped) return next.close()
        attach(next)
      })
    }
    const first = await rebound(relay)
    attach(first)
    await start(first, {
      send: (data, port, address, callback) => { current?.send(data, 0, data.length, port, address); callback?.(null) },
      on: (event, listener) => facade.on(event, listener),
      off: (event, listener) => facade.off(event, listener),
    })
  } else {
    await start(await rebound(relay))
  }
  closing.push(() => { stopped = true; half.peers?.close(); half.webrtc?.close() })

  // What each kind of peer has delivered so far. libtorrent carries a peer's count over when it dials the
  // same address again, less the bytes that were no payload, so a count only ever adds what is above its last.
  const delivered = { utp: 0, webrtc: 0, tcp: 0 }
  const last = new Map()
  const count = (list) => {
    for (const { endpoint, transport, totalDownload } of list) {
      const before = last.get(endpoint) ?? 0
      if (totalDownload <= before) continue
      delivered[transport] += totalDownload - before
      last.set(endpoint, totalDownload)
    }
  }
  const samples = []
  const sample = setInterval(() => {
    session.peers(handle, 1000).then(count, () => {})
    const status = session.status(handle)
    if (!status) return
    const swarm = half.peers?.snapshot().torrents[0]
    samples.push({
      at: now(), done: status.totalDone, peers: status.numPeers, ...delivered,
      kinds: session.lastPeers(handle).map((peer) => peer.endpoint.startsWith('webrtc') ? peer.endpoint : peer.transport),
      open: swarm?.open ?? null, pending: swarm?.pending ?? null,
      seedOpen: seedPeers.snapshot().torrents[0]?.open ?? null,
    })
  }, 250)
  closing.push(() => clearInterval(sample))

  const size = meta.size
  await ours.until('both kinds of peer delivering', () => delivered.utp > 0 && delivered.webrtc > 0, 60_000)
  await ours.until(`${AT} of the file`, () => samples.at(-1)?.done >= AT * size, 120_000)
  const dropAt = now()
  relay.drop()
  for (const socket of throughRelay) socket.close()
  await sleep(OUTAGE_MS)
  await relay.restore({ portsTaken: MOVED })
  const restoreAt = now()
  for (const end = restoreAt + WATCH_MS; now() < end && samples.at(-1).done < size;) await sleep(250)

  const atRestore = samples.findLast((x) => x.at <= restoreAt)
  const after = samples.filter((x) => x.at > restoreAt)
  const again = (kind) => {
    const moved = after.find((x) => x[kind] > atRestore[kind])
    return moved ? moved.at - restoreAt : null
  }
  const lastBytes = (kind) => {
    const during = samples.filter((x) => x.at > dropAt && x.at <= restoreAt)
    const last = during.findLast((x, i) => i > 0 && x[kind] > during[i - 1][kind])
    return last ? last.at - dropAt : 0
  }
  const before = samples.findLast((x) => x.at <= dropAt)
  const summary = {
    mode: MODE, remote: REMOTE, outageMs: OUTAGE_MS, moved: MOVED, samePort: SAME_PORT,
    dropAt, restoreAt,
    webrtcAgainAfterRestoreMs: again('webrtc'),
    utpAgainAfterRestoreMs: again('utp'),
    webrtcLastBytesAfterDropMs: lastBytes('webrtc'),
    // the channel that carried bytes before the drop is the one that carries them after it
    sameChannel: before.kinds.filter((kind) => kind.startsWith('webrtc')).some((kind) => samples.at(-1).kinds.includes(kind)),
    channelsBefore: before.kinds.filter((kind) => kind.startsWith('webrtc')),
    channelsAtEnd: samples.at(-1).kinds.filter((kind) => kind.startsWith('webrtc')),
    webrtcSocketPorts: half.ports,
    factoriesMade: half.made,
    events: half.events,
    deliveredAtDrop: { utp: before.utp, webrtc: before.webrtc },
    deliveredAtEnd: { utp: samples.at(-1).utp, webrtc: samples.at(-1).webrtc },
    done: samples.at(-1).done, size,
    seedOpenAtEnd: samples.at(-1).seedOpen,
    reachable: session.reachable().listeners,
  }
  console.log(JSON.stringify(summary, null, 2))
  const out = arg('json', null)
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, samples, binds: relay.binds, alerts: ours.alerts, seedAlerts: utpSeed.alerts }, null, 1))
}

let finishing = false
const finish = async (code) => {
  if (finishing) return
  finishing = true
  for (const close of closing.reverse()) {
    try { await close() } catch { /* the rest still has to go */ }
  }
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
process.once('SIGTERM', () => void finish(143))
process.once('SIGINT', () => void finish(130))
main().then(() => finish(0), (error) => { console.error(error); return finish(1) })
