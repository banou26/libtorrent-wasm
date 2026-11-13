// What a session says of the torrents it holds without being asked through an alert: which ones,
// and for each whether it is private, whether it is being read, and which WebSocket trackers it names.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { magnetFor, makeTorrent } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { MiB, fixture, startEngine, teardown } from './rig/stream-engine.mjs'

const OTHER_HASH = '00112233445566778899aabbccddeeff00112233'

test('torrents() lists a handle from the add that returned it until it is removed, and no source that did not parse', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running } = await startEngine(defer, path.join(fx.root, 'engine'))
  assert.deepEqual(session.torrents(), [])

  const unread = [session.addMagnet('not a magnet'), session.addTorrentFile(Buffer.from('not a torrent'), '/dl')]
  assert.ok(unread.every((handle) => handle >= 0xffffff00), 'the engine took a source that does not parse')
  assert.deepEqual(session.torrents(), [])

  // before anything was pumped: the engine itself knows nothing of it yet
  const file = session.addTorrentFile(fx.meta.torrent, '/dl')
  assert.equal(session.status(file), null)
  assert.deepEqual(session.torrents(), [file])
  assert.equal(session.addTorrentFile(fx.meta.torrent, '/dl'), file, 'the same torrent got a second handle')
  assert.deepEqual(session.torrents(), [file])

  const magnet = session.addMagnet(magnetFor(OTHER_HASH, 'other'), '/dl')
  assert.deepEqual(session.torrents(), [file, magnet])

  const resume = await session.saveResumeData(await running(file))
  session.removeTorrent(file)
  assert.deepEqual(session.torrents(), [magnet])
  assert.equal(session.addTorrentWithResume(resume, '/dl'), file)
  assert.deepEqual(session.torrents(), [magnet, file])
})

test('isPrivate() says what the metadata says, and nothing while there is none', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const file = path.join(fx.root, 'fixture.bin')
  const marked = makeTorrent({ file, pieceLength: 256 * 1024, private: true })
  const { session, running } = await startEngine(defer, path.join(fx.root, 'engine'))

  const open = session.addTorrentFile(fx.meta.torrent, '/dl')
  assert.equal(session.isPrivate(open), undefined, 'answered before the engine had heard of the torrent')
  const closed = await running(session.addTorrentFile(marked.torrent, '/dl'))
  const magnet = session.addMagnet(magnetFor(OTHER_HASH, 'other'), '/dl')
  await waitFor('the magnet to be known', () => session.infohash(magnet))

  assert.equal(session.isPrivate(await running(open)), false)
  assert.equal(session.isPrivate(closed), true)
  assert.equal(session.isPrivate(magnet), undefined, 'a magnet has no metadata to ask')
  assert.equal(session.isPrivate(77), undefined)
})
