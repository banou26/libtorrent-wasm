// Session.forgetPieces (patch 0010) against the real engine, with a scripted peer dialling in so
// every message the engine sends about a forgotten piece is seen. No swarm and no transmission:
// tests/forget-pieces-swarm.test.mjs is the same call against real seeders.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PRIORITY, TORRENT_STATE } from '../build/index.js'
import { FIXTURES, MANIFEST, contentFor, layOut } from './fixtures/v2.mjs'
import { Rig } from './rig/harness.mjs'
import { makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'

const KiB = 1024
const BLOCK = 16 * KiB
const PIECE = 256 * KiB
const PIECES = 16

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** An engine holding `torrent`, saved under `root`, once its check has found `held` pieces. */
const engine = async (t, root, torrent, held) => {
  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false })
  const peers = []
  t.after(async () => {
    for (const p of peers) p.close()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await rig.start()
  const session = rig.session
  const handle = session.addTorrentFile(torrent, '/dl')
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])
  await waitFor('the check to finish', () => {
    const st = session.status(handle)
    return st && st.state !== TORRENT_STATE.checkingFiles && st.state !== TORRENT_STATE.checkingResumeData
      && st.numPiecesHave === held
  })
  const have = (p) => {
    const bf = session.bitfield(handle)
    return !!bf && (bf.pieces[p >> 3] & (0x80 >> (p & 7))) !== 0
  }
  const dial = async (opts = {}) => {
    const peer = new ScriptedPeer({ infoHash: session.infohash(handle), port: session.reachable().port, ...opts })
    peers.push(peer)
    await waitFor('the listener', () => rig.metrics.listening.tcp)
    await peer.connect()
    return peer
  }
  return { rig, session, handle, have, dial }
}

/** A fixture, its torrent, and an engine holding it, with `onDisk` pieces already in place. */
const setup = async (t, { onDisk = [] } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-forget-'))
  const fixture = path.join(root, 'fixture.bin')
  writeFixture(fixture, PIECES * PIECE)
  const meta = makeTorrent({ file: fixture, pieceLength: PIECE })
  const bytes = fs.readFileSync(fixture)
  if (onDisk.length) {
    const laid = Buffer.alloc(bytes.length)
    for (const p of onDisk) bytes.copy(laid, p * PIECE, p * PIECE, (p + 1) * PIECE)
    fs.mkdirSync(path.join(root, 'download', 'dl'), { recursive: true })
    fs.writeFileSync(path.join(root, 'download', 'dl', meta.name), laid)
  }
  return { ...(await engine(t, root, meta.torrent, onDisk.length)), bytes }
}

const onlyPieceZero = (session, handle) => session.prioritizePieces(handle,
  Uint8Array.from({ length: PIECES }, (_, p) => (p === 0 ? PRIORITY.normal : PRIORITY.skip)))

test('a forgotten piece is withdrawn from a leech: its queued requests are rejected and lt_donthave sent', async (t) => {
  const { rig, session, handle, have, dial } = await setup(t, { onDisk: Array.from({ length: PIECES - 1 }, (_, i) => i) })
  const leech = await dial()
  await waitFor('the engine to unchoke the leech', () => leech.unchoked)

  // The engine reads ahead up to send_buffer_low_watermark (512 KiB, wrapper.cpp) per peer. Holding
  // those reads keeps every later request queued, where a forget has to reject it.
  const read = rig.storage.read.bind(rig.storage)
  let release
  const held = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  rig.storage.read = (id, file, offset, length) => (offset >= 5 * PIECE && offset < 7 * PIECE
    ? held.then(() => read(id, file, offset, length))
    : read(id, file, offset, length))
  const blocksOf = (piece) => Array.from({ length: PIECE / BLOCK }, (_, b) => b * BLOCK)
  for (const piece of [5, 6]) for (const offset of blocksOf(piece)) leech.request(piece, offset, BLOCK)
  // consecutive matches, then one that must survive: a loop that steps over the element after
  // each erase rejects half of these
  for (const offset of blocksOf(3)) leech.request(3, offset, BLOCK)
  for (const offset of blocksOf(7).slice(0, 4)) leech.request(7, offset, BLOCK)
  await sleep(1500)

  assert.deepEqual(session.forgetPieces(handle, [3]), { forgotten: 1, busy: 0 })
  assert.equal(have(3), false, 'the bitfield still shows the forgotten piece')
  await waitFor('lt_donthave for piece 3', () => leech.dontHave.includes(3), 10_000)
  await sleep(1000)
  const rejected = leech.rejects.filter((r) => r.piece === 3).map((r) => r.offset).sort((a, b) => a - b)
  assert.deepEqual(rejected, blocksOf(3), 'every queued request for the forgotten piece is rejected, once')
  assert.deepEqual(leech.rejects.filter((r) => r.piece !== 3), [], 'a request for a held piece was rejected')
  assert.deepEqual(leech.dontHave, [3])
  // the engine itself no longer has it, so a new request for it is refused too
  leech.request(3, 0, BLOCK)
  await waitFor('the new request to be rejected', () => leech.rejects.length === rejected.length + 1, 10_000)
  assert.deepEqual(leech.rejects.at(-1), { piece: 3, offset: 0, length: BLOCK })
  assert.equal(session.status(handle).errorCode, 0)
  release()
  await sleep(500)
})

test('a partial piece with nothing in flight loses its blocks, so it downloads again whole', async (t) => {
  const { rig, session, handle, bytes, have, dial } = await setup(t)
  const wanted = [0, 1, 2, 3]
  session.prioritizePieces(handle, Uint8Array.from({ length: PIECES }, (_, p) => (p < 4 ? PRIORITY.normal : PRIORITY.skip)))
  const blocks = wanted.length * (PIECE / BLOCK)
  const slice = (piece, offset, length) => bytes.subarray(piece * PIECE + offset, piece * PIECE + offset + length)
  const distinct = (peer) => new Set(peer.requests.map((r) => `${r.piece}:${r.offset}`)).size

  // the last block of each piece is asked for and never sent, then the peer leaves
  const partial = await dial({ serve: (piece, offset, length) => (offset + length < PIECE ? slice(piece, offset, length) : null) })
  await waitFor('every block to be asked for', () => distinct(partial) === blocks)
  await sleep(500)
  assert.equal(wanted.filter(have).length, 0, 'a piece completed without its last block')
  partial.close()

  let result
  await waitFor('the withheld requests to be dropped', () => {
    result = session.forgetPieces(handle, wanted)
    return result?.busy === 0
  })
  assert.deepEqual(result, { forgotten: 0, busy: 0 })
  assert.deepEqual(session.forgetPieces(handle, [8, 9]), { forgotten: 0, busy: 0 }, 'pieces never started')
  // what a storage that dropped the bytes leaves behind
  const file = rig.storage.filePath(session.files(handle).storageIndex, 0)
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, Buffer.alloc(wanted.length * PIECE), 0, wanted.length * PIECE, 0)
  fs.closeSync(fd)

  const whole = await dial({ serve: slice })
  await waitFor('the pieces to download again', () => wanted.every(have), 20_000)
  assert.equal(whole.requests.length, blocks, 'the engine kept blocks it had been told to drop')
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  const got = await session.read(handle, 0, 0, wanted.length * PIECE)
  assert.ok(Buffer.from(got).equals(bytes.subarray(0, wanted.length * PIECE)), 'the bytes differ from the fixture')
})

test('a skipped forgotten piece is never asked for while the rest finishes, and comes back intact once wanted', async (t) => {
  const { rig, session, handle, bytes, have, dial } = await setup(t, { onDisk: Array.from({ length: PIECES - 1 }, (_, i) => i) })
  const prios = new Uint8Array(PIECES).fill(PRIORITY.normal).fill(PRIORITY.skip, 0, 4)
  session.prioritizePieces(handle, prios)
  assert.deepEqual(session.forgetPieces(handle, [0, 1, 2, 3]), { forgotten: 4, busy: 0 })
  // the control: forgotten as well, but wanted
  assert.deepEqual(session.forgetPieces(handle, [4, 5]), { forgotten: 2, busy: 0 })
  const fd = fs.openSync(rig.storage.filePath(session.files(handle).storageIndex, 0), 'r+')
  fs.writeSync(fd, Buffer.alloc(6 * PIECE), 0, 6 * PIECE, 0)
  fs.closeSync(fd)
  const asked = (requests) => [...new Set(requests.map((r) => r.piece))].sort((a, b) => a - b)
  const healthy = () => {
    const st = session.status(handle)
    assert.equal(st.paused, false, 'the torrent paused')
    assert.equal(st.errorCode, 0, st.error)
  }

  const serve = (piece, offset, length) => bytes.subarray(piece * PIECE + offset, piece * PIECE + offset + length)
  const first = await dial({ serve })
  await waitFor('every wanted piece', () => [4, 5, PIECES - 1].every(have), 20_000)
  assert.deepEqual(asked(first.requests), [4, 5, PIECES - 1], 'the engine asked for a skipped piece')
  assert.equal([0, 1, 2, 3].filter(have).length, 0)
  await waitFor('the torrent to finish', () => session.status(handle)?.state === TORRENT_STATE.finished)
  healthy()

  const before = first.requests.length
  prios.fill(PRIORITY.normal, 0, 4)
  session.prioritizePieces(handle, prios)
  // a finished torrent closes its connections to seeds, so another one dials in
  const second = await dial({ serve })
  await waitFor('the skipped pieces once wanted', () => session.status(handle)?.state === TORRENT_STATE.seeding, 20_000)
  assert.deepEqual(asked([...first.requests.slice(before), ...second.requests]), [0, 1, 2, 3])
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  healthy()
  const got = await session.read(handle, 0, 0, PIECES * PIECE)
  assert.ok(Buffer.from(got).equals(bytes), 'the bytes differ from the fixture')
})

test('a seed refuses, and its bitfield is left alone', async (t) => {
  const { session, handle, have } = await setup(t, { onDisk: Array.from({ length: PIECES }, (_, i) => i) })
  assert.equal(session.forgetPieces(handle, [0, 1]), null)
  assert.equal(have(0), true)
})

test('a torrent that is checking refuses, and keeps the piece once the check is done', async (t) => {
  const { session, handle } = await setup(t, { onDisk: Array.from({ length: PIECES - 1 }, (_, i) => i) })
  session.forceRecheck(handle)
  // the recheck runs on the next tick, and the check it starts finishes on later ones
  session.tick()
  assert.equal(session.forgetPieces(handle, [3]), null)
  await waitFor('the recheck to finish', () => session.forgetPieces(handle, []) !== null)
  assert.deepEqual(session.forgetPieces(handle, [3]), { forgotten: 1, busy: 0 })
})

test('a piece with a block still requested is busy and kept, so it completes from the blocks it had', async (t) => {
  const { rig, session, handle, bytes, have, dial } = await setup(t)
  onlyPieceZero(session, handle)
  const last = PIECE - BLOCK
  const seed = await dial({ serve: (_, offset, length) => (offset === last ? null : bytes.subarray(offset, offset + length)) })
  await waitFor('every block to be asked for', () => seed.requests.length === PIECE / BLOCK)
  await sleep(500)
  assert.equal(have(0), false, 'the piece completed without its last block')

  assert.deepEqual(session.forgetPieces(handle, [0]), { forgotten: 0, busy: 1 })
  seed.send(0, last, bytes.subarray(last, PIECE))
  await waitFor('the piece to complete', () => have(0), 10_000)
  assert.equal(seed.requests.length, PIECE / BLOCK, 'blocks the engine had were asked for again')
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  assert.ok(Buffer.from(await session.read(handle, 0, 0, PIECE)).equals(bytes.subarray(0, PIECE)), 'the bytes differ from the fixture')
})

test('a piece being hashed is busy and kept, so it completes without downloading again', async (t) => {
  const { rig, session, handle, bytes, have, dial } = await setup(t)
  // the hash reads the piece back from the storage, so holding reads keeps it hashing
  const read = rig.storage.read.bind(rig.storage)
  let release
  const held = new Promise((resolve) => { release = resolve })
  t.after(() => release())
  rig.storage.read = (...args) => held.then(() => read(...args))
  onlyPieceZero(session, handle)
  const seed = await dial({ serve: (_, offset, length) => bytes.subarray(offset, offset + length) })
  await waitFor('every block to be asked for', () => seed.requests.length === PIECE / BLOCK)
  await sleep(500)
  assert.equal(have(0), false, 'the piece passed while its hash read was held')

  assert.deepEqual(session.forgetPieces(handle, [0]), { forgotten: 0, busy: 1 })
  await sleep(1000)
  release()
  await waitFor('the piece to complete', () => have(0), 10_000)
  assert.equal(seed.requests.length, PIECE / BLOCK, 'the engine downloaded the piece again')
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  assert.ok(Buffer.from(await session.read(handle, 0, 0, PIECE)).equals(bytes.subarray(0, PIECE)), 'the bytes differ from the fixture')
})

test('a hybrid torrent forgets a piece and takes it back against its merkle tree', async (t) => {
  const { pieceLength, kinds: { hybrid } } = MANIFEST.find((m) => m.case === 'pow2-pieces')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-forget-v2-'))
  // the last file stays off disk, so the check leaves a torrent that still has a picker
  const onDisk = hybrid.files.slice(0, -1)
  layOut(path.join(root, 'download', 'dl'), { files: onDisk })
  const held = onDisk.reduce((n, f) => n + Math.ceil(f.size / pieceLength), 0)
  const torrent = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'pow2-pieces.hybrid.torrent')))
  const { rig, session, handle, have, dial } = await engine(t, root, torrent, held)

  const geometry = session.files(handle)
  // the v1 piece space, pads included, which is what a v1 peer is asked for
  const space = Buffer.alloc(geometry.totalSize)
  for (const f of hybrid.files) {
    contentFor(f.seed, f.size).copy(space, geometry.files.find((g) => g.path === f.path.join('/')).offset)
  }
  const many = geometry.files.findIndex((g) => g.path.endsWith('d-many-pieces.bin'))
  const { offset, size } = geometry.files[many]
  // a piece wholly inside a file of several, so its merkle leaf sits among others
  const piece = offset / pieceLength + 1
  assert.deepEqual(session.forgetPieces(handle, [piece]), { forgotten: 1, busy: 0 })
  assert.equal(have(piece), false, 'the bitfield still shows the forgotten piece')
  const fd = fs.openSync(rig.storage.filePath(geometry.storageIndex, many), 'r+')
  fs.writeSync(fd, Buffer.alloc(pieceLength), 0, pieceLength, piece * pieceLength - offset)
  fs.closeSync(fd)

  const seed = await dial({ serve: (p, at, length) => space.subarray(p * pieceLength + at, p * pieceLength + at + length) })
  await waitFor('the torrent to complete', () => session.status(handle)?.state === TORRENT_STATE.seeding, 20_000)
  assert.deepEqual([...new Set(seed.requests.map((r) => r.piece))].sort((a, b) => a - b), [piece, geometry.numPieces - 1])
  assert.equal(rig.metrics.alerts.hashFailed, 0)
  assert.equal(session.status(handle).errorCode, 0)
  const got = await session.read(handle, many, 0, size)
  assert.ok(Buffer.from(got).equals(space.subarray(offset, offset + size)), 'the file differs from the fixture')
})
