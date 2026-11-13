// ut_holepunch is not spoken with a stream peer (patch 0013), because a rendezvous hands a third
// peer an address:
// - asked of a stream peer, ours. A libtorrent 2.1 remote tells the peer we could not reach to
//   connect to us, and that peer then leaves our stream to it silent (measured against the 2.1
//   wheel: the request went out in 29 of 29 runs, and the peer held our address 2 to 9 s later).
// - asked by a stream peer, the made-up one, which the peer it names would dial on its own network.
//
// Each case ends on a round trip instead of a wait: libtorrent handles a peer's messages in order
// and answers in the order it wrote, so once a request sent after the cause has its reject back,
// whatever the cause made the engine send has left it.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { waitFor } from './rig/peer-handshake.mjs'
import { PEX_HOLEPUNCH, ScriptedPeer } from './rig/scripted-peer.mjs'
import { MiB, dialTcp, fixture, listen, startEngine, teardown } from './rig/stream-engine.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

// the first and the last address of 100.64.0.0/10, then the address before it and the one after
const INSIDE = ['100.64.0.0', '100.127.255.255']
const OUTSIDE = ['100.63.255.255', '100.128.0.0']
// peers that exist nowhere, one for each peer that names one
const NAMED = ['203.0.113.71', '203.0.113.72']

/** An engine holding the fixture's torrent, on a host that carries loopback only and routes `OUTSIDE` to it. */
const startCounted = async (defer) => {
  const fx = fixture(defer, MiB)
  const host = countingHost({ routes: Object.fromEntries(OUTSIDE.map((address) => [address, '127.0.0.1'])) })
  const engine = await startEngine(defer, path.join(fx.root, 'engine'), { host })
  const handle = await engine.running(engine.session.addTorrentFile(fx.meta.torrent, '/dl'))
  return { session: engine.session, handle, host, infoHash: fx.meta.infoHash }
}

/** A scripted peer on a stream, with the address the session made up for it. */
const streamPeer = async ({ session, handle, infoHash }) => {
  const [ours, theirs] = streamPipe()
  const peer = new ScriptedPeer({ infoHash, socket: theirs })
  const { address } = session.addPeerStream(handle, ours)
  await peer.connect()
  await waitFor("the engine's extension handshake", () => peer.engineHolepunchId)
  return { peer, endpoint: `${address}:6881` }
}

/** The same scripted peer as an ordinary one: the engine dials it at `address`, which the host routes here. */
const ordinaryPeer = async (defer, { session, handle, infoHash }, address) => {
  let peer
  let connected
  const port = await listen(defer, (socket) => {
    peer = new ScriptedPeer({ infoHash, socket })
    connected = peer.connect()
  })
  dialTcp(session, handle, address, port)
  await waitFor(`the dial of ${address}`, () => connected)
  await connected
  await waitFor("the engine's extension handshake", () => peer.engineHolepunchId)
  return { peer, endpoint: `${address}:${port}` }
}

/** Resolves once the engine has answered a request sent now, so with everything it wrote to `peer` before. */
const roundTrip = async (peer) => {
  const before = peer.rejects.length
  peer.request(0, 0, 16384)
  await waitFor('the reject of a request the engine cannot serve', () => peer.rejects.length > before)
}

/**
 * Each peer names a peer of its own that supports ut_holepunch and cannot be reached. Resolves with
 * what the engine then sent each one over ut_holepunch.
 */
const holepunchAfterNaming = async (host, peers) => {
  peers.forEach(({ peer }, i) => peer.sendPex([`${NAMED[i]}:6881`], PEX_HOLEPUNCH))
  // libtorrent tries a named peer over uTP, dials it about 5 s later, and asks whoever named it
  // for a rendezvous when that dial fails. The host refuses the dial as soon as it is asked.
  await waitFor('the dial of each named peer', () => NAMED.every((address) => host.connects.some((c) => c.address === address)), 30_000)
  for (const { peer } of peers) await roundTrip(peer)
  return peers.map(({ peer }) => peer.holepunch)
}

test('a stream peer is never asked for a holepunch rendezvous, at either end of 100.64.0.0/10', async (t) => {
  const defer = teardown(t)
  // the session's first stream gets the last address of the range and its second the first
  const random = Math.random
  Math.random = () => 1 - 2 ** -23
  defer(() => { Math.random = random })
  const engine = await startCounted(defer)
  Math.random = random
  const peers = [await streamPeer(engine), await streamPeer(engine)]
  assert.deepEqual(peers.map((p) => p.endpoint).sort(), INSIDE.map((address) => `${address}:6881`).sort(), 'the test no longer knows which address a stream gets')

  assert.deepEqual(await holepunchAfterNaming(engine.host, peers), [[], []])
})

test('an ordinary peer is still asked for a holepunch rendezvous, up to either side of 100.64.0.0/10', async (t) => {
  const defer = teardown(t)
  const engine = await startCounted(defer)
  const peers = [await ordinaryPeer(defer, engine, OUTSIDE[0]), await ordinaryPeer(defer, engine, OUTSIDE[1])]

  assert.deepEqual(await holepunchAfterNaming(engine.host, peers), NAMED.map((address) => [{ type: 'rendezvous', endpoint: `${address}:6881` }]))
})

test('no holepunch message from a stream peer is acted on, and a rendezvous between ordinary peers is served', async (t) => {
  const defer = teardown(t)
  const engine = await startCounted(defer)
  const [first, second] = [await ordinaryPeer(defer, engine, OUTSIDE[0]), await ordinaryPeer(defer, engine, OUTSIDE[1])]
  const stream = await streamPeer(engine)

  stream.peer.sendHolepunch('rendezvous', first.endpoint)
  // libtorrent dials a peer it is told to connect to at once, over uTP
  stream.peer.sendHolepunch('connect', `${NAMED[0]}:6881`)
  await roundTrip(stream.peer)
  await roundTrip(first.peer)
  assert.deepEqual(first.peer.holepunch, [], 'an ordinary peer was told to connect to a stream address')
  assert.deepEqual(stream.peer.holepunch, [])
  assert.deepEqual(engine.host.datagrams.filter((d) => d.address === NAMED[0]), [], 'a peer a stream peer said to connect to was dialled')

  second.peer.sendHolepunch('rendezvous', first.endpoint)
  await waitFor('both ordinary peers to be told of each other', () => first.peer.holepunch.length && second.peer.holepunch.length)
  assert.deepEqual(first.peer.holepunch, [{ type: 'connect', endpoint: second.endpoint }])
  assert.deepEqual(second.peer.holepunch, [{ type: 'connect', endpoint: first.endpoint }])
})
