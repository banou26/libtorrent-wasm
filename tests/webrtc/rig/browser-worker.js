// Runs in a dedicated worker of the page tests/webrtc/browser.test.mjs serves: two factories
// joined by in-memory sockets, so the whole stack runs on this one thread with no socket at all.
// The module finds its wasm by itself here, beside the file it was imported from.
import { createWebRTC } from '/build/webrtc.js'
import { socketPair } from '/rig/memory-network.mjs'

const MiB = 1024 * 1024
const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }))

async function gathered(pc) {
  while (pc.iceGatheringState !== 'complete') await once(pc, 'icegatheringstatechange')
  return pc.localDescription
}

async function sha256(chunks) {
  const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    all.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function transfer(from, to, bytes, size) {
  const received = []
  let arrived = 0
  const done = new Promise((resolve) => {
    to.onmessage = ({ data }) => {
      received.push(data)
      arrived += data.byteLength
      if (arrived >= bytes) resolve()
    }
  })
  const sent = []
  from.bufferedAmountLowThreshold = MiB / 2
  for (let count = 0; count * size < bytes; count++) {
    if (from.bufferedAmount > MiB) await once(from, 'bufferedamountlow')
    const message = crypto.getRandomValues(new Uint8Array(size))
    from.send(message)
    sent.push(message)
  }
  await done
  return { equal: (await sha256(sent)) === (await sha256(received)), messages: received.length, bytes: arrived }
}

onmessage = async ({ data: { bytes, size } }) => {
  try {
    const [A, B] = await Promise.all(
      socketPair().map((socket) => createWebRTC({ socket, address: socket.address, port: socket.port, allowPrivateCandidates: true })),
    )
    const a = new A.RTCPeerConnection()
    const b = new B.RTCPeerConnection()
    const ours = a.createDataChannel('worker')
    const announced = once(b, 'datachannel')
    await a.setLocalDescription()
    await b.setRemoteDescription(await gathered(a))
    await b.setLocalDescription()
    await a.setRemoteDescription(await gathered(b))
    const [{ channel: theirs }] = await Promise.all([announced, once(ours, 'open')])
    const start = performance.now()
    const up = await transfer(ours, theirs, bytes, size)
    const down = await transfer(theirs, ours, bytes, size)
    const seconds = (performance.now() - start) / 1000
    A.close()
    B.close()
    postMessage({
      crossOriginIsolated: self.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      dedicatedWorker: self instanceof DedicatedWorkerGlobalScope,
      platformPeerConnection: typeof RTCPeerConnection,
      up,
      down,
      mibPerSecond: (2 * bytes) / MiB / seconds,
    })
  } catch (error) {
    postMessage({ error: String(error?.stack ?? error) })
  }
}
