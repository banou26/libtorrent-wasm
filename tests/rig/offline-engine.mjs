// The real engine in a worker thread on offlineHost(), with a magnet that names trackers and a
// peer. Reports to the parent every 50 ms what the engine asked of the host and what left the
// thread, so a tick that never returns shows up as the reports stopping.
//
// workerData: { magnet }

import { parentPort, workerData } from 'node:worker_threads'

import { createSession, offlineHost } from '../../build/index.js'

const t0 = performance.now()

// the engine's own lookup, used when a session is given no dnsLookup
let fetches = 0
globalThis.fetch = async () => { fetches++; throw new Error('offline') }

const host = offlineHost()
const lookups = []
const connects = []
let datagrams = 0
const dnsLookup = (name, ...rest) => { lookups.push(name); return host.dnsLookup(name, ...rest) }
const net = {
  ...host.net,
  connect: (options) => {
    const socket = host.net.connect(options)
    const asked = { address: options.host, at: performance.now(), closedAfterMs: null }
    connects.push(asked)
    const destroy = socket.destroy.bind(socket)
    // libtorrent closes the fd as soon as it reads the refusal
    socket.destroy = () => { asked.closedAfterMs ??= performance.now() - asked.at; destroy() }
    return socket
  },
}
const dgram = {
  createSocket: (...args) => {
    const socket = host.dgram.createSocket(...args)
    const send = socket.send.bind(socket)
    socket.send = (...sent) => { datagrams++; return send(...sent) }
    return socket
  },
}

const session = await createSession({ net, dgram, dnsLookup, enableDht: false, reserveListenPort: false })
const mod = session.mod
let maxTickMs = 0
const tick = mod._lt_session_tick
mod._lt_session_tick = () => {
  const at = performance.now()
  try { return tick() } finally { maxTickMs = Math.max(maxTickMs, performance.now() - at) }
}

const handle = session.addMagnet(workerData.magnet, '/dl')
let statusUpdates = 0
let lastStatus = null
setInterval(() => {
  session.popAlerts()
  const status = session.status(handle)
  if (status && status !== lastStatus) statusUpdates++
  lastStatus = status
  session.postStatus(handle)
}, 250)

setInterval(() => {
  parentPort.postMessage({
    at: performance.now() - t0,
    maxTickMs,
    statusUpdates,
    fetches,
    lookups,
    connects,
    datagrams,
    // anything of the thread's that could carry a byte off it
    sockets: process.getActiveResourcesInfo().filter((name) => /TCP|UDP|GetAddrInfo/.test(name)),
  })
}, 50)
