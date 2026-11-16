// A datagram reaching an idle session is read at once. A 16 ms timer after every tick that found
// nothing to do held each burst back, which capped a download from fast peers.

import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { startEngine, teardown, tempDir } from './rig/stream-engine.mjs'

const SAMPLES = 15

test('a datagram to an idle session is read within 5 ms', async (t) => {
  const defer = teardown(t)
  const { session } = await startEngine(defer, tempDir(defer), { host: countingHost(), reserveListenPort: true })
  const port = session.reachable().port
  assert.ok(port, 'no udp port was reserved')
  const sender = dgram.createSocket('udp4')
  defer(() => sender.close())
  const stats = session.mod.__FKN.stats

  const waits = []
  for (let i = 0; i < SAMPLES; i++) {
    // long enough for the ticks the last datagram started to have run out
    await new Promise((resolve) => setTimeout(resolve, 60))
    const before = stats.udpRx
    const sent = performance.now()
    sender.send(Buffer.from('x'), port, '127.0.0.1')
    while (stats.udpRx === before && performance.now() - sent < 1000) await new Promise(setImmediate)
    assert.notEqual(stats.udpRx, before, `datagram ${i} was not read within 1 s`)
    waits.push(performance.now() - sent)
  }
  waits.sort((a, b) => a - b)
  const median = waits[SAMPLES >> 1]
  assert.ok(median < 5, `median wait ${median.toFixed(2)} ms, all: ${waits.map((w) => w.toFixed(1)).join(' ')}`)
})
