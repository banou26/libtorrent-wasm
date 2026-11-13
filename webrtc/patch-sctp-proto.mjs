// Puts sctp-proto where the [patch] in Cargo.toml looks for it, webrtc/vendor/sctp-proto: the
// crate as crates.io has it, with webrtc/patches applied in order. Does nothing when that is
// already there for these patches, so cargo sees no change and rebuilds nothing.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CRATE = 'sctp-proto-0.10.8'
// what Cargo.lock held for it before the [patch]: the archive is this one or the build stops
const SHA256 = '28aca56f649fa088cbdda778a5121f2227995ed057e77de462112b2e5890d591'

const here = fileURLToPath(new URL('.', import.meta.url))
const vendor = `${here}vendor`
const patches = (existsSync(`${here}patches`) ? readdirSync(`${here}patches`) : [])
  .filter((name) => name.endsWith('.patch'))
  .sort()
  .map((name) => `${here}patches/${name}`)
const sha256 = (...parts) => parts.reduce((hash, part) => hash.update(part), createHash('sha256')).digest('hex')
const state = sha256(SHA256, ...patches.map((patch) => readFileSync(patch)))
const stamp = `${vendor}/sctp-proto/.patched`
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === state) process.exit(0)

mkdirSync(vendor, { recursive: true })
const archive = `${vendor}/${CRATE}.crate`
if (!existsSync(archive)) {
  const response = await fetch(`https://static.crates.io/crates/sctp-proto/${CRATE}.crate`)
  if (!response.ok) throw new Error(`crates.io answered ${response.status} for ${CRATE}`)
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()))
}
const found = sha256(readFileSync(archive))
if (found !== SHA256) {
  rmSync(archive)
  throw new Error(`${CRATE}.crate is not the published crate: its SHA-256 is ${found}`)
}
rmSync(`${vendor}/sctp-proto`, { recursive: true, force: true })
// -m: every file takes the time of the unpacking. With the archive's own times, from 2006, cargo
// sees nothing newer than its last build in the files a patch no longer touches, and builds nothing.
execFileSync('tar', ['-xzmf', archive, '-C', vendor])
renameSync(`${vendor}/${CRATE}`, `${vendor}/sctp-proto`)
for (const patch of patches) {
  execFileSync('patch', ['--strip=1', '--silent', '--directory', `${vendor}/sctp-proto`, '--input', patch], { stdio: 'inherit' })
}
writeFileSync(stamp, state)
console.log(`${CRATE} is in webrtc/vendor/sctp-proto, patches applied: ${patches.length}`)
