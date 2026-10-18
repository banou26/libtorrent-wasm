// The v2 and hybrid fixture: metainfo built by native libtorrent 2.0.13, with the data regenerated
// from the manifest's seeds rather than checked in.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'v2')
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'))

/** The same sha256 chain the fixture generator used. Incompressible, so nothing agrees by accident. */
export const contentFor = (seed, size) => {
  const out = Buffer.alloc(size)
  let hash = crypto.createHash('sha256').update(seed).digest()
  for (let at = 0; at < size; at += 32) {
    hash = crypto.createHash('sha256').update(hash).digest()
    hash.copy(out, at, 0, Math.min(32, size - at))
  }
  return out
}

/**
 * Lay the fixture out where the ENGINE will look for it.
 *
 * `path` in the manifest is what libtorrent's parser reports, not what the metainfo says, and the
 * two disagree in one case: a v2-ONLY torrent whose file tree holds exactly one file is parsed as a
 * single-file torrent named after that FILE, discarding the `name` field, while its hybrid sibling
 * keeps the directory. A layout that trusted the metainfo put the data one directory too deep, the
 * engine found nothing, answered "there is nothing to verify", and reported 0 per cent with no
 * error at all, which reads exactly like a hashing failure and is not one.
 */
export const layOut = (root, entry) => {
  for (const file of entry.files) {
    const full = path.join(root, ...file.path)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contentFor(file.seed, file.size))
  }
}
