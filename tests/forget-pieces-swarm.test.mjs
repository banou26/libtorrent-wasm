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

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i)

test('forgotten pieces leave the bitfield and download again intact, and busy ones are left alone', async (t) => {
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
  const prios = new Uint8Array(PIECES).fill(PRIORITY.normal)
  s.prioritizePieces(h, prios)
  s.setSequential(h, true)
  await waitFor('pieces 0 to 23', () => held(0, 24) === 24, 120_000)

  // everything still missing, while it downloads at full speed
  const missing = range(0, PIECES).filter((p) => !have(p))
  const midway = s.forgetPieces(h, missing)
  assert.ok(midway && midway.busy >= 1, `no piece was busy mid download: ${JSON.stringify(midway)}`)
  t.diagnostic(`mid download: ${JSON.stringify(midway)} of ${missing.length} missing`)
  assert.deepEqual(s.forgetPieces(h, range(PIECES - 8, PIECES)), { forgotten: 0, busy: 0 }, 'pieces never started')

  // skipped and wanted pieces forgotten and dropped, then the skipped ones wanted again, as a seek back
  // does. That a skipped piece is not asked for meanwhile is tested in forget-pieces.test.mjs, where a
  // scripted seed sees every request
  prios.fill(PRIORITY.skip, 0, 8)
  s.prioritizePieces(h, prios)
  assert.deepEqual(s.forgetPieces(h, range(0, 8)), { forgotten: 8, busy: 0 })
  assert.deepEqual(s.forgetPieces(h, range(8, 12)), { forgotten: 4, busy: 0 })
  assert.equal(held(0, 12), 0, 'the bitfield still shows forgotten pieces')
  const fd = fs.openSync(rig.storage.filePath(s.files(h).storageIndex, 0), 'r+')
  fs.writeSync(fd, Buffer.alloc(12 * MiB), 0, 12 * MiB, 0)
  fs.closeSync(fd)
  prios.fill(PRIORITY.normal, 0, 8)
  s.prioritizePieces(h, prios)
  await waitFor('pieces 0 to 11 again', () => held(0, 12) === 12, 60_000)
  assert.equal(held(12, 24), 12, 'a piece that was not forgotten went missing')
  const st = s.status(h)
  assert.equal(st.paused, false, 'the torrent paused')
  assert.equal(st.errorCode, 0, st.error)
  assert.ok([TORRENT_STATE.downloading, TORRENT_STATE.seeding].includes(st.state), `state ${st.state}`)
  const head = await s.read(h, 0, 0, 12 * MiB)
  assert.ok(Buffer.from(head).equals(bytes.subarray(0, 12 * MiB)), 'the pieces downloaded again differ from the fixture')

  await waitFor('the whole file', () => held(0, PIECES) === PIECES && s.status(h).state === TORRENT_STATE.seeding, 120_000)
  const all = await s.read(h, 0, 0, PIECES * MiB)
  assert.ok(Buffer.from(all).equals(bytes), 'the file differs from the fixture')
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  assert.equal(s.forgetPieces(h, [0, 1]), null, 'a finished seed forgot pieces')
})
