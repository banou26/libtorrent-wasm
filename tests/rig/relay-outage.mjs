#!/usr/bin/env node
// A download from transmission seeders whose relay is taken away part way through, timed second by
// second: when the bytes stop, when the sockets and the peers come back, when the bytes move again.
//
//   node tests/rig/relay-outage.mjs [--outage MS] [--moved] [--at FRACTION] [--budget MS]
//                                   [--seeders N] [--up KBPS] [--size MB] [--play] [--json out.json]
//
// --moved brings the relay back with the ports its sockets held taken by somebody else. --play reads
// the file from the start the way ripple's player does, stall loop included.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Rig } from './harness.mjs'
import { SeederFleet } from './seeders.mjs'
import { createRelayHost } from './relay-host.mjs'
import { makeTorrent, magnetFor, writeFixture } from './make-torrent.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback
}
const OUTAGE_MS = Number(arg('outage', 20_000))
const MOVED = process.argv.includes('--moved')
const AT = Number(arg('at', 0.2))
const BUDGET_MS = Number(arg('budget', 360_000))
const SEEDERS = Number(arg('seeders', 4))
const UP_KBPS = Number(arg('up', 100))
const SIZE_MB = Number(arg('size', 30))
const PLAY = process.argv.includes('--play')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-relay-outage-'))

const main = async () => {
  const fixtureDir = path.join(root, 'fixture')
  const file = path.join(fixtureDir, 'fixture.bin')
  writeFixture(file, SIZE_MB * 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })
  const torrentFile = path.join(fixtureDir, 'fixture.torrent')
  fs.writeFileSync(torrentFile, meta.torrent)
  const fleet = new SeederFleet({
    dir: path.join(root, 'seeders'), dataDir: fixtureDir, torrentFile, count: SEEDERS, uploadKBps: UP_KBPS,
    basePeerPort: 51800, baseRpcPort: 9600,
  })
  const relay = createRelayHost()
  const rig = new Rig({ storageDir: path.join(root, 'download'), host: relay })

  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)
  const shim = []
  const warn = console.warn
  console.warn = (...a) => { shim.push({ at: now(), line: a.join(' ') }); warn(...a) }

  const samples = []
  const peerLists = []
  const alerts = []
  const reads = []
  let dropAt = null
  let restoreAt = null
  let size = Infinity
  try {
    const peers = await fleet.start()
    await fleet.waitSeeding()
    await rig.start()
    const s = rig.session
    const h = s.addMagnet(magnetFor(meta.infoHash, meta.name, peers), '/dl')
    // the rig's pump drains alerts on its own and keeps only counts, so read them here first
    const pop = s.popAlerts.bind(s)
    s.popAlerts = () => {
      const out = pop()
      for (const a of out) if (/disconnect|connect|error|time|reset|refused|listen/i.test(a.message)) alerts.push({ at: now(), message: a.message })
      return out
    }
    rig.startPump([h])
    await rig.waitForMetadata(h)
    size = s.files(h).files[0].size
    let played = null
    if (PLAY) {
      rig.watch('rig', h, 0, 0)
      played = rig.playFrom(h, 0).then((bytes) => ({ at: now(), bytes }), (err) => ({ at: now(), error: String(err) }))
    }

    let lastPeers = 0
    const sample = setInterval(() => {
      const st = s.status(h)
      if (!st) return
      const r = s.reachable()
      samples.push({
        at: now(), done: st.totalDone, rate: st.downloadRate, peers: st.numPeers,
        port: r.port, portOpen: r.portOpen, listeners: r.listeners.map((l) => `${l.transport}:${l.port}:${l.up ? 'up' : 'down'}${l.healing ? ':healing' : ''}`),
      })
      if (now() - lastPeers >= 2000) {
        lastPeers = now()
        s.peers(h).then((list) => peerLists.push({
          at: now(), peers: list.map((p) => ({ endpoint: p.endpoint, transport: p.transport, got: p.totalDownload, rtt: p.rtt })),
        }), () => {})
      }
    }, 500)

    const doneAt = (fraction) => samples.at(-1)?.done >= fraction * size
    while (!doneAt(AT)) await sleep(100)
    dropAt = now()
    relay.drop()
    await sleep(OUTAGE_MS)
    await relay.restore({ portsTaken: MOVED })
    restoreAt = now()
    const deadline = restoreAt + BUDGET_MS
    while (now() < deadline && !doneAt(1)) await sleep(250)
    clearInterval(sample)
    if (played) reads.push(await Promise.race([played, sleep(1000).then(() => ({ at: now(), pending: true }))]))
  } finally {
    console.warn = warn
    await rig.stop()
    await fleet.stop()
    relay.close()
  }

  const atDrop = samples.findLast((x) => x.at <= dropAt)?.done ?? 0
  const after = samples.filter((x) => x.at >= restoreAt)
  const moving = after.find((x) => x.done > (samples.findLast((y) => y.at <= restoreAt)?.done ?? atDrop))
  const allUp = after.find((x) => x.listeners.length && x.listeners.every((l) => l.includes(':up')))
  const noPeers = samples.find((x) => x.at > dropAt && x.peers === 0)
  const peersBack = noPeers && samples.find((x) => x.at > noPeers.at && x.peers > 0)
  const summary = {
    outageMs: OUTAGE_MS, moved: MOVED,
    dropAt, restoreAt,
    bytesAgainAfterRestoreMs: moving ? moving.at - restoreAt : null,
    socketsUpAfterRestoreMs: allUp ? allUp.at - restoreAt : null,
    peersGoneAfterDropMs: noPeers ? noPeers.at - dropAt : null,
    peersBackAfterDropMs: peersBack ? peersBack.at - dropAt : null,
    completeAfterRestoreMs: (samples.find((x) => x.done >= size)?.at ?? NaN) - restoreAt,
    final: samples.at(-1),
    play: reads[0] ?? null,
    stalls: rig.metrics.stalls.length,
  }
  console.log(JSON.stringify(summary, null, 2))
  const out = arg('json', null)
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, samples, peerLists, alerts, shim, binds: relay.binds }, null, 1))
}

main().then(
  () => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0) },
  (err) => { console.error(err); fs.rmSync(root, { recursive: true, force: true }); process.exit(1) },
)
