// A stream address must never get into resume data: loaded back, the stale entry made a new
// stream given that address wait 55 s for its dial.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { bdecode, bencode } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { MiB, endpoints, fixture, startEngine, startEngineWithBothKinds, teardown } from './rig/stream-engine.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const compact = (address, port) => Buffer.from([...address.split('.').map(Number), port >> 8, port & 0xff])

test('resume data keeps an ordinary peer and no stream address', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const ORDINARY = '192.0.2.9'
  const { session, handle, port } = await startEngineWithBothKinds(defer, fx, ORDINARY)
  const resume = bdecode(Buffer.from(await session.saveResumeData(handle)))
  assert.deepEqual(endpoints(resume.peers), [`${ORDINARY}:${port}`])
})

test('a stream address in resume data is dropped on load, so a stream given that address is dialled at once', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const first = await startEngine(defer, path.join(fx.root, 'first'))
  const saved = await first.running(first.session.addTorrentFile(fx.meta.torrent, '/dl'))
  const resume = bdecode(Buffer.from(await first.session.saveResumeData(saved)))

  // The next session's first two addresses, known because its random start is pinned. An earlier
  // session's resume data names one as a peer and the other as a banned peer.
  const random = Math.random
  Math.random = () => 0.25
  defer(() => { Math.random = random })
  const STALE = ['100.80.0.0', '100.80.0.1']
  resume.peers = compact(STALE[0], 6881)
  resume.banned_peers = compact(STALE[1], 6881)
  const second = await startEngine(defer, path.join(fx.root, 'second'))
  Math.random = random
  const { session } = second
  const handle = await second.running(session.addTorrentWithResume(bencode(resume), '/dl'))
  // long enough for libtorrent to have tried a loaded peer over uTP and then dialled it, which is
  // what stamps the entry and makes the next dial of that address wait
  await sleep(7000)

  for (const address of STALE) {
    const [ours] = streamPipe()
    const handedOver = performance.now()
    assert.equal(session.addPeerStream(handle, ours).address, address, 'the test no longer knows which address a stream gets')
    await waitFor(`the dial of ${address}`, () => ours.dialledAt != null, 9000)
    const ms = ours.dialledAt - handedOver
    assert.ok(ms < 3000, `dialled ${Math.round(ms)} ms after addPeerStream`)
  }
})

test('resume data loses all of 100.64.0.0/10 and nothing on either side of it', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const first = await startEngine(defer, path.join(fx.root, 'first'))
  const saved = await first.running(first.session.addTorrentFile(fx.meta.torrent, '/dl'))
  const resume = bdecode(Buffer.from(await first.session.saveResumeData(saved)))

  // the first and the last address of the range, then the address before it and the one after
  const INSIDE = ['100.64.0.0', '100.127.255.255']
  const OUTSIDE = ['100.63.255.255', '100.128.0.0']
  resume.peers = Buffer.concat([...INSIDE, ...OUTSIDE].map((address) => compact(address, 6881)))
  // paused, so nothing is dialled: a peer whose dial failed is not saved, whatever its address
  resume.paused = 1
  resume.auto_managed = 0
  const { session } = await startEngine(defer, path.join(fx.root, 'second'))
  const handle = session.addTorrentWithResume(bencode(resume), '/dl')
  await waitFor('the paused torrent', () => { session.postStatus(handle); return session.status(handle)?.paused })

  const again = bdecode(Buffer.from(await session.saveResumeData(handle)))
  assert.deepEqual(endpoints(again.peers).sort(), OUTSIDE.map((address) => `${address}:6881`).sort())
})
