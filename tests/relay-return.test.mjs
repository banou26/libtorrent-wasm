// A relay that comes back after an outage: the download has to move again within seconds, on the
// port the engine had. Two real engines on loopback, one of them behind a relay taken away for 22 s.
//
// Why 22 s: the seed is this engine, whose uTP resends back off to 21.0 s and then 38.2 s after its
// last acknowledged packet, so a connection that is merely kept would not move again before 16 s
// after the relay's return, and a peer that has to wait out min_reconnect_time waits 60 s.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
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
  const next = async (what, pass, reportsLeft) => {
    for (let i = 0; i < reportsLeft; i++) {
      await new Promise((resolve) => { wake = resolve })
      if (pass(last)) return last
    }
    assert.fail(`${what}: not within ${reportsLeft / 4} s, last report ${JSON.stringify(last)}`)
  }
  return { next, last: () => last }
}

/** A seed and a leech on loopback with 3 MiB moved, the one named `behind` behind the relay. */
const swarm = async (t, behind) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-relay-return-'))
  const file = path.join(dir, 'seed', 'fixture.bin')
  writeFixture(file, 16 * MiB)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })
  const workers = []
  t.after(async () => {
    await Promise.all(workers.map((w) => w.terminate()))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const start = (workerData) => {
    const worker = new Worker(ENGINE, { workerData: { dir, ...workerData } })
    workers.push(worker)
    return { worker, ...reports(worker) }
  }

  const seed = start({ role: 'seed', torrent: new Uint8Array(meta.torrent), uploadBps: 400_000, relay: behind === 'seed' })
  const seeding = await seed.next('the seed checking its file', (r) => r.seeding && r.port, 120)
  const leech = start({ role: 'leech', magnet: magnetFor(meta.infoHash, meta.name, [{ host: '127.0.0.1', port: seeding.port }]), relay: behind === 'leech' })
  await leech.next('3 MiB in', (r) => r.done >= 3 * MiB, 160)
  const relayed = behind === 'seed' ? seed : leech

  // the relay away for `ms`, then back: the report that says it is back, and what the leech had then
  const outage = async (ms) => {
    const before = relayed.last()
    relayed.worker.postMessage('drop')
    await sleep(ms)
    const asked = Date.now()
    relayed.worker.postMessage('restore')
    const back = await relayed.next('the relay back', (r) => r.restoreAt >= asked, 8)
    return { before, back, done: leech.last().done }
  }
  const resumed = async ({ back, done }) => {
    const moving = await leech.next('bytes after the relay came back', (r) => r.done > done, RESUME_MS / 250)
    t.diagnostic(`bytes again ${moving.at - back.restoreAt} ms after the relay came back`)
    return moving
  }
  return { seeding, relayed, outage, resumed }
}

describe('a relay that comes back after 22 s', { concurrency: true }, () => {
  it('a download behind it moves again within 10 s, on the port it had', async (t) => {
    const { seeding, relayed, outage, resumed } = await swarm(t, 'leech')
    const returned = await outage(OUTAGE_MS)
    const { before } = returned
    assert.ok(before.portOpen && before.port, `the port was not open before the outage: ${JSON.stringify(before)}`)
    await resumed(returned)
    const now = relayed.last()
    assert.equal(now.port, before.port)
    assert.ok(now.portOpen, `the port was given up: ${JSON.stringify(now.listeners)}`)
    assert.deepEqual(now.listeners.map((l) => l.port), [before.port, before.port])

    // A transmission seed keeps its side of the old connection and turns a redial away until that
    // reset, which it matches on the id our packets carried. A libtorrent one also checks the ack, but
    // takes the FIN of our disconnect as well, so here only what the reset says can be checked; its
    // effect shows against transmission (tests/rig/relay-outage.mjs).
    const seedAt = `127.0.0.1:${seeding.port}`
    const last = now.lastBefore[seedAt]
    assert.ok(last, `no uTP packet went to the seed before the outage: ${JSON.stringify(now.lastBefore)}`)
    const reset = now.resets.find((r) => r.to === seedAt)
    assert.ok(reset, `no reset went to the seed after the relay came back: ${JSON.stringify(now.resets)}`)
    assert.equal(reset.id, last.id, 'the reset names another connection')
    assert.ok(((reset.ack - last.ack) & 0xffff) < 64, `the reset acknowledges ${reset.ack}, the connection was at ${last.ack}`)
  })

  // the leech dialled the seed over uTP, so the seed cannot dial it back and has to keep the connection
  it('a seed behind it serves a peer that dialled in again within 10 s', async (t) => {
    const { outage, resumed } = await swarm(t, 'seed')
    await resumed(await outage(OUTAGE_MS))
  })

  // two outages take 63 s, past the 60 s the suite gives a test
  it('a download behind it moves again within 10 s of its return when it went away again 1 s after the first', { timeout: 120_000 }, async (t) => {
    const { relayed, outage, resumed } = await swarm(t, 'leech')
    const first = await outage(OUTAGE_MS)
    await relayed.next('both sockets back', (r) => r.at > first.back.restoreAt && r.listeners.every((l) => l.up), 16)
    await sleep(1_000)
    await resumed(await outage(OUTAGE_MS))
  })
})
