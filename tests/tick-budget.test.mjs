// A check of files already on disk, from a storage that answers every read at once, is one chain of handlers each
// readying the next. With the tick's 100 ms budget checked only between batches, one tick ran the whole check: 1.4 to
// 1.7 s for this 1 GiB on a desktop (2026-11-18), with nothing else in the thread running meanwhile.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { makeTorrent } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { MiB, startEngine, teardown, tempDir } from './rig/stream-engine.mjs'

const BUDGET_MS = 100
// room for a loaded runner (the longest tick reached 116 ms on 4 CPUs twice oversubscribed, 2026-11-19), which also
// lets a budget raised to about 190 ms pass
const LONGEST_TICK_MS = 200
// the engine's own fallback tick comes every 250 ms, so a tick ended on its budget and not followed at once waits ~150
const NEXT_TICK_MS = 50

test('a check of files already on disk runs in ticks of about the budget, back to back', async (t) => {
  const defer = teardown(t)
  const root = tempDir(defer)
  const file = path.join(root, 'stored.bin')
  // sparse: every byte reads back as zero, which the torrent's hashes are made of
  fs.closeSync(fs.openSync(file, 'w'))
  fs.truncateSync(file, 1024 * MiB)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })

  const { session } = await startEngine(defer, root)
  const ticks = []
  const tick = session.mod._lt_session_tick
  session.mod._lt_session_tick = () => {
    const at = performance.now()
    const ran = tick()
    ticks.push({ at, ms: performance.now() - at, ran })
    return ran
  }
  const longest = () => Math.max(...ticks.map((k) => k.ms))
  // from each tick that ended on its budget to the start of the next one
  const follows = () => ticks.slice(1).flatMap((next, i) =>
    ticks[i].ran > 0 && ticks[i].ms >= BUDGET_MS ? [next.at - (ticks[i].at + ticks[i].ms)] : [])
  const latestFollow = () => Math.max(0, ...follows())

  const handle = session.addTorrentFile(meta.torrent, '/')
  const checked = await waitFor('the check to end, or a tick to break a bound', () => {
    session.postStatus(handle)
    return session.status(handle)?.numPiecesHave === meta.pieces
      || longest() >= LONGEST_TICK_MS || latestFollow() >= NEXT_TICK_MS
  }, 60_000) && session.status(handle)?.numPiecesHave === meta.pieces

  assert.ok(longest() < LONGEST_TICK_MS, `a tick ran ${Math.round(longest())} ms`)
  assert.ok(latestFollow() < NEXT_TICK_MS, `a tick ended on its budget and the next began ${Math.round(latestFollow())} ms later`)
  assert.ok(checked, 'the check never found every piece, so a handler queued at a budget was lost')
  // THE CONTROL: the check was long enough that one tick running it whole would have broken the bound
  const busy = ticks.reduce((sum, k) => sum + k.ms, 0)
  assert.ok(busy > 3 * LONGEST_TICK_MS, `the check took ${Math.round(busy)} ms of ticks, too short to tell`)
  assert.ok(follows().length >= 3, `only ${follows().length} ticks ended on their budget`)
})
