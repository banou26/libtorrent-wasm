// Two factories joined by an in-memory socket pair: no network, no native module. Besides the
// transfer, this is where the two rules for driving str0m are pinned, on a trace of every call
// the module makes into its wasm.
//
// Both rules were found by getting them wrong: an operation that is not drained to the end before
// the next one is outside str0m's one contract, and an ICE agent that is never told the time
// after a description sends no check, so two of these facing each other would wait for ever.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebRTC, MiB, once, pair, receive, send, wasm } from './rig/local.mjs'
import { socketPair } from './rig/memory-network.mjs'
import { operations, traced } from './rig/trace.mjs'

/** Two factories and a connection of each. They are closed when test `t` ends, passed or not. */
async function facing(t, options) {
  const sockets = socketPair(options)
  const [A, B] = await Promise.all(
    sockets.map((socket) => createWebRTC({ socket, address: socket.address, port: socket.port, wasm, allowPrivateCandidates: true })),
  )
  t.after(() => {
    A.close()
    B.close()
  })
  return { A, B, sockets, a: new A.RTCPeerConnection(), b: new B.RTCPeerConnection() }
}

/**
 * Fails unless each call that changes a connection was followed by polls until the stack had
 * nothing more to say, before the next such call. `names` are calls the trace must have seen.
 * Answers the calls of each of the two connections.
 */
function drained(calls, names) {
  const all = operations(calls)
  for (const name of names) {
    assert.ok(all.some((operation) => operation.name === name), `the trace saw no ${name}, so it proves nothing about it`)
  }
  const connections = Map.groupBy(all, (operation) => operation.connection)
  assert.equal(connections.size, 2)
  for (const list of connections.values()) {
    list.slice(0, -1).forEach((operation, at) => {
      assert.ok(operation.drained, `${operation.name} was followed by ${list[at + 1].name} before the stack had nothing more to say`)
    })
  }
  return connections
}

test('two factories with no network move 8 MiB each way, hashes equal', async (t) => {
  const { A, B, a, b } = await facing(t)
  const [ours, theirs] = await pair(a, b)
  assert.equal(theirs.label, ours.label)
  assert.equal(a.connectionState, 'connected')

  for (const [from, to] of [
    [ours, theirs],
    [theirs, ours],
  ]) {
    const arriving = receive(to, 8 * MiB)
    const sent = await send(from, 8 * MiB, 16384)
    const arrived = await arriving
    assert.equal(arrived.bytes, 8 * MiB)
    assert.equal(arrived.messages, 512)
    assert.equal(arrived.sha256, sent)
  }
  assert.equal(A.droppedDatagrams + B.droppedDatagrams, 0)
})

test('text and binary messages arrive as they were sent, in order', async (t) => {
  const { A, B, a, b } = await facing(t)
  const [ours, theirs] = await pair(a, b)
  const got = []
  theirs.onmessage = ({ data }) => got.push(typeof data === 'string' ? data : new Uint8Array(data))
  ours.send('first')
  ours.send(new Uint8Array([1, 2, 3]))
  ours.send(new Uint8Array([9, 8, 7, 6]).buffer)
  ours.send(new DataView(new Uint8Array([0, 5, 6, 0]).buffer, 1, 2))
  ours.send('last \u00e9\u2603')
  while (got.length < 5) await once(theirs, 'message')
  assert.deepEqual(got, ['first', new Uint8Array([1, 2, 3]), new Uint8Array([9, 8, 7, 6]), new Uint8Array([5, 6]), 'last \u00e9\u2603'])
  assert.equal(theirs.binaryType, 'arraybuffer')
  assert.throws(() => (theirs.binaryType = 'blob'), { name: 'NotSupportedError' })
})

test('every call into a connection is drained to the end before the next, and a description is followed by the time', async (t) => {
  const { calls, result } = await traced(() => facing(t))
  const { A, B, a, b } = result
  const [ours, theirs] = await pair(a, b)

  // operations asked for from inside a drain, which have to wait their turn
  theirs.onmessage = ({ data }) => {
    theirs.send(data)
    if (data === 'close') theirs.close()
  }
  const echoed = []
  ours.onmessage = ({ data }) => echoed.push(data)
  const second = a.createDataChannel('second')
  await once(second, 'open')
  for (const text of ['one', 'two', 'close']) ours.send(text)
  await once(ours, 'close')
  assert.deepEqual(echoed, ['one', 'two', 'close'])
  // long enough for a timer of the stack to fire
  await new Promise((resolve) => setTimeout(resolve, 300))
  a.close()
  await once(b, 'connectionstatechange')
  B.close()
  A.close()

  const connections = drained(calls, ['rtc_open', 'rtc_accept_offer', 'rtc_accept_answer', 'rtc_receive', 'rtc_timeout', 'rtc_write', 'rtc_close_channel', 'rtc_close'])
  const described = []
  for (const [connection, list] of connections) {
    assert.ok(list.length > 20, `connection ${connection} made only ${list.length} calls`)
    list.slice(0, -1).forEach((operation, at) => {
      // the first rtc_open of the offering side is the one that makes a description
      if (!operation.name.startsWith('rtc_accept_') && !(operation.name === 'rtc_open' && at === 0)) return
      described.push(operation.name)
      assert.equal(list[at + 1].name, 'rtc_timeout', `${operation.name} was followed by ${list[at + 1].name}, not by the time`)
    })
  }
  assert.deepEqual(described.sort(), ['rtc_accept_answer', 'rtc_accept_offer', 'rtc_open'])
})

test('close() called by a handler ends the drain it was called in before the stack hears of it', async (t) => {
  const { calls, result } = await traced(() => facing(t))
  const { a, b } = result
  const [ours, theirs] = await pair(a, b)
  // inside the drain of the datagram that carried the message
  theirs.onmessage = () => b.close()
  ours.send('close yourself')
  await once(a, 'connectionstatechange', 5000)
  assert.equal(a.connectionState, 'failed')
  assert.equal(b.connectionState, 'closed')
  drained(calls, ['rtc_receive', 'rtc_close'])
})

test('with sockets that deliver inside send(), every call is still drained to the end before the next', { timeout: 10_000 }, async (t) => {
  const { calls, result } = await traced(() => facing(t, { inside: true }))
  const { A, B, a, b } = result
  const [ours, theirs] = await pair(a, b)
  const arriving = receive(theirs, MiB)
  const sent = await send(ours, MiB, 16384)
  assert.equal((await arriving).sha256, sent)
  assert.equal(A.droppedDatagrams + B.droppedDatagrams, 0)
  drained(calls, ['rtc_open', 'rtc_accept_offer', 'rtc_accept_answer', 'rtc_receive', 'rtc_timeout', 'rtc_write'])
})

test('closing a connection tells the peer at once, and fires no connectionstatechange on the closer', async (t) => {
  const { A, B, a, b } = await facing(t)
  const [ours, theirs] = await pair(a, b)
  const events = []
  a.onconnectionstatechange = () => events.push(`a ${a.connectionState}`)
  b.onconnectionstatechange = () => events.push(`b ${b.connectionState}`)
  ours.onclose = () => events.push('ours close')
  theirs.onclose = () => events.push('theirs close')
  theirs.onerror = () => events.push('theirs error')

  a.close()
  assert.equal(a.connectionState, 'closed')
  assert.notEqual(ours.readyState, 'open')
  assert.throws(() => ours.send('late'), { name: 'InvalidStateError' })
  // the peer hears of it from the packets the close sends, long before its ICE agent gives up (22 s)
  await once(b, 'connectionstatechange', 2000)
  assert.equal(b.connectionState, 'failed')
  assert.equal(ours.readyState, 'closed')
  assert.equal(theirs.readyState, 'closed')
  assert.deepEqual(events.sort(), ['b failed', 'ours close', 'theirs close'])

  a.close()
  b.close()
  assert.equal(b.connectionState, 'closed')
})

test('a closed channel has delivered everything sent before the close, and the connection stays up', async (t) => {
  const { A, B, a, b } = await facing(t)
  const [ours, theirs] = await pair(a, b)
  let arrived = 0
  let arrivedAtClose
  let arrivedAtOurClose
  theirs.onmessage = ({ data }) => (arrived += data.byteLength)
  theirs.onclose = () => (arrivedAtClose = arrived)
  ours.onclose = () => (arrivedAtOurClose = arrived)
  const message = new Uint8Array(16384)
  for (let i = 0; i < 256; i++) ours.send(message)
  ours.close()
  assert.equal(ours.readyState, 'closing')
  assert.throws(() => ours.send(message), { name: 'InvalidStateError' })
  await Promise.all([once(ours, 'close'), once(theirs, 'close')])
  assert.equal(ours.readyState, 'closed')
  assert.equal(theirs.readyState, 'closed')
  assert.equal(arrivedAtClose, 4 * MiB)
  assert.equal(arrivedAtOurClose, 4 * MiB, 'our close event waits until the peer has acknowledged everything')
  assert.equal(ours.bufferedAmount, 0)
  assert.equal(a.connectionState, 'connected')
  assert.equal(b.connectionState, 'connected')

  const again = b.createDataChannel('again')
  const [{ channel }] = await Promise.all([once(a, 'datachannel'), once(again, 'open')])
  assert.equal(channel.label, 'again')
})
