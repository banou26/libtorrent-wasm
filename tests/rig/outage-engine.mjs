// The real engine in a worker thread, on a host whose sockets emit what @fkn/lib emits when the
// relay refuses or drops them (lib/src/webvpn/dgram.ts and net.ts): a refused bind or listen is
// 'error' alone, a dropped tunnel is 'error' then 'close'. Reports to the parent every 50 ms, so a
// worker stuck inside a tick shows up as the reports stopping. Nothing leaves the process.
//
// workerData: {
//   refuseUdpBinds?: how many udp binds are refused, the listen port reservation's included
//   dropAt?: ms after the session starts at which the udp socket and the tcp listener go away
//   dropWith?: 'error+close' (default) or 'close'
//   dialWhileDead?: an endpoint for the magnet's x.pe, the magnet added during the third wait for
//     a replacement udp socket (2 s), since libtorrent makes the dial about a second after the add
// }

import { EventEmitter } from 'node:events'
import { parentPort, workerData } from 'node:worker_threads'

import { createSession } from '../../build/index.js'

const scenario = { refuseUdpBinds: 0, dropWith: 'error+close', ...workerData }
const t0 = performance.now()
const now = () => performance.now() - t0

const udpSockets = []
const servers = []
let binds = 0
let sent = 0
let outageAt = scenario.refuseUdpBinds > 0 ? 0 : null
let healedAt = null

class FakeUdp extends EventEmitter {
  closed = false
  bound = null
  sent = []
  constructor() { super(); udpSockets.push(this) }
  bind(port) {
    if (++binds <= scenario.refuseUdpBinds) {
      setTimeout(() => this.emit('error', new Error('@fkn/lib: no broker connection, so a udp socket could not be requested')), 30)
      return this
    }
    setTimeout(() => {
      if (this.closed) return
      this.bound = { address: '0.0.0.0', port: port || 40001, family: 'IPv4' }
      if (outageAt != null && healedAt == null && now() > outageAt) healedAt = now()
      this.emit('listening')
    }, 5)
    return this
  }
  address() {
    if (!this.bound) throw new Error('Socket is not bound')
    return this.bound
  }
  send(buf, offset, length, port, address) {
    sent++
    this.sent.push({ address, port })
  }
  close() {
    if (this.closed) return
    this.closed = true
    setTimeout(() => this.emit('close'), 0)
  }
}

class FakeServer extends EventEmitter {
  closed = false
  bound = null
  constructor() { super(); servers.push(this) }
  listen(port, address) {
    setTimeout(() => {
      if (this.closed) return
      this.bound = { address: address || '0.0.0.0', port: port || 40001, family: 'IPv4' }
      this.emit('listening')
    }, 5)
    return this
  }
  address() { return this.bound }
  close() {
    if (this.closed) return
    this.closed = true
    setTimeout(() => this.emit('close'), 0)
  }
}

class FakeTcp extends EventEmitter {
  constructor() {
    super()
    setTimeout(() => this.emit('error', new Error('@fkn/lib: no broker connection, so a tcp socket could not be requested')), 30)
  }
  write() { return true }
  destroy() {}
  setNoDelay() {}
  setKeepAlive() {}
}

const host = {
  dgram: { createSocket: () => new FakeUdp() },
  net: { createServer: () => new FakeServer(), connect: () => new FakeTcp() },
}

const session = await createSession({ net: host.net, dgram: host.dgram, enableDht: false })
const mod = session.mod
// the shim publishes itself on the first socket(), which libtorrent makes on its first tick
const udpFd = () => mod.__FKN && [...mod.__FKN.fds.values()].find((st) => st.kind === 'udp')

let maxTickMs = 0
const tick = mod._lt_session_tick
mod._lt_session_tick = () => {
  const at = performance.now()
  try { return tick() } finally { maxTickMs = Math.max(maxTickMs, performance.now() - at) }
}

const hex = Array.from({ length: 20 }, (_, i) => ((i * 37 + 11) & 0xff).toString(16).padStart(2, '0')).join('')
let handle = null
const add = (peer) => {
  handle = session.addMagnet(`magnet:?xt=urn:btih:${hex}&dn=outage${peer ? `&x.pe=${peer}` : ''}`, '/dl')
}
if (scenario.dialWhileDead) {
  const waiting = setInterval(() => {
    if (!(mod.__FKN?.stats.udpReopen >= 3 && udpFd()?.dead)) return
    clearInterval(waiting)
    add(scenario.dialWhileDead)
  }, 5)
} else {
  add()
}

// every post_status comes back as a state update alert, decoded into a fresh status object
let statusUpdatesAfterOutage = 0
let lastStatus = null
setInterval(() => {
  if (handle == null) return
  session.popAlerts()
  const status = session.status(handle)
  if (status && status !== lastStatus && outageAt != null && now() > outageAt + 1000) statusUpdatesAfterOutage++
  lastStatus = status
  session.postStatus(handle)
}, 250)

const live = () => udpSockets.filter((s) => s.bound && !s.closed).at(-1)

// A uTP SYN from a stranger: libtorrent acks it from whichever socket it reads it on, so an answer
// on the live socket proves the read is armed and the send reaches the socket that is there now.
const probes = []
const probe = (port) => {
  const sock = live()
  if (!sock) { probes.push({ port, at: now(), socket: -1 }); return }
  const syn = new Uint8Array(20)
  const view = new DataView(syn.buffer)
  syn[0] = 0x41
  view.setUint16(2, port, false)
  view.setUint32(4, Math.floor(now() * 1000) >>> 0, false)
  view.setUint32(12, 1 << 20, false)
  view.setUint16(16, 1, false)
  probes.push({ port, at: now(), socket: udpSockets.indexOf(sock) })
  sock.emit('message', syn, { address: '192.0.2.20', port, family: 'IPv4', size: syn.length })
}
const answered = (p) => p.socket >= 0
  && udpSockets[p.socket].sent.some((s) => s.address === '192.0.2.20' && s.port === p.port)

if (scenario.dropAt != null) {
  setTimeout(() => probe(7000), scenario.dropAt - 500)
  setTimeout(() => {
    outageAt = now()
    const events = scenario.dropWith === 'close' ? ['close'] : ['error', 'close']
    for (const target of [live(), servers.filter((s) => s.bound && !s.closed).at(-1)]) {
      if (!target) continue
      target.closed = true
      for (const name of events) target.emit(name, ...(name === 'error' ? [new Error('WebVPN session closed')] : []))
    }
  }, scenario.dropAt)
}
const probeOnceHealed = setInterval(() => {
  if (healedAt == null || now() < healedAt + 300) return
  clearInterval(probeOnceHealed)
  probe(7001)
}, 50)

setInterval(() => {
  const FKN = mod.__FKN
  if (!FKN) return
  parentPort.postMessage({
    maxTickMs,
    sendto: FKN.stats.sendto,
    unsent: FKN.stats.sendto - sent,
    udpReopen: FKN.stats.udpReopen ?? 0,
    acceptEmpty: FKN.stats.acceptEmpty,
    udpSockets: udpSockets.length,
    udpDead: !!udpFd()?.dead,
    healedAt,
    // the dropped server is marked closed above, so any server listening now is its replacement
    listening: servers.some((s) => s.bound && !s.closed),
    dialed: !!live()?.sent.some((d) => `${d.address}:${d.port}` === scenario.dialWhileDead),
    statusUpdatesAfterOutage,
    probes: probes.map((p) => ({ ...p, answered: answered(p) })),
  })
}, 50)
