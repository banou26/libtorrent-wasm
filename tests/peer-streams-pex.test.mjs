// A stream address must never be in the peer exchange messages the engine sends: other clients
// dial what they are told (measured: 14 to 20 connects a run, on their own network, from
// Transmission 4.1.3 and node WebTorrent). libtorrent builds the first message to a peer and the
// ones a minute apart in two different loops, so both are read here.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bdecode } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'
import { MiB, endpoints, fixture, startEngineWithBothKinds, teardown } from './rig/stream-engine.mjs'

test('peer exchange names an ordinary peer and no stream address, in the first message and a minute later', async (t) => {
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
