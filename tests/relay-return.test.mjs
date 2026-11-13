// A relay that comes back after an outage: the download has to move again within seconds, on the
// port the engine had. Two real engines on loopback, the leech behind a relay taken away for 22 s.
//
// Why 22 s: the seed is this engine, whose uTP resends back off to 21.0 s and then 38.2 s after its
// last acknowledged packet, so a connection that is merely kept would not move again before 16 s
// after the relay's return, and a redial the seed turns away (it still holds the old connection)
// waits out min_reconnect_time, 60 s.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'

const ENGINE = new URL('./rig/outage-swarm.mjs', import.meta.url)
const MiB = 1 << 20
const OUTAGE_MS = 22_000
// what the relay's return may cost: up to 2 s to find it, 2 s for the seed to dial back, then the redial
const RESUME_MS = 10_000

const reports = (worker) => {
  let last = null
  let wake = null
  worker.on('message', (r) => { last = r; wake?.() })
  // the next report that passes, waiting at most `reportsLeft` reports of 250 ms
  return async (what, pass, reportsLeft) => {
    for (let i = 0; i < reportsLeft; i++) {
      await new Promise((resolve) => { wake = resolve })
      if (pass(last)) return last
    }
    assert.fail(`${what}: not within ${reportsLeft / 4} s, last report ${JSON.stringify(last)}`)
  }
}

test('after a 22 s outage the download moves again within 10 s, on the port it had', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-relay-return-'))
  const file = path.join(dir, 'seed', 'fixture.bin')
  writeFixture(file, 16 * MiB)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })
  const workers = []
  t.after(async () => {
    await Promise.all(workers.map((w) => w.terminate()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const seed = new Worker(ENGINE, { workerData: { role: 'seed', dir, torrent: new Uint8Array(meta.torrent), uploadBps: 400_000 } })
  workers.push(seed)
  const seedReport = reports(seed)
  const seeding = await seedReport('the seed checking its file', (r) => r.seeding && r.port, 120)

  const leech = new Worker(ENGINE, {
    workerData: {
      role: 'leech', dir,
      magnet: magnetFor(meta.infoHash, meta.name, [{ host: '127.0.0.1', port: seeding.port }]),
      dropAt: 3 * MiB, outageMs: OUTAGE_MS,
    },
  })
  workers.push(leech)
  const next = reports(leech)
  const before = await next('the relay taken away', (r) => r.dropAt != null, 160)
  assert.ok(before.portOpen && before.port, `the port was not open before the outage: ${JSON.stringify(before)}`)
  const back = await next('the relay back', (r) => r.restoreAt != null, OUTAGE_MS / 250 + 8)
  const moving = await next('bytes after the relay came back', (r) => r.done > back.done, RESUME_MS / 250)
  t.diagnostic(`bytes again ${moving.at - back.restoreAt} ms after the relay came back`)
  assert.equal(moving.port, before.port)
  assert.ok(moving.portOpen, `the port was given up: ${JSON.stringify(moving.listeners)}`)
  assert.deepEqual(moving.listeners.map((l) => l.port), [before.port, before.port])

  // A transmission seed keeps its side of the old connection and turns a redial away until that
  // reset, which it matches on the id our packets carried. A libtorrent one also checks the ack.
  const seedAt = `127.0.0.1:${seeding.port}`
  const last = before.lastBefore[seedAt]
  assert.ok(last, `no uTP packet went to the seed before the outage: ${JSON.stringify(before.lastBefore)}`)
  const reset = moving.resets.find((r) => r.to === seedAt)
  assert.ok(reset, `no reset went to the seed after the relay came back: ${JSON.stringify(moving.resets)}`)
  assert.equal(reset.id, last.id, 'the reset names another connection')
  assert.ok(((reset.ack - last.ack) & 0xffff) < 64, `the reset acknowledges ${reset.ack}, the connection was at ${last.ack}`)
})
