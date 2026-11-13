// The module against libdatachannel 0.24, the stack qBittorrent 5.3.0 carries, in both roles,
// over node's own dgram on loopback. The remote is node-datachannel in a child process
// (rig/libdatachannel-peer.mjs). Nothing leaves the machine.
//
// WEBRTC_TEST_MIB sets the size of the transfer each way: 16 by default, 64 for the long run.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { connect, fill, listen, MiB, once, receive, send, settled } from './rig/local.mjs'
import { spawnRemote } from './rig/remote.mjs'

const TRANSFER = Number(process.env.WEBRTC_TEST_MIB ?? 16) * MiB

async function linked(t, { offer = true, remoteOptions } = {}) {
  const local = await listen()
  const remote = await spawnRemote(remoteOptions)
  t.after(async () => {
    await remote.exit()
    await local.close()
  })
  const pc = new local.RTCPeerConnection()
  return { local, remote, pc, ...(await connect(pc, remote, { offer })) }
}

/** `bytes` in messages of `size` to the remote, then the same back, each compared by SHA-256. */
async function bothWays({ channel, remote }, bytes, size) {
  remote.send({ t: 'expect', bytes })
  const sent = await send(channel, bytes, size)
  const received = await remote.next('received', 120_000)
  assert.equal(received.sha256, sent, `${bytes} bytes in messages of ${size} to the remote`)
  assert.equal(received.messages, Math.ceil(bytes / size))

  const arriving = receive(channel, bytes)
  remote.send({ t: 'send', bytes, size })
  const [arrived, theirs] = await Promise.all([arriving, remote.next('sent', 120_000)])
  assert.equal(arrived.sha256, theirs.sha256, `${bytes} bytes in messages of ${size} from the remote`)
  assert.equal(arrived.messages, theirs.messages)
}

for (const offer of [true, false]) {
  const role = offer ? 'offering' : 'answering'

  test(`${role}: messages of 16 KiB, 64 KiB and the max message size arrive whole, both ways, and text as text`, async (t) => {
    const link = await linked(t, { offer })
    const { pc, channel, remote, opened } = link
    assert.match(opened.library, /^0\.24\./, 'the peer is the libdatachannel qBittorrent 5.3.0 uses')
    assert.equal(opened.label, 'test')
    assert.equal(channel.label, 'test')
    assert.equal(channel.readyState, 'open')
    assert.equal(pc.connectionState, 'connected')
    assert.equal(pc.sctp.maxMessageSize, 262144)
    assert.equal(opened.maxMessageSize, 262144, 'what our description lets the remote send')

    for (const size of [16384, 65536, pc.sctp.maxMessageSize]) await bothWays(link, size, size)

    channel.send('to the remote é')
    assert.equal((await remote.next('text')).text, 'to the remote é')
    const said = once(channel, 'message')
    remote.send({ t: 'say', text: 'from the remote é' })
    assert.equal((await said).data, 'from the remote é')
  })

  test(`${role}: the selected pair's remote is the address and port libdatachannel sends from`, async (t) => {
    const { pc, remote } = await linked(t, { offer })
    remote.send({ t: 'pair' })
    const { local } = await remote.next('pair')
    assert.equal(local.address, '127.0.0.1')
    assert.deepEqual(pc.sctp.transport.iceTransport.getSelectedCandidatePair(), { remote: { address: '127.0.0.1', port: local.port } })
  })

  test(`${role}: ${TRANSFER / MiB} MiB each way, SHA-256 equal`, { timeout: 300_000 }, async (t) => {
    const link = await linked(t, { offer })
    await bothWays(link, TRANSFER, 16384)
    assert.equal(link.local.droppedDatagrams, 0)
  })
}

test('three remotes at once on one socket, two of them offering: 4 MiB each way each, hashes equal', async (t) => {
  const local = await listen()
  const remotes = await Promise.all([spawnRemote(), spawnRemote(), spawnRemote()])
  t.after(async () => {
    await Promise.all(remotes.map((remote) => remote.exit()))
    await local.close()
  })
  // an offering remote sends the first packet, from an address the socket has not seen
  const links = await Promise.all(
    remotes.map(async (remote, i) => {
      const pc = new local.RTCPeerConnection()
      return { remote, pc, ...(await connect(pc, remote, { offer: i === 2, label: `remote ${i}` })) }
    }),
  )
  assert.deepEqual(
    links.map(({ channel, opened }) => [channel.label, opened.label]),
    [0, 1, 2].map((i) => [`remote ${i}`, `remote ${i}`]),
  )
  await Promise.all(links.map((link, i) => bothWays(link, 4 * MiB, 16384 + i)))
  assert.equal(local.droppedDatagrams, 0)
})

test('the remote says how large a message may be: at its limit one arrives, over it send throws', async (t) => {
  const { pc, channel, remote } = await linked(t, { remoteOptions: { maxMessageSize: 100_000 } })
  assert.equal(pc.sctp.maxMessageSize, 100_000)
  remote.send({ t: 'expect', bytes: 100_000 })
  const largest = new Uint8Array(100_000).fill(7)
  channel.send(largest)
  const received = await remote.next('received')
  assert.equal(received.messages, 1)
  assert.equal(received.sha256, createHash('sha256').update(largest).digest('hex'))
  assert.throws(() => channel.send(new Uint8Array(100_001)), TypeError)
})

test('the queue refuses at 16 MiB, and all of it reaches the remote', async (t) => {
  const { channel, remote } = await linked(t)
  await settled(channel)
  const sent = fill(channel)
  assert.equal(sent.error.name, 'OperationError')
  assert.equal(sent.taken, 256)
  remote.send({ t: 'expect', bytes: 16 * MiB })
  let low = 0
  channel.onbufferedamountlow = () => low++
  assert.equal((await remote.next('received', 60_000)).sha256, sent.sha256)
  await settled(channel)
  await Promise.resolve()
  assert.equal(low, 1, 'bufferedamountlow fired once the queue was empty')
})

test('closing our connection closes the channel on the remote, at once', async (t) => {
  const { pc, channel, remote } = await linked(t)
  const closed = once(channel, 'close')
  pc.close()
  await remote.next('closed', 3000)
  await closed
  assert.equal(pc.connectionState, 'closed')
})

test('the remote closing its connection closes our channel and fails our connection, at once', async (t) => {
  const { pc, channel, remote } = await linked(t)
  const events = []
  channel.onerror = () => events.push('error')
  channel.onclose = () => events.push('close')
  pc.onconnectionstatechange = () => events.push(pc.connectionState)
  remote.send({ t: 'close-connection' })
  // from the remote's own packets, long before our ICE agent would give up on it (22 s)
  await once(pc, 'connectionstatechange', 3000)
  assert.deepEqual(events, ['close', 'failed'])
  assert.equal(channel.readyState, 'closed')
  assert.throws(() => channel.send('late'), { name: 'InvalidStateError' })
  assert.throws(() => pc.createDataChannel('late'), { name: 'InvalidStateError' })
})

test('the remote reports bytes that reached it before it was asked to count them', async (t) => {
  // the rig's own race: a small message can be at the remote before the request to count it is
  const { channel, remote } = await linked(t)
  channel.send(new Uint8Array([1, 2, 3, 4]))
  await settled(channel, 3000)
  await new Promise((resolve) => setTimeout(resolve, 100))
  remote.send({ t: 'expect', bytes: 4 })
  assert.equal((await remote.next('received', 3000)).bytes, 4)
})

test('the remote closing only its channel closes ours and leaves the connection up', async (t) => {
  const { pc, channel, remote } = await linked(t, { offer: false })
  const states = []
  pc.onconnectionstatechange = () => states.push(pc.connectionState)
  remote.send({ t: 'close-channel' })
  await once(channel, 'close', 3000)
  assert.equal(channel.readyState, 'closed')
  await remote.next('closed', 3000)

  const again = pc.createDataChannel('again')
  await once(again, 'open', 3000)
  assert.equal((await remote.next('open')).label, 'again')
  remote.send({ t: 'expect', bytes: 4 })
  again.send(new Uint8Array([1, 2, 3, 4]))
  assert.equal((await remote.next('received')).bytes, 4)
  assert.equal(pc.connectionState, 'connected')
  assert.deepEqual(states, [])
})
