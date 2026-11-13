// A stream address must never be in the peer exchange messages the engine sends: other clients
// dial what they are told (measured: 14 to 20 connects a run, on their own network, from
// Transmission 4.1.3 and node WebTorrent). libtorrent builds the first message to a peer and the
// ones a minute apart in two different loops, so both are read here.
//
// And the other way round: libtorrent takes a local address from a peer that is local itself, which
// a stream peer is, so any stream peer could have the engine ask its host for loopback and private
// addresses (measured: a connect and a datagram to each one named).

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { bdecode } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'
import { MiB, endpoints, fixture, startEngine, startEngineWithBothKinds, teardown } from './rig/stream-engine.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

// libtorrent sends the second message a minute after the first, so this one outlasts the 60 s the
// test scripts give a case.
test('peer exchange names an ordinary peer and no stream address, in the first message and a minute later', { timeout: 120_000 }, async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  // a public address by libtorrent's rules, so a message without it would be a fault too
  const ORDINARY = '203.0.113.5'
  const { session, port } = await startEngineWithBothKinds(defer, fx, ORDINARY, { reserveListenPort: true })

  // a third peer, which the engine tells about the other two
  await waitFor('the listener', () => session.reachable().listening.tcp)
  const reader = new ScriptedPeer({ infoHash: fx.meta.infoHash, port: session.reachable().port })
  defer(() => reader.close())
  await reader.connect()
  await waitFor('the first ut_pex message', () => reader.pex.length > 0, 15_000)
  assert.deepEqual(endpoints(bdecode(reader.pex[0]).added), [`${ORDINARY}:${port}`])

  await waitFor('the next ut_pex message', () => reader.pex.length > 1, 75_000)
  assert.deepEqual(endpoints(bdecode(reader.pex[1]).added), [`${ORDINARY}:${port}`])
})

test('a local address a stream peer names in peer exchange is never asked of the host', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const host = countingHost()
  const engine = await startEngine(defer, path.join(fx.root, 'engine'), { host })
  const { session } = engine
  const handle = await engine.running(session.addTorrentFile(fx.meta.torrent, '/dl'))
  // every dial into the stream range, which the shim asks the session for
  const dialled = []
  const take = session.mod.fkn.takeStream
  session.mod.fkn.takeStream = (address) => { dialled.push(address); return take(address) }

  const [ours, theirs] = streamPipe()
  const peer = new ScriptedPeer({ infoHash: fx.meta.infoHash, socket: theirs })
  const stream = session.addPeerStream(handle, ours)
  await peer.connect()
  await waitFor("the engine's extension handshake", () => peer.enginePexId)

  const PUBLIC = '203.0.113.77'
  const LOCAL = ['10.1.2.3', '172.16.4.4', '192.168.5.5', '169.254.6.6', '127.0.0.9', '100.64.9.9']
  peer.sendPex([...LOCAL, PUBLIC].map((address) => `${address}:6881`))

  // a peer learned this way is tried over uTP first and dialled about 5 s later
  await waitFor('the dial of the public address', () => host.connects.some((c) => c.address === PUBLIC), 20_000)
  assert.deepEqual([...new Set(host.connects.map((c) => c.address))], [PUBLIC])
  assert.deepEqual([...new Set(host.datagrams.map((d) => d.address))], [PUBLIC])
  assert.deepEqual(dialled, [stream.address], 'a stream address a peer named was dialled')
})
