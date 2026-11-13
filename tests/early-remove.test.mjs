// A remove asked for between an add and the alert pass that registers the torrent.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { FIXTURES } from './fixtures/v2.mjs'
import { magnetFor } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { MiB, fixture, startEngine, teardown } from './rig/stream-engine.mjs'

// libtorrent's torrent_removed_alert
const TORRENT_REMOVED = 4
const OTHER_HASH = '00112233445566778899aabbccddeeff00112233'

// The removal alert's text loses the torrent's name once the torrent is gone, so its type is what is counted.
const countRemovals = (session) => {
  let removed = 0
  const pop = session.popAlerts.bind(session)
  session.popAlerts = () => {
    const out = pop()
    removed += out.filter((alert) => alert.type === TORRENT_REMOVED).length
    return out
  }
  return () => removed
}

/** An engine with the fixture's file already in its download directory. */
const engineHolding = async (defer, fx) => {
  const dir = path.join(fx.root, 'engine')
  const onDisk = path.join(dir, 'dl', fx.meta.name)
  fs.mkdirSync(path.dirname(onDisk), { recursive: true })
  fs.writeFileSync(onDisk, fx.bytes)
  const engine = await startEngine(defer, dir)
  return { ...engine, onDisk, removed: countRemovals(engine.session) }
}

/**
 * Removes `handle` at once, then runs one tick, which applies the add and the remove, and the alert
 * pass straight after it, which hears of the add while the removed torrent object still exists.
 */
const removeBeforeThePass = (session, handle, deleteFiles = false) => {
  session.removeTorrent(handle, deleteFiles)
  session.tick()
  session.popAlerts()
  session.postStatus(handle)
}

// A torrent that pass took back in reports a status again, and once its object is freed a pause
// throws invalid torrent handle.
const staysGone = async (session, handle) => {
  session.pauseTorrent(handle)
  session.postStatus(handle)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  session.pauseTorrent(handle)
  assert.equal(session.status(handle), null)
}

test('a magnet removed before the alert pass goes', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, removed } = await engineHolding(defer, fx)

  const magnet = session.addMagnet(magnetFor(OTHER_HASH, 'other'), '/dl')
  removeBeforeThePass(session, magnet)
  await waitFor('the magnet to go', () => removed() === 1)
  await staysGone(session, magnet)
  assert.equal(removed(), 1)
})

test('a .torrent removed with its files before the alert pass goes, files and all', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, onDisk, removed } = await engineHolding(defer, fx)

  const file = session.addTorrentFile(fx.meta.torrent, '/dl')
  removeBeforeThePass(session, file, true)
  await waitFor('the torrent and its file to go', () => removed() === 1 && !fs.existsSync(onDisk))
  await staysGone(session, file)
})

// their ids are keyed by the truncated v2 hash, which is what the remove looks the torrent up by
test('a v2 and a hybrid .torrent removed before the alert pass go', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, removed } = await engineHolding(defer, fx)

  for (const kind of ['v2', 'hybrid']) {
    const handle = session.addTorrentFile(fs.readFileSync(path.join(FIXTURES, `single-file.${kind}.torrent`)), '/dl')
    removeBeforeThePass(session, handle)
  }
  await waitFor('both to go', () => removed() === 2)
})

test('a torrent added from resume data and removed with its files before the alert pass goes, files and all', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running, onDisk, removed } = await engineHolding(defer, fx)

  const held = await running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  await waitFor('every piece', () => session.status(held)?.numPiecesHave === fx.meta.pieces)
  const resume = await session.saveResumeData(held)
  session.removeTorrent(held)
  await waitFor('the registered torrent to go', () => removed() === 1)

  const resumed = session.addTorrentWithResume(resume, '/dl')
  removeBeforeThePass(session, resumed, true)
  await waitFor('the resumed torrent and its file to go', () => removed() === 2 && !fs.existsSync(onDisk))
  await staysGone(session, resumed)
})

test('an add after an early remove stands, where it was asked to: add, remove, add again before the alert pass', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, storage, running, removed } = await engineHolding(defer, fx)

  const first = session.addTorrentFile(fx.meta.torrent, '/dl')
  session.removeTorrent(first)
  const again = session.addTorrentFile(fx.meta.torrent, '/moved')
  assert.equal(again, first)

  await running(again)
  await waitFor('the layout', () => session.files(again))
  const saved = storage.filePath(session.files(again).storageIndex, 0)
  assert.equal(path.relative(path.join(fx.root, 'engine'), saved), path.join('moved', fx.meta.name))
  assert.equal(removed(), 1)
})

test('removeTorrent() says false for a handle the engine never gave out', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session } = await startEngine(defer, path.join(fx.root, 'engine'))

  assert.equal(session.removeTorrent(77), false)
  assert.equal(session.removeTorrent(session.addMagnet('not a magnet')), false)
  assert.equal(session.removeTorrent(session.addMagnet(magnetFor(OTHER_HASH, 'other'), '/dl')), true)
})
