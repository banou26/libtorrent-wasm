// Measures the module on loopback against libdatachannel, or against Chrome's own
// RTCPeerConnection with --chrome: MiB/s each way, with SHA-256 compared.
//   node tests/webrtc/rig/bench.mjs [--chrome] [--answer] [--mib 64] [--size 16384]
//                                   [--send-buffer 262144] [--delay 25] [--wasm path]
// --delay holds every datagram that many milliseconds in each direction on our side, in a
// JavaScript timer, so --delay 25 stands in for a 50 ms round trip. It is an indication, not a
// network: nothing is lost or reordered.
import { readFileSync } from 'node:fs'
import { chromeRemote, findChrome, launchChrome } from './chrome.mjs'
import { connect, listen, MiB, receive, send } from './local.mjs'
import { spawnRemote } from './remote.mjs'

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : process.argv[at + 1]
}
const bytes = Number(flag('mib', 64)) * MiB
const size = Number(flag('size', 16384))
const sendBufferSize = Number(flag('send-buffer', 262144))
const delay = Number(flag('delay', 0))
const path = flag('wasm')
const offer = !process.argv.includes('--answer')

const local = await listen({ sendBufferSize, ...(path && { wasm: readFileSync(path) }) })
if (delay) {
  // listen() has given the socket to the factory already: wrap what the factory sees of it
  const { socket } = local
  const emit = socket.emit.bind(socket)
  const sendNow = socket.send.bind(socket)
  socket.emit = (event, ...args) => (event === 'message' ? (setTimeout(() => emit(event, ...args), delay), true) : emit(event, ...args))
  socket.send = (...args) => void setTimeout(() => sendNow(...args), delay)
}
const pc = new local.RTCPeerConnection()

/** Either remote as { name, channel, expect(bytes) -> () => sha256, transfer(bytes, size) -> sha256, close() }. */
async function libdatachannel() {
  const remote = await spawnRemote()
  const { channel, opened } = await connect(pc, remote, { offer })
  return {
    name: `libdatachannel ${opened.library}`,
    channel,
    async expect(bytes) {
      remote.send({ t: 'expect', bytes })
      return async () => (await remote.next('received', 600_000)).sha256
    },
    async transfer(bytes, size) {
      remote.send({ t: 'send', bytes, size })
      return (await remote.next('sent', 600_000)).sha256
    },
    close: () => remote.exit(),
  }
}

async function chrome() {
  const launched = await launchChrome(findChrome())
  const remote = await chromeRemote(await launched.page())
  const channel = await remote.connect(pc, { offer })
  return { name: `Chrome ${launched.browser.version()}`, channel, expect: remote.expect, transfer: remote.transfer, close: launched.close }
}

const remote = await (process.argv.includes('--chrome') ? chrome() : libdatachannel())

const rate = async (work) => {
  const cpu = process.cpuUsage()
  const start = performance.now()
  const equal = await work()
  const seconds = (performance.now() - start) / 1000
  const used = process.cpuUsage(cpu)
  return {
    mibPerSecond: Number((bytes / MiB / seconds).toFixed(1)),
    cpuPercent: Math.round(((used.user + used.system) / 1e6 / seconds) * 100),
    equal,
  }
}

const up = await rate(async () => {
  const arrived = await remote.expect(bytes)
  // the watermark sits above the send buffer, so the buffer is what limits the data in flight
  return (await send(remote.channel, bytes, size, sendBufferSize + 4 * MiB)) === (await arrived())
})
const down = await rate(async () => {
  const incoming = receive(remote.channel, bytes)
  const theirs = await remote.transfer(bytes, size)
  return (await incoming).sha256 === theirs
})
console.log(JSON.stringify({ remote: remote.name, offer, mib: bytes / MiB, size, sendBufferSize, roundTripMs: delay * 2, up, down }))

pc.close()
await remote.close()
await local.close()
process.exit(up.equal && down.equal ? 0 : 1)
