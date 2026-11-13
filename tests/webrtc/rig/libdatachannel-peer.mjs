// The remote end of a test: libdatachannel (through node-datachannel) in a process of its own,
// bound to loopback, told what to do over the IPC channel. tests/webrtc/rig/remote.mjs forks it.
//
// Its own process because libdatachannel runs threads and hashes on the main one: in the test's
// process it would share the event loop with the module under test and skew every rate.
import crypto from 'node:crypto'
import ndc from 'node-datachannel'

const options = JSON.parse(process.argv[2] ?? '{}')
const send = (message) => process.send(message)
const pc = new ndc.PeerConnection('remote', { iceServers: [], bindAddress: '127.0.0.1', ...options })
const receiving = { bytes: 0, messages: 0, hash: crypto.createHash('sha256'), expect: 0 }
let channel

pc.onStateChange((state) => send({ t: 'state', state }))
pc.onGatheringStateChange((state) => {
  if (state !== 'complete') return
  const { type, sdp } = pc.localDescription()
  send({ t: 'description', type, sdp })
})

function wire(opened) {
  channel = opened
  channel.onOpen(() =>
    send({ t: 'open', label: channel.getLabel(), maxMessageSize: channel.maxMessageSize(), library: ndc.getLibraryVersion() }),
  )
  channel.onClosed(() => send({ t: 'closed' }))
  channel.onMessage((message) => {
    if (typeof message === 'string') return send({ t: 'text', text: message })
    receiving.bytes += message.length
    receiving.messages++
    receiving.hash.update(message)
    if (!receiving.expect || receiving.bytes < receiving.expect) return
    send({ t: 'received', bytes: receiving.bytes, messages: receiving.messages, sha256: receiving.hash.digest('hex') })
    Object.assign(receiving, { bytes: 0, messages: 0, hash: crypto.createHash('sha256'), expect: 0 })
  })
}
pc.onDataChannel(wire)

// `bytes` in messages of `size`, each starting with its number, paced on libdatachannel's own queue.
function transfer({ bytes, size }) {
  const message = Buffer.alloc(size)
  const hash = crypto.createHash('sha256')
  let sent = 0
  let count = 0
  channel.setBufferedAmountLowThreshold(512 * 1024)
  const more = () => {
    while (sent < bytes && channel.bufferedAmount() < 2 * 1024 * 1024) {
      const part = message.subarray(0, Math.min(size, bytes - sent))
      if (part.length >= 4) part.writeUInt32LE(count, 0)
      count++
      hash.update(part)
      channel.sendMessageBinary(part)
      sent += part.length
    }
    if (sent < bytes) return
    channel.onBufferedAmountLow(() => {})
    send({ t: 'sent', bytes: sent, messages: count, sha256: hash.digest('hex') })
  }
  channel.onBufferedAmountLow(more)
  more()
}

process.on('message', (message) => {
  if (message.t === 'offer') wire(pc.createDataChannel(message.label))
  else if (message.t === 'remote') pc.setRemoteDescription(message.sdp, message.type)
  else if (message.t === 'expect') receiving.expect = message.bytes
  else if (message.t === 'send') transfer(message)
  else if (message.t === 'say') channel.sendMessage(message.text)
  else if (message.t === 'pair') send({ t: 'pair', ...pc.getSelectedCandidatePair() })
  else if (message.t === 'close-channel') channel.close()
  else if (message.t === 'close-connection') pc.close()
  else if (message.t === 'exit') {
    try {
      pc.close()
    } catch {}
    // libdatachannel finishes closing on its own threads
    setTimeout(() => {
      ndc.cleanup()
      process.exit(0)
    }, 100)
  }
})
send({ t: 'ready' })
