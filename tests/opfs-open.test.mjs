// Chromium 156 never settles createSyncAccessHandle() when its file handle is collected before the
// browser answers, so a storage that asks on a handle nothing holds leaves that file's writes waiting.

import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

setFlagsFromString('--expose_gc')
const collect = runInNewContext('gc')

const accessHandle = (file) => ({
  read(out, { at = 0 } = {}) {
    const bytes = file.bytes.subarray(at, at + out.length)
    out.set(bytes)
    return bytes.length
  },
  write(bytes, { at = 0 } = {}) {
    if (at + bytes.length > file.bytes.length) {
      const grown = new Uint8Array(at + bytes.length)
      grown.set(file.bytes)
      file.bytes = grown
    }
    file.bytes.set(bytes, at)
    return bytes.length
  },
  flush() {},
  close() {},
  getSize: () => file.bytes.length,
})

// A fresh handle per call, as a browser gives, whose ask is answered in a later task after a collection, and only if the handle is still alive then
const makeDir = () => ({
  dirs: {},
  files: {},
  async getDirectoryHandle(name) {
    return (this.dirs[name] ??= makeDir())
  },
  async getFileHandle(name) {
    const file = (this.files[name] ??= { bytes: new Uint8Array(0) })
    return {
      createSyncAccessHandle() {
        const held = new WeakRef(this)
        return new Promise((resolve) => {
          setTimeout(() => {
            collect()
            if (held.deref()) resolve(accessHandle(file))
          }, 0)
        })
      },
    }
  },
})

const withRoot = async (root, run) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  })
  try { return await run() } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  }
}

const SILENT = Symbol('never settled')
const within = (ask, ms) => {
  let timer
  return Promise.race([ask, new Promise((resolve) => { timer = setTimeout(() => resolve(SILENT), ms) })])
    .finally(() => clearTimeout(timer))
}

const { OPFSStorage } = await import('../build/opfs.js')

const files = Array.from({ length: 5 }, (_, i) => ({ path: `pack/file-${i}.bin`, size: 64 }))
const bytesOf = (i) => Uint8Array.from({ length: 64 }, (_, b) => (i * 64 + b) % 256)

// Drives the built bytes, whose build folds a named const into the same temporary, so the two-line source form fails here too
test('first writes to several new files all land and read back', async () => {
  await withRoot(makeDir(), async () => {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files)
    const writes = await Promise.all(files.map((_, i) => within(Promise.resolve(storage.write(1, i, 0, bytesOf(i))), 1_000)))
    assert.deepEqual(writes, files.map(() => undefined))
    for (const [i] of files.entries()) assert.deepEqual(await storage.read(1, i, 0, 64), bytesOf(i))
  })
})

test('the control: the fake drops an ask on a handle nothing holds', async () => {
  const dir = makeDir()
  const asks = await Promise.all(files.map((_, i) => within((async () => (await dir.getFileHandle(`f${i}`)).createSyncAccessHandle())(), 500)))
  assert.deepEqual(asks, files.map(() => SILENT))
})
