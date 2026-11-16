// The engine throws with the wasm exception instructions (-fwasm-exceptions in CMakeLists.txt). With
// JS exceptions every call that can throw went out through a JS invoke_* wrapper and back: 1.3
// million calls per 134 MB downloaded, each running the ASSERTIONS table check.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const bytes = readFileSync(new URL('../build/libtorrent.wasm', import.meta.url))

// the id of every section, in order (the binary format: an 8 byte header, then id, LEB128 size, body)
const sectionIds = () => {
  const ids = []
  let at = 8
  const leb = () => {
    let n = 0
    for (let shift = 0; ; shift += 7) {
      const b = bytes[at++]
      n += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) return n
    }
  }
  while (at < bytes.length) {
    ids.push(bytes[at++])
    const size = leb()
    at += size
  }
  return ids
}

test('the wasm imports no invoke_ wrapper and declares its exception tags', () => {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes))
  assert.ok(imports.length > 10, `${imports.length} imports, so the check proves nothing`)
  assert.deepEqual(imports.filter(({ name }) => name.startsWith('invoke_')).map(({ name }) => name), [])
  const ids = sectionIds()
  // a module holds each section at most once, custom ones (0) aside
  assert.deepEqual(ids.filter((id) => id !== 0), [...new Set(ids.filter((id) => id !== 0))], `section ids ${ids}: the walk went wrong`)
  assert.ok(ids.includes(10), `no code section in ${ids}, so the walk went wrong`)
  // 13 is the tag section: a build with exceptions turned off has no invoke_ wrapper either
  assert.ok(ids.includes(13), `no tag section in ${ids}`)
})
