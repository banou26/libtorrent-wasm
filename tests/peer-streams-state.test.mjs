// A stream address must never get into resume data: loaded back, the stale entry made a new
// stream given that address wait 55 s for its dial. And a stream peer is one the engine dialled:
// an ordinary peer can dial in from inside 100.64.0.0/10, on a carrier's network that uses it.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { countingHost, inStreamRange } from './rig/counting-host.mjs'
import { bdecode, bencode } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'
import { MiB, endpoints, fixture, startEngine, startEngineWithBothKinds, teardown } from './rig/stream-engine.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

const compact = (address, port) => Buffer.from([...address.split('.').map(Number), port >> 8, port & 0xff])

test('resume data keeps an ordinary peer and no stream address', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const ORDINARY = '192.0.2.9'
  const { session, handle, port } = await startEngineWithBothKinds(defer, fx, ORDINARY)
  const resume = bdecode(Buffer.from(await session.saveResumeData(handle)))
  assert.deepEqual(endpoints(resume.peers), [`${ORDINARY}:${port}`])
})

test('an ordinary peer that dialled in from 100.64.0.9 is no stream peer: the peer list, reachable() and resume data say so', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const infoHash = fx.meta.infoHash
  const INBOUND = '100.64.0.9'
  const host = countingHost({ acceptedFrom: INBOUND })
  const engine = await startEngine(defer, path.join(fx.root, 'engine'), { host, reserveListenPort: true })
  const { session } = engine
  const handle = await engine.running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  await waitFor('the listener', () => session.reachable().listening.tcp)

  // a stream peer beside it, in the same lists
  const [ours, theirs] = streamPipe()
  const streamPeer = new ScriptedPeer({ infoHash, socket: theirs })
  defer(() => streamPeer.close())
  session.addPeerStream(handle, ours)
  // it names a port it can be dialled on, which is what makes libtorrent save a peer that dialled in
  const inbound = new ScriptedPeer({ infoHash, port: session.reachable().port, listenPort: 51413 })
  defer(() => inbound.close())
  await Promise.all([streamPeer.connect(), inbound.connect()])
  await waitFor('both peers', () => session.status(handle)?.numPeers === 2)

  const peers = (await session.peers(handle)).map((peer) => [peer.transport, peer.endpoint.replace(/:\d+$/, '')])
  peers.sort(([a], [b]) => a.localeCompare(b))
  assert.deepEqual(peers, [['tcp', INBOUND], ['webrtc', 'webrtc']])

  const reachable = session.reachable()
  assert.deepEqual([reachable.inbound, reachable.inboundByTransport], [1, { tcp: 1 }])
  assert.match(reachable.lastInbound.endpoint, /^100\.64\.0\.9:\d+$/)

  const resume = bdecode(Buffer.from(await session.saveResumeData(handle)))
  assert.deepEqual(endpoints(resume.peers), [`${INBOUND}:51413`])
  assert.deepEqual([...new Set([...host.connects, ...host.datagrams].map((asked) => asked.address))].filter(inStreamRange), [])
})

test('resume data that names addresses in 100.64.0.0/10 keeps them through a load: only what a session made up is taken out', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const first = await startEngine(defer, path.join(fx.root, 'first'))
  const saved = await first.running(first.session.addTorrentFile(fx.meta.torrent, '/dl'))
  const resume = bdecode(Buffer.from(await first.session.saveResumeData(saved)))

  // the first and the last address of the range, then the address before it and the one after
  const NAMED = ['100.64.0.0', '100.127.255.255', '100.63.255.255', '100.128.0.0']
  resume.peers = Buffer.concat(NAMED.map((address) => compact(address, 6881)))
  // paused, so nothing is dialled: a peer whose dial failed is not saved, whatever its address
  resume.paused = 1
  resume.auto_managed = 0
  const { session } = await startEngine(defer, path.join(fx.root, 'second'))
  const handle = session.addTorrentWithResume(bencode(resume), '/dl')
  await waitFor('the paused torrent', () => { session.postStatus(handle); return session.status(handle)?.paused })

  const again = bdecode(Buffer.from(await session.saveResumeData(handle)))
  assert.deepEqual(endpoints(again.peers).sort(), NAMED.map((address) => `${address}:6881`).sort())
})
