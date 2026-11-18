// A quiet session ticks on its fallback timer alone. Following each fallback tick that ran one of libtorrent's own
// timers with a tick of the shim's, which then found nothing, took a quiet session from 3.9 to 5.6 ticks a second
// (node, 2026-11-19).

import assert from 'node:assert/strict'
import test from 'node:test'

import { startEngine, teardown, tempDir } from './rig/stream-engine.mjs'

test('a quiet session ticks only on its fallback timer', async (t) => {
  const defer = teardown(t)
  const { session } = await startEngine(defer, tempDir(defer))
  const fkn = session.mod.__FKN
  let ran = 0
  const tick = session.mod._lt_session_tick
  session.mod._lt_session_tick = () => { const n = tick(); ran += n; return n }
  await new Promise((resolve) => setTimeout(resolve, 500))
  const before = fkn.stats.tick
  ran = 0
  await new Promise((resolve) => setTimeout(resolve, 3000))
  // THE CONTROL: libtorrent's own timers ran in this window, so a tick that ran one could have scheduled another
  assert.ok(ran > 0, 'no handler ran in 3 s, so nothing could have scheduled a tick')
  assert.equal(fkn.stats.tick - before, 0, 'the shim ticked in a quiet session')
})
