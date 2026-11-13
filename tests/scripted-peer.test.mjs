// Other tests wait on a scripted peer's connect(), so it has to end when the engine says nothing:
// libtorrent closes a connection it does not want without a byte, and a wait on that never ended.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ScriptedPeer } from './rig/scripted-peer.mjs'
import { streamPipe } from './rig/stream-pipe.mjs'

test('a connect that gets no handshake back is rejected after 20 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // a stream nobody holds the other end of
  const [, theirs] = streamPipe()
  let outcome = 'pending'
  new ScriptedPeer({ infoHash: '00'.repeat(20), socket: theirs }).connect().catch((error) => { outcome = error.message })

  t.mock.timers.tick(19_999)
  await Promise.resolve()
  assert.equal(outcome, 'pending')
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(outcome, 'no handshake from the engine within 20 s')
})
