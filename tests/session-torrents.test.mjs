// What a session says of the torrents it holds without being asked through an alert: which ones,
// and for each whether it is private, whether it is being read, and which WebSocket trackers it names.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { bdecode, bencode, magnetFor, makeTorrent } from './rig/make-torrent.mjs'
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

test('hasStreamWindow() is true from a window planned with deadlines until it is cleared, replaced or the torrent goes', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running } = await startEngine(defer, path.join(fx.root, 'engine'))
  const handle = await running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  await waitFor('the file layout', () => session.files(handle))
  const window = () => session.setStreamWindow(handle, [{ fileIndex: 0, offset: 0 }])
  assert.equal(session.hasStreamWindow(handle), false)

  assert.equal(session.setStreamWindow(handle, [{ fileIndex: 9, offset: 0 }]), false, 'a file the torrent does not have was planned')
  assert.equal(session.hasStreamWindow(handle), false)
  assert.equal(window(), true)
  assert.equal(session.hasStreamWindow(handle), true)

  session.clearStreamWindow(handle)
  assert.equal(session.hasStreamWindow(handle), false)

  window()
  session.prioritizeRange(handle, 0, 0, 1000)
  assert.equal(session.hasStreamWindow(handle), false, 'a range that replaced the window left it standing')

  // a save: the priorities and the order of a window, and nobody waiting on a clock
  const save = () => session.setStreamWindow(handle, [{ fileIndex: 0, offset: 0 }], { deadlines: false })
  assert.equal(save(), true)
  assert.equal(session.hasStreamWindow(handle), false, 'a save reads as somebody reading')
  window()
  save()
  assert.equal(session.hasStreamWindow(handle), false, 'a save that replaced the window left it standing')

  window()
  session.removeTorrent(handle)
  assert.equal(session.hasStreamWindow(handle), false)
  assert.equal(session.addTorrentFile(fx.meta.torrent, '/dl'), handle)
  assert.equal(session.hasStreamWindow(handle), false, 'a torrent added again kept the window of the one removed')
})

test('webSocketTrackers() names the ws and wss trackers of a magnet, a .torrent and resume data, each once and no other', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running } = await startEngine(defer, path.join(fx.root, 'engine'))
  assert.deepEqual(session.webSocketTrackers(1), [])

  const tr = (name, url) => `&${name}=${encodeURIComponent(url)}`
  const magnet = session.addMagnet(magnetFor(OTHER_HASH, 'other')
    + tr('tr', 'udp://tracker.test:6969/announce')
    + tr('tr', 'wss://tracker.test/announce')
    + tr('tr.1', 'ws://tracker.test:8000')
    + tr('tr', 'wss://tracker.test/announce')
    + tr('tr', 'WSS://UPPER.test')
    + tr('tr', 'wss://two words.test')
    + tr('tr', 'wss://a.test\nwss://b.test')
    + tr('ws', 'https://webseed.test/file')
    + '&tr=wss%3A%2F%2Fbad%ZZescape.test', '/dl')
  // from the add itself: nothing was pumped in between
  assert.deepEqual(session.webSocketTrackers(magnet), ['wss://tracker.test/announce', 'ws://tracker.test:8000', 'WSS://UPPER.test'])

  const torrent = bencode({
    ...bdecode(fx.meta.torrent),
    announce: 'wss://first.test',
    'announce-list': [['http://tracker.test/announce', 'wss://second.test'], 'wss://not-a-tier.test', ['wss://first.test', ' wss://third.test', 7]],
  })
  const file = session.addTorrentFile(torrent, '/dl')
  const named = ['wss://first.test', 'wss://second.test', 'wss://third.test']
  assert.deepEqual(session.webSocketTrackers(file), named)

  // libtorrent itself holds none of them, which is why they are kept beside it
  await running(file)
  assert.deepEqual((await session.trackers(file)).map((tracker) => tracker.url), ['http://tracker.test/announce'])

  // the same torrent named again, with one tracker more
  assert.equal(session.addMagnet(magnetFor(fx.meta.infoHash, fx.meta.name) + tr('tr', 'wss://fourth.test') + tr('tr', 'wss://second.test'), '/dl'), file)
  assert.deepEqual(session.webSocketTrackers(file), [...named, 'wss://fourth.test'])

  const resume = Buffer.from(await session.saveResumeData(file))
  assert.deepEqual(bdecode(resume)['ws-trackers'].map(String), [...named, 'wss://fourth.test'])
  session.removeTorrent(file)
  assert.deepEqual(session.webSocketTrackers(file), [])

  // the source is gone by now: a session that never saw the .torrent reads them from the resume data
  const second = await startEngine(defer, path.join(fx.root, 'second'))
  const again = second.session.addTorrentWithResume(resume, '/dl')
  assert.deepEqual(second.session.webSocketTrackers(again), [...named, 'wss://fourth.test'])
  await second.running(again)
  assert.deepEqual((await second.session.trackers(again)).map((tracker) => tracker.url), ['http://tracker.test/announce'])
  const rewritten = bdecode(Buffer.from(await second.session.saveResumeData(again)))
  assert.deepEqual(rewritten['ws-trackers'].map(String), [...named, 'wss://fourth.test'])
})
