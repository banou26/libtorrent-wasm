// A Chrome that does not launch has to fail the browser tests and let their file end. On Node 24 a file
// that keeps something open is ended by nothing, and the whole run waits with it.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('with a CHROME_BIN that is no Chrome the browser tests fail, and their file ends', () => {
  const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
  const run = spawnSync(process.execPath, [path('./browser.test.mjs')], {
    env: { ...process.env, CHROME_BIN: path('./no-such-chrome') },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(run.signal, null, `the file was still running after 30 s: ${run.stdout.slice(-400)}`)
  assert.equal(run.status, 1, run.stdout.slice(-400))
  assert.match(run.stdout, /no-such-chrome/)
})
