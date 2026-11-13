// One engine of tests/relay-return.test.mjs in a worker thread, the seed or the leech.
//
// The seed seeds `dir/seed/<name>` with uploads capped, the leech downloads it from a magnet. Either
// runs on node's own sockets or, with `relay` set, behind a relay that can be taken away
// (relay-host.mjs), which the parent does by posting 'drop' and 'restore'. Every 250 ms each reports
// to the parent, the one behind the relay with the uTP resets it sent after the relay was back.
//
// workerData: { role: 'seed', dir, torrent, uploadBps, relay } | { role: 'leech', dir, magnet, relay }

import { parentPort, workerData } from 'node:worker_threads'

import { createSession } from '../../build/index.js'
import { createNodeHost } from './node-host.mjs'
import { NodeFSStorage } from './node-storage.mjs'
import { createRelayHost } from './relay-host.mjs'

const { role, dir } = workerData
const relay = workerData.relay ? createRelayHost() : null
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
// uTP headers (BEP 29): type in the high nibble of byte 0, connection id at 2, seq_nr at 16, ack_nr at
// 18. The last one sent to each peer before the first drop, and every reset sent after a restore.
const lastBefore = {}
const resets = []
if (relay) {
  relay.onSend = (bytes, address, port) => {
    if (bytes.length < 20 || (bytes[0] & 0x0f) !== 1) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, 20)
    const header = { to: `${address}:${port}`, type: bytes[0] >> 4, id: view.getUint16(2), seq: view.getUint16(16), ack: view.getUint16(18) }
    if (dropAt == null) lastBefore[header.to] = header
    else if (restoreAt != null && header.type === 3) resets.push(header)
  }
  parentPort.on('message', async (action) => {
    if (action === 'drop') { dropAt = Date.now(); relay.drop() }
    else { await relay.restore(); restoreAt = Date.now() }
  })
}
setInterval(() => {
  session.popAlerts()
  session.postStatus(handle)
  const st = session.status(handle)
  const r = session.reachable()
  parentPort.postMessage({
    at: Date.now(), dropAt, restoreAt,
    done: st?.totalDone ?? 0, seeding: st?.state === 5,
    port: r.port, portOpen: r.portOpen, listeners: r.listeners,
    lastBefore, resets,
  })
}, 250)
