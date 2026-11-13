// The two bounds on a peer stream, against the real engine. A stream cannot pause its sender and
// the shim used to take every write, so without them a slow remote or a fast one grows a queue in
// the page without limit.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { waitFor } from './rig/peer-handshake.mjs'
import { ScriptedPeer } from './rig/scripted-peer.mjs'
import { MiB, done, fixture, startEngine, startSeeder, teardown, tempDir } from './rig/stream-engine.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A seeding engine uploads for 4 s through a stream that carries 2 MiB/s. */
const uploadThroughSlowStream = async (t, backpressure) => {
  const defer = teardown(t)
  const fx = fixture(defer, 16 * MiB)
  const seeder = await startSeeder(defer, fx)
  const leech = await startEngine(defer, path.join(fx.root, 'leech'))
  const handle = await leech.running(leech.session.addTorrentFile(fx.meta.torrent, '/dl'))
  const [slow, far] = streamPipe({ backpressure, bytesPerSecond: 2 * MiB })
  seeder.session.addPeerStream(seeder.handle, slow)
  leech.session.addPeerStream(handle, far)
  await sleep(4000)
  assert.ok(far.received > 4 * MiB, `only ${far.received} bytes crossed the stream`)
  return { slow, sends: seeder.session.mod.__FKN.stats.send }
}

test('a slow stream that asks for backpressure holds about a megabyte', async (t) => {
  const { slow, sends } = await uploadThroughSlowStream(t, true)
  // the socket answers false past 1 MiB, and one write is at most about 512 KiB
  assert.ok(slow.peakQueued < 2 * MiB, `${slow.peakQueued} bytes sat in the stream`)
  // a held fd that still reads as writable has its send retried on every pass of the reactor
  assert.equal(sends, slow.writes, 'send was called while the socket was held back')
})

test('a slow stream that does not ask is written to regardless', async (t) => {
  const { slow } = await uploadThroughSlowStream(t, false)
  assert.ok(slow.peakQueued > 3 * MiB, `only ${slow.peakQueued} bytes sat in the stream, so the test above proves nothing`)
})

test('a stream whose unread bytes pass maxRecvQueue is destroyed, and the engine carries on', async (t) => {
  const defer = teardown(t)
  const fx = fixture(defer, MiB)
  const { session, running } = await startEngine(defer, path.join(fx.root, 'leech'))
  const handle = await running(session.addTorrentFile(fx.meta.torrent, '/dl'))

  const [ours, theirs] = streamPipe()
  ours.maxRecvQueue = 256 * 1024
  let remoteClosed = false
  theirs.on('close', () => { remoteClosed = true })
  session.addPeerStream(handle, ours)
  assert.equal(ours.maxRecvQueue, 256 * 1024, 'a bound the socket set was replaced')
  await waitFor('the dial', () => ours.dialledAt != null)

  // under the bound, and not a handshake: libtorrent drops the peer itself, with no error
  theirs.write(Buffer.alloc(200 * 1024))
  await waitFor('libtorrent to drop the peer', () => ours.destroyed)
  assert.equal(ours.destroyError, null)

  const [flooded, flooder] = streamPipe()
  flooded.maxRecvQueue = 256 * 1024
  session.addPeerStream(handle, flooded)
  await waitFor('the second dial', () => flooded.dialledAt != null)
  flooder.write(Buffer.alloc(300 * 1024))
  await waitFor('the bound', () => flooded.destroyed)
  assert.match(String(flooded.destroyError), /maxRecvQueue/, 'it was not the bound that closed the stream')
  await waitFor('the remote end to see the stream close', () => remoteClosed)

  const before = session.status(handle)
  await waitFor('a later status update', () => session.status(handle) !== before)
  assert.equal(session.status(handle).numPeers, 0)
})

test('a peer that takes any number of requests and answers each at once stays under the bound addPeerStream sets', async (t) => {
  const defer = teardown(t)
  const PIECE = MiB
  // The engine asks for twice as much every round, so the torrent has to be this big for a round
  // to pass the bound: one of 8192 blocks, 128 MiB, needs 8191 blocks asked for before it.
  const fx = fixture(defer, 384 * MiB, PIECE)
  const leech = await startEngine(defer, path.join(fx.root, 'leech'))
  const { session } = leech
  const handle = await leech.running(session.addTorrentFile(fx.meta.torrent, '/dl'))

  const [ours, theirs] = streamPipe()
  // It says it takes 65535 requests at once, the most libtorrent reads. The engine's own limit of
  // 5000 holds all the same (patch 0012), as it does for a peer that says nothing, like WebTorrent.
  const seed = new ScriptedPeer({
    infoHash: fx.meta.infoHash,
    socket: theirs,
    reqq: 65535,
    serve: (piece, offset, length) => fx.bytes.subarray(piece * PIECE + offset, piece * PIECE + offset + length),
  })
  seed.connect()
  const { address } = session.addPeerStream(handle, ours)
  assert.equal(ours.maxRecvQueue, 96 * MiB)

  // the fd behind the stream, read after every delivery for what libtorrent has not read yet
  let peakUnread = 0
  const emit = ours.emit.bind(ours)
  ours.emit = (event, ...args) => {
    const delivered = emit(event, ...args)
    if (event === 'data') {
      const st = [...session.mod.__FKN.fds.values()].find((s) => s.remoteAddr === address)
      if (st) peakUnread = Math.max(peakUnread, st.recv.total)
    }
    return delivered
  }

  await waitFor('the download', () => done(session, handle) || ours.destroyError, 120_000)
  assert.equal(ours.destroyError, null, `closed with ${peakUnread} bytes unread`)
  assert.ok(done(session, handle))
  // 5000 blocks are 78 MiB and the round before them is 64 MiB: under this the engine never asked
  // for all it may, and the run proves nothing
  assert.ok(peakUnread > 72 * MiB, `only ${peakUnread} bytes were ever unread`)
  assert.ok(peakUnread < 96 * MiB)
  t.diagnostic(`peak unread ${(peakUnread / MiB).toFixed(2)} MiB`)
})
