// destroy() is clean, removes each storage once, leaves no socket or handle, and a second session works, with a uTP
// peer still in its connect (one, four, pex, remove) or connected under a download ceiling (limited), each run a
// process of its own (tests/rig/destroy-engine.mjs) that has to end by itself; and a resume save it cuts short settles.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

import { MiB, fixture, startEngine, teardown } from './rig/stream-engine.mjs'

const SCRIPT = path.join(import.meta.dirname, 'rig', 'destroy-engine.mjs')
// ms after the mark: the last SYN, as the tcp fallback comes 3.3 to 3.6 s after the first; or the first byte, as an
// engine that freed the aborted session aborted there 63 times in 80 from 3 to 5 s, and 47 in 120 before 3 s
const CONNECTING = [0, 800, 1600, 2400]
const DELAYS = { one: CONNECTING, four: CONNECTING, pex: CONNECTING, remove: CONNECTING, limited: [3000, 3500, 4000, 4500] }

const run = (variant, ms) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, variant, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let killed = null
  let grace = null
  const kill = (why) => { killed ??= why; child.kill('SIGKILL') }
  const deadline = setTimeout(() => kill('no result within 40 s'), 40_000)
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    grace ??= setTimeout(() => kill('still running 5 s after its result'), 5000)
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code) => {
    clearTimeout(deadline)
    clearTimeout(grace)
    const line = stdout.split('\n').find((l) => l.startsWith('{'))
    resolve({ ms, code, killed, result: line ? JSON.parse(line) : null, stderr: stderr.slice(-1500) })
  })
})

for (const [variant, delays] of Object.entries(DELAYS)) {
  test(`a session destroyed with a uTP peer (${variant}) ends cleanly and leaves nothing, and the next one works`, async () => {
    for (const r of await Promise.all(delays.map((ms) => run(variant, ms)))) {
      const at = `${variant}, ${r.ms} ms after the mark`
      assert.ok(r.result, `${at}: no result (exit ${r.code}, ${r.killed ?? 'not killed'}): ${r.stderr}`)
      const { first, second } = r.result
      if (variant === 'limited') {
        assert.deepEqual(first.transport, ['utp'], `${at}: the leech's peers`)
        assert.equal(first.seed.outcome, 'clean', `${at}: the seed's destroy() ${first.seed.outcome}`)
        assert.deepEqual(first.seed.storages.removed, first.seed.storages.made, `${at}: the seed's storages removed`)
      } else {
        assert.equal(first.connects, 0, `${at}: the tcp fallback had started, so no uTP connect was in progress`)
      }
      assert.equal(first.outcome, 'clean', `${at}: destroy() ${first.outcome}`)
      assert.deepEqual(first.storages.removed, first.storages.made, `${at}: storages removed by destroy()`)
      assert.deepEqual(first.open, [], `${at}: host sockets left open`)
      assert.deepEqual(first.resources, [], `${at}: what still holds the process after destroy()`)
      assert.ok(second.sameBytes, `${at}: the second session saved other bytes`)
      assert.equal(second.outcome, 'clean', `${at}: the second destroy() ${second.outcome}`)
      assert.deepEqual(second.storages, { made: [0], removed: [0] }, `${at}: the second session's storages`)
      assert.deepEqual(second.open, [], `${at}: host sockets the second session left open`)
      assert.equal(r.killed, null, `${at}: ${r.killed}`)
      assert.equal(r.code, 0, `${at}: exit ${r.code}: ${r.stderr}`)
    }
  })
}

test('a resume save asked before destroy() is rejected by it, not left waiting', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running } = await startEngine(defer, path.join(fx.root, 'engine'))
  const saving = session.saveResumeData(await running(session.addTorrentFile(fx.meta.torrent, '/dl')), 5000)
  session.destroy()
  const settled = await Promise.race([
    saving.then(() => 'resolved', (error) => error.message),
    new Promise((resolve) => setTimeout(resolve, 500, 'still waiting 500 ms after destroy()')),
  ])
  assert.equal(settled, 'save_resume_data: session destroyed')
})
