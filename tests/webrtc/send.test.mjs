// What send() refuses and what it queues, between two factories on in-memory sockets. The three
// errors and the 16 MiB queue are Chrome's, measured on Chrome 156: InvalidStateError unless
// open, TypeError over the max message size, OperationError once a send would take the queue
// past 16 MiB, after which the channel goes on.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createWebRTC, fill, MiB, once, pair, receive, settled, wasm } from './rig/local.mjs'
import { socketPair } from './rig/memory-network.mjs'
import { traced } from './rig/trace.mjs'

async function open(t, options) {
  const [A, B] = await Promise.all(
    socketPair().map((socket) =>
      createWebRTC({ socket, address: socket.address, port: socket.port, wasm, allowPrivateCandidates: true, ...options }),
    ),
  )
  t.after(() => {
    A.close()
    B.close()
  })
  const a = new A.RTCPeerConnection()
  const [ours, theirs] = await pair(a, new B.RTCPeerConnection())
  return { a, ours, theirs }
}

const sha256 = (...parts) => parts.reduce((hash, part) => hash.update(part), createHash('sha256')).digest('hex')

test('send throws InvalidStateError unless the channel is open', async (t) => {
  const { a, ours } = await open(t)
  const connecting = a.createDataChannel('second')
  assert.equal(connecting.readyState, 'connecting')
  assert.throws(() => connecting.send('early'), { name: 'InvalidStateError' })
  await once(connecting, 'open')
  connecting.send('now')

  ours.close()
  assert.throws(() => ours.send('closing'), { name: 'InvalidStateError' })
  await once(ours, 'close')
  assert.throws(() => ours.send('closed'), { name: 'InvalidStateError' })
})

test('send takes a message of the max message size, and throws TypeError over it and for what is no message', async (t) => {
  const { a, ours, theirs } = await open(t)
  const max = a.sctp.maxMessageSize
  assert.equal(max, 262144)
  const largest = new Uint8Array(max).map((_, i) => i % 251)
  const arriving = receive(theirs, max)
  ours.send(largest)
  assert.deepEqual(await arriving, { sha256: sha256(largest), bytes: max, messages: 1 })

  assert.throws(() => ours.send(new Uint8Array(max + 1)), TypeError)
  assert.throws(() => ours.send('x'.repeat(max + 1)), TypeError)
  for (const none of [undefined, null, 5, {}, [1, 2], new Blob(['x'])]) assert.throws(() => ours.send(none), TypeError)
  // str0m takes an empty message and sends nothing: refused here rather than lost
  assert.throws(() => ours.send(''), { name: 'NotSupportedError' })
  assert.throws(() => ours.send(new ArrayBuffer(0)), { name: 'NotSupportedError' })
  assert.equal(ours.readyState, 'open')
})

test('send throws OperationError once 16 MiB is queued, loses nothing, and the channel goes on', async (t) => {
  const { ours, theirs } = await open(t)
  await settled(ours)
  const sent = fill(ours)
  assert.equal(sent.error.name, 'OperationError')
  assert.equal(sent.taken, 256, 'exactly 16 MiB is taken')
  assert.equal(ours.bufferedAmount, 16 * MiB)
  assert.equal(ours.readyState, 'open')

  const arrived = await receive(theirs, 16 * MiB)
  assert.equal(arrived.sha256, sent.sha256)
  assert.equal(arrived.messages, sent.taken)
  await settled(ours)
  const more = receive(theirs, 4)
  ours.send(new Uint8Array([1, 2, 3, 4]))
  assert.equal((await more).sha256, sha256(new Uint8Array([1, 2, 3, 4])))
})

test('bufferedamountlow fires once the amount has fallen to the threshold, and never inside send', async (t) => {
  const { ours } = await open(t)
  await settled(ours)
  assert.equal(ours.bufferedAmountLowThreshold, 0)
  ours.bufferedAmountLowThreshold = 256 * 1024
  const fired = []
  let sending = false
  ours.onbufferedamountlow = () => fired.push({ sending, amount: ours.bufferedAmount })

  sending = true
  for (let i = 0; i < 64; i++) ours.send(new Uint8Array(65536))
  sending = false
  assert.equal(ours.bufferedAmount, 4 * MiB)
  assert.deepEqual(fired, [])

  await once(ours, 'bufferedamountlow')
  await settled(ours)
  assert.equal(fired.length, 1, 'one event for one fall through the threshold')
  assert.equal(fired[0].sending, false)
  assert.ok(fired[0].amount <= 256 * 1024, `fired at ${fired[0].amount}`)

  // below the threshold the whole time: nothing fell through it
  ours.send(new Uint8Array(1024))
  await settled(ours)
  assert.equal(fired.length, 1)

  ours.bufferedAmountLowThreshold = 0
  ours.send(new Uint8Array(1024))
  await once(ours, 'bufferedamountlow')
  assert.equal(fired.at(-1).amount, 0)
})

test('a message is the bytes it held when send was called, sent at once or queued', async (t) => {
  const { ours, theirs } = await open(t)
  await settled(ours)
  const got = []
  theirs.onmessage = ({ data }) => got.push(new Uint8Array(data))

  const reused = new Uint8Array(1024).fill(1)
  ours.send(reused)
  reused.fill(2)
  // 2 MiB is more than the send buffer holds, so what follows waits in the queue
  for (let i = 0; i < 32; i++) ours.send(new Uint8Array(65536))
  ours.send(reused)
  assert.ok(ours.bufferedAmount > MiB + 1024)
  reused.fill(3)

  while (got.length < 34) await once(theirs, 'message')
  assert.deepEqual(got[0], new Uint8Array(1024).fill(1))
  assert.deepEqual(got[33], new Uint8Array(1024).fill(2))
})

test('sendBufferSize is how much of a connection the stack may hold: up to it, and never more', async (t) => {
  for (const sendBufferSize of [262144, MiB]) {
    const { calls, result } = await traced(() => open(t, { sendBufferSize }))
    const { ours, theirs } = result
    const arriving = receive(theirs, 4 * MiB)
    for (let i = 0; i < 64; i++) ours.send(new Uint8Array(65536))
    await arriving
    // what the stack said it held, each time it was asked: the receiving side holds next to nothing
    const held = calls.filter(({ name }) => name === 'rtc_buffered').reduce((most, { result }) => Math.max(most, result), 0)
    assert.ok(held <= sendBufferSize, `the stack held ${held} with a send buffer of ${sendBufferSize}`)
    assert.ok(held > sendBufferSize / 2, `the stack never held more than ${held} of a send buffer of ${sendBufferSize}`)
  }
})
