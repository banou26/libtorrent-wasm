// A session destroyed while a uTP connect was in progress aborted inside the wasm: the io_context was freed before
// the session's abort had run, and the connecting socket, kept alive by its own connect handler, was freed after the
// packet pool it hands its SYN back to. The abort then skipped the shim's teardown, so the process never ended.
// Each case runs in its own process (tests/rig/destroy-engine.mjs), which has to end by itself.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

const SCRIPT = path.join(import.meta.dirname, 'rig', 'destroy-engine.mjs')
// after the last SYN is seen; the engine falls back to tcp 3.3 to 3.6 s after the first
const DELAYS = [0, 800, 1600, 2400]

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

for (const variant of ['one', 'four', 'pex', 'remove']) {
  test(`a session destroyed during its uTP connects (${variant}) ends cleanly and leaves nothing, and the next one works`, async () => {
    for (const r of await Promise.all(DELAYS.map((ms) => run(variant, ms)))) {
      const at = `${variant}, ${r.ms} ms after the SYN`
      assert.ok(r.result, `${at}: no result (exit ${r.code}, ${r.killed ?? 'not killed'}): ${r.stderr}`)
      const { first, second } = r.result
      assert.equal(first.connects, 0, `${at}: the tcp fallback had started, so no uTP connect was in progress`)
      assert.equal(first.outcome, 'clean', `${at}: destroy() ${first.outcome}`)
      assert.deepEqual(first.open, [], `${at}: host sockets left open`)
      assert.deepEqual(first.resources, [], `${at}: what still holds the process after destroy()`)
      assert.ok(second.sameBytes, `${at}: the second session saved other bytes`)
      assert.equal(second.outcome, 'clean', `${at}: the second destroy() ${second.outcome}`)
      assert.deepEqual(second.open, [], `${at}: host sockets the second session left open`)
      assert.equal(r.killed, null, `${at}: ${r.killed}`)
      assert.equal(r.code, 0, `${at}: exit ${r.code}: ${r.stderr}`)
    }
  })
}
