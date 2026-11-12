// When the relay refuses or drops the engine's sockets, the engine has to keep running and heal.
// This one runs the real wasm: the stall it guards lives in libtorrent's reactor, which the
// shim-only tests (udp-reopen.test.mjs) cannot reach.

import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

const ENGINE = new URL('./rig/outage-engine.mjs', import.meta.url)

const run = (scenario, ms) => new Promise((resolve, reject) => {
  const worker = new Worker(ENGINE, { workerData: scenario })
  const arrivals = []
  let last = null
  worker.on('message', (report) => { arrivals.push(performance.now()); last = report })
  worker.on('error', reject)
  setTimeout(async () => {
    await worker.terminate()
    const times = [...arrivals, performance.now()]
    const maxGapMs = Math.max(...times.slice(1).map((t, i) => t - times[i]))
    resolve({ reported: !!last, ...last, maxGapMs })
  }, ms)
})

const keptRunning = (r) => {
  assert.ok(r.reported, 'the engine never reported')
  assert.ok(r.maxGapMs < 1000, `the worker stopped answering for ${Math.round(r.maxGapMs)} ms`)
  assert.ok(r.maxTickMs < 1000, `one tick ran for ${Math.round(r.maxTickMs)} ms`)
  assert.ok(r.statusUpdatesAfterOutage > 0, 'no status alert reached the host after the outage')
}

const healed = (r) => {
  assert.ok(r.udpReopen >= 1, 'the udp socket was never reopened')
  assert.ok(r.udpSockets >= 2 && r.healedAt != null, 'no replacement udp socket was ever bound')
  assert.equal(r.udpDead, false, 'the udp fd is still waiting for a socket')
  const after = r.probes.find((p) => p.port === 7001)
  assert.ok(after?.answered, `a datagram on the replacement socket got no answer: ${JSON.stringify(r.probes)}`)
}

test('a refused udp bind leaves the engine running until the socket binds', async () => {
  const r = await run({ refuseUdpBinds: 3 }, 4000)
  keptRunning(r)
  healed(r)
})

test('a udp socket dropped with error then close heals, and so does the listener', async () => {
  const r = await run({ dropAt: 1500 }, 4000)
  assert.ok(r.probes.find((p) => p.port === 7000)?.answered, 'the probe got no answer before the drop')
  keptRunning(r)
  healed(r)
  // select hands a listener with a pending error to accept() on every pass
  assert.equal(r.acceptEmpty, 0, `accept() was called ${r.acceptEmpty} times with nothing to accept`)
})

test('a udp socket dropped with close alone heals', async () => {
  const r = await run({ dropAt: 1500, dropWith: 'close' }, 4000)
  assert.ok(r.probes.find((p) => p.port === 7000)?.answered, 'the probe got no answer before the drop')
  keptRunning(r)
  healed(r)
  assert.equal(r.acceptEmpty, 0)
})

test('a uTP dial waiting on a socket being replaced does not spin', async () => {
  const r = await run({ refuseUdpBinds: 4, dialWhileDead: '192.0.2.10:6881' }, 7500)
  keptRunning(r)
  // at least one send was turned away, or the dial never waited on the dead socket
  assert.ok(r.unsent >= 1 && r.unsent < 100, `${r.unsent} sends were turned away while the socket was gone`)
  healed(r)
})
