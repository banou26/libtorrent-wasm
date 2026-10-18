// Session.forgetPieces (patch 0010) against the real engine, with a scripted peer dialling in so
// every message the engine sends about a forgotten piece is seen. No swarm and no transmission:
// tests/forget-pieces-swarm.test.mjs is the same call against real seeders.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PRIORITY, TORRENT_STATE } from '../build/index.js'
import { Rig } from './rig/harness.mjs'
import { makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'

const KiB = 1024
const BLOCK = 16 * KiB
const PIECE = 256 * KiB
const PIECES = 16

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fixture, its torrent, and an engine holding it, with `onDisk` pieces already in place. */
const setup = async (t, { onDisk = [] } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-forget-'))
  const fixture = path.join(root, 'fixture.bin')
  writeFixture(fixture, PIECES * PIECE)
  const meta = makeTorrent({ file: fixture, pieceLength: PIECE })
  const bytes = fs.readFileSync(fixture)
  const storageDir = path.join(root, 'download')
  if (onDisk.length) {
    const laid = Buffer.alloc(bytes.length)
    for (const p of onDisk) bytes.copy(laid, p * PIECE, p * PIECE, (p + 1) * PIECE)
    fs.mkdirSync(path.join(storageDir, 'dl'), { recursive: true })
    fs.writeFileSync(path.join(storageDir, 'dl', meta.name), laid)
  }

  const rig = new Rig({ storageDir, enableDht: false })
  const peers = []
  t.after(async () => {
    for (const p of peers) p.close()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await rig.start()
  const handle = rig.session.addTorrentFile(meta.torrent, '/dl')
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])
  await waitFor('the check to finish', () => {
    const st = rig.session.status(handle)
    return st && st.state !== TORRENT_STATE.checkingFiles && st.state !== TORRENT_STATE.checkingResumeData
      && st.numPiecesHave === onDisk.length
  })
  const have = (p) => {
    const bf = rig.session.bitfield(handle)
    return !!bf && (bf.pieces[p >> 3] & (0x80 >> (p & 7))) !== 0
  }
  const dial = async (opts = {}) => {
    const peer = new ScriptedPeer({ infoHash: meta.infoHash, port: rig.session.reachable().port, ...opts })
    peers.push(peer)
    await waitFor('the listener', () => rig.metrics.listening.tcp)
    await peer.connect()
    return peer
  }
  return { rig, session: rig.session, handle, meta, bytes, have, dial }
}

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
