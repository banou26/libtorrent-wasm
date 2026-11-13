// What the crate is built from and what the package ships, read from the manifests, the lockfile
// and the built wasm: nothing here runs the stack.
//
// str0m's own `rust-crypto` feature is the trap: it turns on dimpl's `rcgen` feature, which is
// defined as ["dep:rcgen", "aws-lc-rs"] and so brings a C library into a build that has no C
// compiler for wasm. The crate depends on str0m with no feature and carries the provider itself.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const manifest = read('webrtc/Cargo.toml')
const locked = [...read('webrtc/Cargo.lock').matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(\nsource = "[^"]+")?/g)].map(
  ([, name, version, source]) => ({ name, version, registry: Boolean(source) }),
)
const dependency = (name) => manifest.match(new RegExp(`^${name} = (.*)$`, 'm'))?.[1]

test('str0m is 0.25.0 exactly with no feature, and dimpl has rust-crypto alone', () => {
  assert.equal(dependency('str0m'), '{ version = "=0.25.0", default-features = false }')
  assert.equal(dependency('dimpl'), '{ version = "=0.9.0", default-features = false, features = ["rust-crypto"] }')
  assert.deepEqual(
    locked.filter(({ name }) => name === 'str0m' || name === 'dimpl').map(({ name, version }) => `${name} ${version}`),
    ['dimpl 0.9.0', 'str0m 0.25.0'],
  )
})

test('no crate in the lockfile builds C', () => {
  assert.ok(locked.length > 50, `the lockfile scan found ${locked.length} crates, so it proves nothing`)
  const c = /^(aws-lc-.*|rcgen|ring|cc|cmake|bindgen|pkg-config|openssl.*|nasm-rs|str0m-(aws-lc-rs|rust-crypto|openssl|wincrypto|apple-crypto))$/
  assert.deepEqual(
    locked.filter(({ name }) => c.test(name)).map(({ name }) => name),
    [],
  )
})

test('sctp-proto is the patched copy, and every other crate is the registry one', () => {
  assert.deepEqual(
    locked.filter(({ registry }) => !registry).map(({ name, version }) => `${name} ${version}`),
    ['sctp-proto 0.10.8', 'webrtc 0.0.0'],
  )
  assert.match(manifest, /^\[patch\.crates-io\]\nsctp-proto = \{ path = "vendor\/sctp-proto" \}$/m)
  assert.match(read('webrtc/patch-sctp-proto.mjs'), /^const CRATE = 'sctp-proto-0\.10\.8'$/m)
})

test('sctp-proto is unpacked with the time of the unpacking, so cargo builds it again', (t) => {
  // cargo builds a crate again when a file of it is newer than its last build. The archive's own
  // times are from 2006: kept, taking the last patch out left the patched wasm in place, exit 0.
  const [, crate] = read('webrtc/patch-sctp-proto.mjs').match(/^const CRATE = '([^']+)'$/m)
  const archive = new URL(`../../webrtc/vendor/${crate}.crate`, import.meta.url)
  assert.ok(existsSync(archive), `webrtc/vendor has no ${crate}.crate: npm run webrtc-wasm leaves it there`)
  // the script works beside itself: a copy of it, with the archive and no patch
  const directory = mkdtempSync(join(tmpdir(), 'sctp-proto-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'vendor'))
  cpSync(archive, join(directory, 'vendor', `${crate}.crate`))
  cpSync(new URL('../../webrtc/patch-sctp-proto.mjs', import.meta.url), join(directory, 'patch-sctp-proto.mjs'))
  const started = Date.now()
  execFileSync(process.execPath, [join(directory, 'patch-sctp-proto.mjs')], { stdio: 'ignore' })

  const source = join(directory, 'vendor', 'sctp-proto', 'src')
  const files = readdirSync(source, { recursive: true }).filter((name) => name.endsWith('.rs'))
  assert.ok(files.length > 20, `the unpacked crate has ${files.length} source files, so this proves nothing`)
  // 2 s for file systems that keep whole seconds
  assert.deepEqual(
    files.filter((name) => statSync(join(source, name)).mtimeMs < started - 2000),
    [],
  )
})

test('the toolchain file names a release and the wasm target', () => {
  const toolchain = read('webrtc/rust-toolchain.toml')
  assert.match(toolchain, /^channel = "\d+\.\d+\.\d+"$/m)
  assert.match(toolchain, /^targets = \["wasm32-wasip1"\]$/m)
})

test('the wasm asks its host for the six WASI calls and nothing else', () => {
  const module = new WebAssembly.Module(readFileSync(new URL('../../build/webrtc.wasm', import.meta.url)))
  assert.deepEqual(
    WebAssembly.Module.imports(module)
      .map(({ module, name, kind }) => `${module}.${name} ${kind}`)
      .sort(),
    ['clock_time_get', 'environ_get', 'environ_sizes_get', 'fd_write', 'proc_exit', 'random_get'].map(
      (name) => `wasi_snapshot_preview1.${name} function`,
    ),
  )
})

test('the wasm names no directory of the machine that built it', () => {
  // A panic message carries the path of its source file. The standard library's start with
  // /rustc/ and, for its hashbrown, /cargo/registry/, as they were on the machine that built
  // Rust. The build remaps every other one to start with cargo/ or webrtc/.
  const paths = readFileSync(new URL('../../build/webrtc.wasm', import.meta.url), 'latin1').match(/(?<![\w.-])\/[\w.+/-]+\.rs/g) ?? []
  assert.ok(paths.length > 10, `the scan found ${paths.length} source paths, so it proves nothing`)
  assert.deepEqual(
    paths.filter((path) => !/^\/(rustc|cargo\/registry)\//.test(path)),
    [],
  )
})

test("the platform's own RTCPeerConnection and a socket typed as node's fit the entry's types", () => {
  // rig/types/either.ts is code that takes either constructor and hands the factory such a socket,
  // against the declarations as built
  const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
  const { status, stdout, stderr } = spawnSync(path('../../node_modules/.bin/tsc'), ['-p', path('./rig/types')], { encoding: 'utf8' })
  assert.equal(status, 0, stdout + stderr)
})

test('the package ships the entry, its types and its wasm, and the entry imports nothing', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.deepEqual(pkg.exports['./webrtc'], { types: './build/webrtc/index.d.ts', import: './build/webrtc.js' })
  assert.deepEqual(pkg.exports['./webrtc.wasm'], { default: './build/webrtc.wasm' })
  assert.ok(pkg.files.includes('build'))
  for (const path of ['build/webrtc.js', 'build/webrtc/index.d.ts', 'build/webrtc.wasm']) assert.ok(existsSync(new URL(`../../${path}`, import.meta.url)), path)
  // no @fkn/lib, no node module: the socket is handed in
  assert.deepEqual(read('build/webrtc.js').match(/^\s*import\s.*$|\bimport\s*\(/gm), null)
})
