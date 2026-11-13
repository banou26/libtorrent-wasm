// What the bundler writes for the two entries.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const imports = async entry => {
  const source = await readFile(new URL(`../../build/webtorrent/${entry}.js`, import.meta.url), 'utf8')
  return [...source.matchAll(/^import .+ from "(.+)";$/gm)].map(match => match[1])
}

test('the two entries share one chunk under a fixed name, so a rebuild overwrites it and leaves none behind', async () => {
  assert.deepEqual(await imports('index'), ['./shared.js'])
  assert.deepEqual(await imports('page'), ['./shared.js'])
})

test('the platform\'s class, the ponyfill\'s and the WebRTC entry\'s each fit what rtcLinks takes, with no cast', () => {
  // types/classes.ts hands each class to the links, against the declarations as built, and three classes
  // the signalling could not drive, which the compiler has to refuse
  const path = relative => fileURLToPath(new URL(relative, import.meta.url))
  const { status, stdout, stderr } = spawnSync(path('../../node_modules/.bin/tsc'), ['-p', path('./types')], { encoding: 'utf8' })
  assert.equal(status, 0, stdout + stderr)
})
