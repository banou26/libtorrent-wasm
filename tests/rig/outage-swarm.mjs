// One engine of tests/relay-return.test.mjs in a worker thread, the seed or the leech.
//
// The seed is this engine on node's own sockets, seeding `dir/seed/<name>` with uploads capped. The
// leech is this engine behind a relay that can be taken away (relay-host.mjs): once `dropAt` bytes
// are in, the relay goes away for `outageMs` and comes back. Both report to the parent every 250 ms,
// the leech with the uTP resets it sent after the relay was back.
//
// workerData: { role: 'seed', dir, torrent, uploadBps } | { role: 'leech', dir, magnet, dropAt, outageMs }

import { parentPort, workerData } from 'node:worker_threads'

import { createSession } from '../../build/index.js'
import { createNodeHost } from './node-host.mjs'
import { NodeFSStorage } from './node-storage.mjs'
import { createRelayHost } from './relay-host.mjs'

const { role, dir } = workerData
const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)
const relay = role === 'leech' ? createRelayHost() : null
const host = relay ?? createNodeHost()

const session = await createSession({
  net: host.net,
  dgram: host.dgram,
  storage: new NodeFSStorage(dir),
  enableDht: false,
  ...(role === 'seed' ? { rateLimits: { upload: workerData.uploadBps } } : {}),
})
const handle = role === 'seed'
  ? session.addTorrentFile(workerData.torrent, '/seed')
  : session.addMagnet(workerData.magnet, '/leech')

let dropAt = null
let restoreAt = null
// uTP headers (BEP 29): type in the high nibble of byte 0, connection id at 2, ack_nr at 18. The last
// one sent to each peer before the drop, and every reset sent after the relay is back.
const lastBefore = {}
const resets = []
if (relay) {
  relay.onSend = (bytes, address, port) => {
    if (bytes.length < 20 || (bytes[0] & 0x0f) !== 1) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, 20)
    const header = { to: `${address}:${port}`, type: bytes[0] >> 4, id: view.getUint16(2), ack: view.getUint16(18) }
    if (dropAt == null) lastBefore[header.to] = header
    else if (restoreAt != null && header.type === 3) resets.push(header)
  }
}
setInterval(() => {
  session.popAlerts()
  session.postStatus(handle)
  const st = session.status(handle)
  const r = session.reachable()
  if (role === 'leech' && dropAt == null && st && st.totalDone >= workerData.dropAt) {
    dropAt = now()
    relay.drop()
    setTimeout(async () => { await relay.restore(); restoreAt = now() }, workerData.outageMs)
  }
  parentPort.postMessage({
    at: now(), dropAt, restoreAt,
    done: st?.totalDone ?? 0, seeding: st?.state === 5,
    port: r.port, portOpen: r.portOpen, listeners: r.listeners,
    lastBefore, resets,
  })
}, 250)
