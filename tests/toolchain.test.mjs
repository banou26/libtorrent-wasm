// vite-plus bundles its own vitest and ships vite as vite-plus-core, and its docs require a project to
// pin both to the same release ("Updating the Vitest Pin" at viteplus.dev). A pin left behind on a
// vite-plus bump keeps installing the previous runner. This repo had no vitest pin and carried the
// vulnerable vitest 4.1.10 (GHSA-82fw-gwwq-j7x9) under vite-plus 0.2.4 until 2026-09-24.
//
// Reads package.json and package-lock.json only, never node_modules, so it runs from git alone.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

const installed = (pattern) => Object.entries(lock.packages).filter(([path]) => pattern.test(path))
const vitePlus = lock.packages['node_modules/vite-plus']
const core = `npm:@voidzero-dev/vite-plus-core@${vitePlus.version}`

test('the vite alias names the core of the installed vite-plus, everywhere npm reads it', () => {
  assert.equal(manifest.devDependencies['vite-plus'], vitePlus.version)
  assert.equal(manifest.devDependencies.vite, core)
  assert.equal(manifest.overrides?.vite, core)
  const vites = installed(/(^|\/)node_modules\/vite$/).map(
    ([, entry]) => `${entry.name}@${entry.version}`,
  )
  assert.deepEqual(vites, [`@voidzero-dev/vite-plus-core@${vitePlus.version}`])
})

test('the core and every native binding are from the same vite-plus release', () => {
  const parts = installed(/(^|\/)node_modules\/@voidzero-dev\/vite-plus-[^/]+$/)
  assert.ok(
    parts.length > 1,
    'the scan found no @voidzero-dev package at all, so it proves nothing',
  )
  const off = parts
    .filter(([, entry]) => entry.version !== vitePlus.version)
    .map(([path, entry]) => `${path}@${entry.version}`)
  assert.deepEqual(off, [])
})

test('the vitest pin is the vitest vite-plus itself depends on', () => {
  assert.ok(vitePlus.dependencies?.vitest, 'the lockfile records no vitest under vite-plus')
  assert.equal(manifest.overrides?.vitest, vitePlus.dependencies.vitest)
})

test('one vitest is installed, and every @vitest package is at the pinned version', () => {
  const copies = installed(/(^|\/)node_modules\/(vitest|@vitest\/[^/]+)$/)
  assert.ok(copies.length > 1, 'the scan found no vitest at all, so it proves nothing')
  const off = copies
    .filter(([, entry]) => entry.version !== manifest.overrides?.vitest)
    .map(([path, entry]) => `${path}@${entry.version}`)
  assert.deepEqual(off, [])
  assert.equal(copies.filter(([path]) => path.endsWith('node_modules/vitest')).length, 1)
})
