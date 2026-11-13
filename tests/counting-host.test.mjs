// The counting host is what other tests read their zeros from, so it has to count what the shim
// really does. A session without a reserved port sends its first datagram before its udp socket
// has bound.

import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import test from 'node:test'

import { countingHost } from './rig/counting-host.mjs'
import { waitFor } from './rig/peer-handshake.mjs'

test('a loopback datagram sent before the socket has bound is counted once and delivered', async (t) => {
  const receiver = dgram.createSocket('udp4')
  t.after(() => receiver.close())
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve))
  const { port } = receiver.address()
  const received = []
  receiver.on('message', (message) => received.push(message.toString()))

  const host = countingHost()
  const socket = host.dgram.createSocket({ type: 'udp4' })
  t.after(() => socket.close())
  socket.send(Buffer.from('ping'), 0, 4, port, '127.0.0.1')

  await waitFor('the datagram', () => received.length > 0, 5000)
  assert.deepEqual(received, ['ping'])
  assert.deepEqual(host.datagrams, [{ address: '127.0.0.1', port }])
})
