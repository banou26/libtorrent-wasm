// A command sent with the add that returned the handle, before any tick or alert pass.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { TORRENT_FLAG, TORRENT_STATE } from '../build/index.js'
import { bdecode, magnetFor } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { MiB, fixture, startEngine, teardown } from './rig/stream-engine.mjs'

const HASH_A = '1'.repeat(40)
const HASH_B = '2'.repeat(40)
const NEVER_GIVEN = 77
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CHECKING = new Set([TORRENT_STATE.checkingFiles, TORRENT_STATE.checkingResumeData])

/** An engine with the fixture's file in its download directory, and its status asked for twice a second. */
const engineHolding = async (defer, fx) => {
  const dir = path.join(fx.root, 'engine')
  const onDisk = path.join(dir, 'dl', fx.meta.name)
  fs.mkdirSync(path.dirname(onDisk), { recursive: true })
  fs.writeFileSync(onDisk, fx.bytes)
  const engine = await startEngine(defer, dir)
  const asked = new Set()
  const timer = setInterval(() => { for (const h of asked) engine.session.postStatus(h) }, 200)
  defer(() => clearInterval(timer))
  const watch = (handle) => { asked.add(handle); return handle }
  return { ...engine, onDisk, watch }
}

/** The torrent's resume data once it holds every piece, then the torrent removed. */
const fullBlob = async (session, running, fx) => {
  const held = await running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  await waitFor('every piece', () => session.status(held)?.numPiecesHave === fx.meta.pieces)
  const blob = await session.saveResumeData(held)
  session.removeTorrent(held)
  await sleep(500)
  return blob
}

const settled = (session, handle) => {
  const st = session.status(handle)
  return st && !CHECKING.has(st.state) ? st : null
}

test('a pause sent with the add lands, and the queue does not start the torrent again', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, watch } = await engineHolding(defer, fx)

  const h = watch(session.addTorrentFile(fx.meta.torrent, '/dl'))
  session.pauseTorrent(h)
  await waitFor('a status', () => session.status(h))
  await sleep(1500)
  const st = session.status(h)
  assert.equal(st.paused, true)
  assert.equal(st.autoManaged, false)
})

test('a resume sent with the add of a torrent saved paused starts it', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running, watch } = await engineHolding(defer, fx)

  const held = await running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  session.pauseTorrent(held)
  await waitFor('the pause', () => session.status(held)?.paused && !session.status(held).autoManaged)
  const paused = await session.saveResumeData(held)
  session.removeTorrent(held)
  await sleep(500)

  const h = watch(session.addTorrentWithResume(paused, '/dl'))
  session.resumeTorrent(h)
  await waitFor('the torrent to run', () => session.status(h) && !session.status(h).paused, 5000)
  assert.equal(session.status(h).autoManaged, true)
})

test('flags and sequential order sent with the add are set', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, watch } = await engineHolding(defer, fx)

  const flags = TORRENT_FLAG.uploadMode | TORRENT_FLAG.disableDht
  const h = watch(session.addTorrentFile(fx.meta.torrent, '/dl'))
  session.setFlags(h, flags, flags)
  session.setSequential(h, true)
  await waitFor('a status', () => session.status(h))
  await sleep(500)
  assert.equal(session.status(h).flags & flags, flags)
  assert.equal(session.status(h).sequential, true)
})

test('limits sent with the add are in force, as the resume data says', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running } = await engineHolding(defer, fx)

  const h = session.addTorrentFile(fx.meta.torrent, '/dl')
  session.setDownloadLimit(h, 12_345)
  session.setUploadLimit(h, 23_456)
  await running(h)
  const resume = bdecode(Buffer.from(await session.saveResumeData(h)))
  assert.equal(resume.download_rate_limit, 12_345)
  assert.equal(resume.upload_rate_limit, 23_456)
})

test('file priorities sent with the add are in force, both the whole list and one file', async (t) => {
  const defer = teardown(t)
  const a = fixture(defer, MiB, 256 * 1024, 1)
  const b = fixture(defer, MiB, 256 * 1024, 2)
  const { session, watch } = await engineHolding(defer, a)

  const all = watch(session.addTorrentFile(a.meta.torrent, '/a'))
  session.setFilePriorities(all, new Uint8Array([0]))
  const one = watch(session.addTorrentFile(b.meta.torrent, '/b'))
  const taken = session.setFilePriority(one, 0, 0)
  await waitFor('both statuses', () => settled(session, all) && settled(session, one))
  await sleep(500)
  assert.deepEqual([session.status(all).totalWanted, session.status(one).totalWanted, taken], [0, 0, true])
})

test('a recheck sent with the add of a torrent restored without a check checks it', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running, onDisk, watch } = await engineHolding(defer, fx)

  const blob = await fullBlob(session, running, fx)
  // other bytes behind a blob that claims every piece, which the restore trusts unchecked
  fs.writeFileSync(onDisk, Buffer.alloc(fx.bytes.length, 7))
  const h = watch(session.addTorrentWithResume(blob, '/dl'))
  session.forceRecheck(h)
  await waitFor('the check to end', () => settled(session, h) && session.status(h).numPiecesHave === 0, 10_000)
})

test('a move in the queue sent with the adds lands, and a reannounce is taken', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, watch } = await engineHolding(defer, fx)

  const first = watch(session.addMagnet(magnetFor(HASH_A, 'a'), '/dl'))
  const second = watch(session.addMagnet(magnetFor(HASH_B, 'b'), '/dl'))
  session.moveInQueue(second, 'top')
  // its effect is not to be told from the announce a starting torrent makes anyway
  const reannounced = session.mod._lt_torrent_force_reannounce(first)
  await waitFor('both statuses', () => session.status(first) && session.status(second))
  await sleep(500)
  assert.deepEqual([session.status(second).queuePosition, session.status(first).queuePosition, reannounced], [0, 1, 0])
})

test('a status, a tracker list and a peer list asked for with the add are answered', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session } = await engineHolding(defer, fx)

  const tracker = 'udp://tracker.example.invalid:6969/announce'
  const h = session.addMagnet(`${magnetFor(HASH_A, 'a')}&tr=${encodeURIComponent(tracker)}`, '/dl')
  session.postStatus(h)
  const trackers = session.trackers(h, 3000)
  const asked = Date.now()
  const peers = session.peers(h, 3000).then(() => Date.now() - asked)
  session.tick()
  session.popAlerts()
  const status = session.status(h) !== null
  assert.deepEqual(
    { status, trackers: (await trackers).map((entry) => entry.url), peersBeforeTimeout: await peers < 2000 },
    { status: true, trackers: [tracker], peersBeforeTimeout: true },
  )
})

test('a save sent with the add is answered', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session } = await engineHolding(defer, fx)

  const h = session.addTorrentFile(fx.meta.torrent, '/dl')
  const resume = bdecode(Buffer.from(await session.saveResumeData(h, 3000)))
  assert.equal(Buffer.from(resume['info-hash']).toString('hex'), fx.meta.infoHash)
})

test('every command takes a handle from its add, and answers -1, as a remove does, for one never given out', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session } = await engineHolding(defer, fx)
  const m = session.mod
  const prios = m._malloc(1)
  defer(() => m._free(prios))
  m.HEAPU8[prios] = 4

  const commands = {
    pause: (h) => m._lt_torrent_pause(h),
    resume: (h) => m._lt_torrent_resume(h),
    recheck: (h) => m._lt_torrent_force_recheck(h),
    save: (h) => m._lt_torrent_save_resume_data(h),
    status: (h) => m._lt_torrent_post_status(h),
    peers: (h) => m._lt_torrent_post_peers(h),
    trackers: (h) => m._lt_torrent_post_trackers(h),
    sequential: (h) => m._lt_torrent_set_sequential(h, 1),
    flags: (h) => m._lt_torrent_set_flags(h, 0, TORRENT_FLAG.disablePex),
    reannounce: (h) => m._lt_torrent_force_reannounce(h),
    queue: (h) => m._lt_torrent_queue_position(h, 3),
    upload: (h) => m._lt_torrent_set_upload_limit(h, 0),
    download: (h) => m._lt_torrent_set_download_limit(h, 0),
    files: (h) => m._lt_torrent_prioritize_files(h, prios, 1),
    file: (h) => m._lt_torrent_set_file_priority(h, 0, 4),
  }
  const h = session.addTorrentFile(fx.meta.torrent, '/dl')
  const answers = (handle) => Object.fromEntries(Object.entries(commands).map(([name, run]) => [name, run(handle)]))
  assert.deepEqual(answers(h), Object.fromEntries(Object.keys(commands).map((name) => [name, 0])))
  assert.deepEqual(answers(NEVER_GIVEN), Object.fromEntries(Object.keys(commands).map((name) => [name, -1])))
  assert.equal(m._lt_session_remove_torrent_ex(NEVER_GIVEN, 0), -1)
})
