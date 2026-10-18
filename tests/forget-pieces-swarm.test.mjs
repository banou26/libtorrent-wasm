// Session.forgetPieces (patch 0010) on the loopback swarm: two transmission seeders, so the
// pieces come back from a real client. Needs transmission (tests/rig/README.md), like
// tests/rate-limits.test.mjs, so test:ci leaves it out.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PRIORITY, TORRENT_STATE } from '../build/index.js'
import { Rig } from './rig/harness.mjs'
import { SeederFleet } from './rig/seeders.mjs'
import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'

const MiB = 1 << 20
const PIECES = 96

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i)

test('forgotten pieces leave the bitfield, stay missing while skipped and download again intact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-forget-swarm-'))
  const fixtureDir = path.join(root, 'fixture')
  const file = path.join(fixtureDir, 'fixture.bin')
  writeFixture(file, PIECES * MiB)
  const bytes = fs.readFileSync(file)
  const meta = makeTorrent({ file, pieceLength: MiB })
  const torrentFile = path.join(fixtureDir, 'fixture.torrent')
  fs.writeFileSync(torrentFile, meta.torrent)
  const fleet = new SeederFleet({
    dir: path.join(root, 'seeders'), dataDir: fixtureDir, torrentFile, count: 2, uploadKBps: 4 * 1024,
    // node --test runs files in parallel, and tests/rate-limits.test.mjs holds the default ports
    basePeerPort: 51600, baseRpcPort: 9300,
  })
  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false })
  t.after(async () => {
    await fleet.stop()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const peers = await fleet.start()
  await fleet.waitSeeding()
  await rig.start()
  const s = rig.session
  const h = s.addMagnet(magnetFor(meta.infoHash, meta.name, peers), '/dl')
  rig.startPump([h])
  await rig.waitForMetadata(h)
  const have = (p) => { const bf = s.bitfield(h); return !!bf && (bf.pieces[p >> 3] & (0x80 >> (p & 7))) !== 0 }
  const held = (a, b) => range(a, b).filter(have).length
  const healthy = (what) => {
    const st = s.status(h)
    assert.equal(st.paused, false, `${what}: the torrent paused`)
    assert.equal(st.errorCode, 0, `${what}: ${st.error}`)
    assert.ok(st.numPeers >= 1, `${what}: the seeders left`)
    assert.equal(st.state, TORRENT_STATE.downloading, `${what}: state ${st.state}`)
  }
  const prios = new Uint8Array(PIECES).fill(PRIORITY.normal)
  s.prioritizePieces(h, prios)
  s.setSequential(h, true)

  // a trickle once the head is in, so the rest stays wanted and the seeders stay connected
  await waitFor('pieces 0 to 23', () => held(0, 24) === 24, 120_000)
  s.setDownloadLimit(h, 16 * 1024)
  await sleep(1000)

  assert.deepEqual(s.forgetPieces(h, range(PIECES - 8, PIECES)), { forgotten: 0, busy: 0 }, 'pieces never started')

  prios.fill(PRIORITY.skip, 0, 8)
  s.prioritizePieces(h, prios)
  assert.deepEqual(s.forgetPieces(h, range(0, 8)), { forgotten: 8, busy: 0 })
  assert.equal(held(0, 8), 0, 'the bitfield still shows forgotten pieces')
  // what a storage that dropped the bytes leaves behind
  const fd = fs.openSync(rig.storage.filePath(s.files(h).storageIndex, 0), 'r+')
  fs.writeSync(fd, Buffer.alloc(8 * MiB), 0, 8 * MiB, 0)
  fs.closeSync(fd)
  await sleep(3000)
  assert.equal(held(0, 8), 0, 'a skipped forgotten piece came back')
  assert.equal(held(8, 24), 16, 'a piece that was not forgotten went missing')
  healthy('while skipped')

  prios.fill(PRIORITY.normal, 0, 8)
  s.prioritizePieces(h, prios)
  s.setDownloadLimit(h, 0)
  await waitFor('pieces 0 to 7 again', () => held(0, 8) === 8, 60_000)
  healthy('once wanted again')
  const head = await s.read(h, 0, 0, 8 * MiB)
  assert.ok(Buffer.from(head).equals(bytes.subarray(0, 8 * MiB)), 'the pieces downloaded again differ from the fixture')

  // everything still missing, while it downloads at full speed
  const missing = range(0, PIECES).filter((p) => !have(p))
  const midway = s.forgetPieces(h, missing)
  assert.ok(midway && midway.busy >= 1, `no piece was busy mid download: ${JSON.stringify(midway)}`)
  t.diagnostic(`mid download: ${JSON.stringify(midway)} of ${missing.length} missing`)

  await waitFor('the whole file', () => held(0, PIECES) === PIECES && s.status(h).state === TORRENT_STATE.seeding, 120_000)
  const all = await s.read(h, 0, 0, PIECES * MiB)
  assert.ok(Buffer.from(all).equals(bytes), 'the file differs from the fixture')
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  assert.equal(s.forgetPieces(h, [0, 1]), null, 'a finished seed forgot pieces')
})
