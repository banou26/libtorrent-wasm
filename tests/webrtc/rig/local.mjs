// The module under test, as the tests hold it: the built entry, the built wasm, and a node
// dgram socket on loopback.
import dgram from 'node:dgram'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export { createWebRTC } from '../../../build/webrtc.js'
import { createWebRTC } from '../../../build/webrtc.js'

export const wasm = new WebAssembly.Module(readFileSync(new URL('../../../build/webrtc.wasm', import.meta.url)))

export const MiB = 1024 * 1024

/** A factory on a loopback UDP socket of its own. `close` stops both. */
export async function listen(options = {}) {
  // 4 MiB so a burst on loopback is not dropped at the kernel before node reads it
  const socket = dgram.createSocket({ type: 'udp4', recvBufferSize: 4 * MiB, sendBufferSize: 4 * MiB })
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  const webrtc = await createWebRTC({ socket, address: '127.0.0.1', port, wasm, allowPrivateCandidates: true, ...options })
  return {
    ...webrtc,
    socket,
    port,
    get droppedDatagrams() {
      return webrtc.droppedDatagrams
    },
    async close() {
      webrtc.close()
      await new Promise((resolve) => socket.close(resolve))
    },
  }
}

/** The next `type` event of `target`, with no deadline: `within` gives the wait one. */
export const heard = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }))

/** `promise`, or a rejection with `message` once `ms` have passed since this call. */
export function within(promise, ms, message) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

export const once = (target, type, ms = 30_000) => within(heard(target, type), ms, `no '${type}' event in ${ms} ms`)

/** The description once gathering is complete, which is what non-trickle signalling sends. */
export async function gathered(pc) {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise((resolve) => {
      const check = () => {
        if (pc.iceGatheringState !== 'complete') return
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
      pc.addEventListener('icegatheringstatechange', check)
    })
  }
  return { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
}

/**
 * Connects `pc` and a libdatachannel remote, with either side offering, and returns our open
 * channel. The channel is listened for from the start and timed from the moment it can come, so
 * a connect that stalls says at which stage.
 */
export async function connect(pc, remote, { offer, label = 'test' }) {
  let channel
  if (offer) {
    channel = pc.createDataChannel(label)
    const opened = heard(channel, 'open')
    await pc.setLocalDescription()
    remote.send({ t: 'remote', ...(await gathered(pc)) })
    await pc.setRemoteDescription(await remote.next('description'))
    await within(opened, 30_000, 'both descriptions are set and our channel did not open in 30 s')
  } else {
    const announced = heard(pc, 'datachannel')
    remote.send({ t: 'offer', label })
    await pc.setRemoteDescription(await remote.next('description'))
    await pc.setLocalDescription()
    remote.send({ t: 'remote', ...(await gathered(pc)) })
    channel = (await within(announced, 30_000, 'the remote was sent our answer and announced no channel in 30 s')).channel
  }
  const opened = await remote.next('open')
  return { channel, opened }
}

/** Connects two of the module's own connections, `a` offering, and returns both ends of the channel. */
export async function pair(a, b, label = 'test') {
  const channel = a.createDataChannel(label)
  const announced = once(b, 'datachannel')
  await a.setLocalDescription()
  await b.setRemoteDescription(await gathered(a))
  await b.setLocalDescription()
  await a.setRemoteDescription(await gathered(b))
  const [{ channel: remote }] = await Promise.all([announced, channel.readyState === 'open' || once(channel, 'open')])
  return [channel, remote]
}

/**
 * Sends `bytes` in messages of `size` on `channel`, waiting on bufferedamountlow whenever more
 * than `high` is queued, and answers the SHA-256 of what it sent.
 */
export async function send(channel, bytes, size, high = MiB) {
  const message = new Uint8Array(size)
  const view = new DataView(message.buffer)
  const hash = createHash('sha256')
  channel.bufferedAmountLowThreshold = high / 2
  let sent = 0
  for (let count = 0; sent < bytes; count++) {
    if (channel.bufferedAmount > high) await once(channel, 'bufferedamountlow', 120_000)
    const part = message.subarray(0, Math.min(size, bytes - sent))
    if (part.length >= 4) view.setUint32(0, count, true)
    hash.update(part)
    channel.send(part)
    sent += part.length
  }
  return hash.digest('hex')
}

/** Resolves once nothing sent on `channel` is still unacknowledged. Rejects after `ms`. */
export async function settled(channel, ms = 30_000) {
  const deadline = performance.now() + ms
  while (channel.bufferedAmount) {
    if (performance.now() > deadline) throw new Error(`bufferedAmount is still ${channel.bufferedAmount} after ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Sends 64 KiB messages on `channel` until send() throws, and answers how many it took, their
 * SHA-256 and the error.
 *
 * The loop is counted: 256 messages fill the 16 MiB queue, and it gives up at 260. Sending until
 * it throws never ends once the limit is gone, and a loop that never yields is one no test
 * timeout can stop: it goes on until the machine has no memory left.
 */
export function fill(channel) {
  const message = new Uint8Array(65536)
  const hash = createHash('sha256')
  for (let taken = 0; taken < 260; taken++) {
    message.fill(taken & 255)
    try {
      channel.send(message)
    } catch (error) {
      return { taken, error, sha256: hash.digest('hex') }
    }
    hash.update(message)
  }
  throw new Error('send() took 260 messages of 64 KiB and never refused: the queue has no limit')
}

/** Resolves with the SHA-256 of the next `bytes` bytes of binary messages on `channel`. */
export function receive(channel, bytes) {
  const hash = createHash('sha256')
  let received = 0
  let messages = 0
  return new Promise((resolve) => {
    const onMessage = ({ data }) => {
      if (typeof data === 'string') return
      hash.update(new Uint8Array(data))
      received += data.byteLength
      messages++
      if (received < bytes) return
      channel.removeEventListener('message', onMessage)
      resolve({ sha256: hash.digest('hex'), bytes: received, messages })
    }
    channel.addEventListener('message', onMessage)
  })
}
