// The dev harness in src/app, which CI never installs or builds.
//
// Its @fkn/lib is a local link, because the harness talks to fkn/local's web on :1234 and only a
// development build of the library is baked against that origin. The link named fkn/web/lib, a path
// that stopped existing at the 2026-08-29 fkn-client cutover, until 2026-10-04.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app')
const app = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(appDir, 'package-lock.json'), 'utf8'))
const spec = app.dependencies['@fkn/lib']
const target = spec.replace(/^file:/, '')

test('the harness links @fkn/lib from fkn-client, in the manifest and the lockfile alike', () => {
  assert.equal(spec, 'file:../../../horionsoftware/fkn-client/lib')
  assert.equal(app.overrides['@fkn/lib'], spec)
  assert.equal(lock.packages[''].dependencies['@fkn/lib'], spec)
  assert.equal(lock.packages['node_modules/@fkn/lib'].resolved, target)
  assert.equal(lock.packages[target]?.name, '@fkn/lib')
})

test('the link resolves to @fkn/lib where the sibling checkouts are present', (t) => {
  const siblings = resolve(appDir, '../../../horionsoftware')
  if (!existsSync(siblings)) return t.skip(`no sibling checkouts at ${siblings}`)
  const linked = JSON.parse(readFileSync(resolve(appDir, target, 'package.json'), 'utf8'))
  assert.equal(linked.name, '@fkn/lib')
})
