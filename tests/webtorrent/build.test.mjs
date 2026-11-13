// What the bundler writes for the two entries.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const imports = async entry => {
  const source = await readFile(new URL(`../../build/webtorrent/${entry}.js`, import.meta.url), 'utf8')
  return [...source.matchAll(/^import .+ from "(.+)";$/gm)].map(match => match[1])
}

test('the two entries share one chunk under a fixed name, so a rebuild overwrites it and leaves none behind', async () => {
  assert.deepEqual(await imports('index'), ['./shared.js'])
  assert.deepEqual(await imports('page'), ['./shared.js'])
})
