// A pause and a resume with ordinary peers: two engines on loopback sockets, a seed and a download from it. The
// pause closes the connection, and libtorrent then dials that peer again only after min_reconnect_time (60 s),
// unless the resume clears the wait (patch 0016).

import path from 'node:path'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { magnetFor } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { MiB, fixture, startEngine, startSeeder, teardown } from './rig/stream-engine.mjs'

test('a download paused and resumed at once has the next byte from its seed within 10 s', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, 16 * MiB)
  // uploads capped, so the download is far from done when it is paused
  const seeder = await startSeeder(defer, fx, 'seeder', { host: countingHost(), reserveListenPort: true, rateLimits: { upload: 400_000 } })
  await waitFor('the seed\'s listener', () => seeder.session.reachable().listening.tcp)
  const leech = await startEngine(defer, path.join(fx.root, 'leech'), { host: countingHost(), reserveListenPort: true })
  const magnet = magnetFor(fx.meta.infoHash, fx.meta.name, [{ host: '127.0.0.1', port: seeder.session.reachable().port }])
  const handle = await leech.running(leech.session.addMagnet(magnet, '/dl'))
  const status = () => leech.session.status(handle)

  await waitFor('2 MiB in', () => status()?.totalDone >= 2 * MiB, 30_000)
  leech.session.pauseTorrent(handle)
  await waitFor('the pause to close the seed', () => status().paused && status().numPeers === 0)
  const before = status().totalDone
  leech.session.resumeTorrent(handle)
  await waitFor('the next byte', () => status().totalDone > before, 10_000)
})
