// node's sockets on loopback, behind a relay that can be taken away and brought back.
//
// While it is away every bind, listen and connect is refused with 'error' alone, and taking it
// away ends every socket it holds with 'error' then 'close', as @fkn/lib does
// (lib/src/webvpn/dgram.ts and net.ts, _onTransportClosed). The sockets under it are closed for
// real, so a peer's datagrams to them meet a closed port, as they do when a relay restarts. A named
// bind gets that port or is refused, as the relay's are. Nothing is sent off 127.0.0.0/8.

import { EventEmitter } from 'node:events'
import dgram from 'node:dgram'
import net from 'node:net'

import { normalizeErrno } from './node-host.mjs'

const LOOPBACK = '127.0.0.1'
const REFUSED_AFTER_MS = 30
const loopback = (address) => typeof address === 'string' && address.startsWith('127.')

const refused = (emitter, what) => setTimeout(() => emitter.emit('error', new Error(`relay away, no ${what}`)), REFUSED_AFTER_MS)

/**
 * `drop()` takes the relay away, `restore({ portsTaken })` brings it back, with every port its
 * sockets held at the drop taken by somebody else when `portsTaken` is set. `close()` ends the
 * blockers. `binds` records every bind and listen asked of it, and `onSend(bytes, address, port)`,
 * when set, sees every datagram that leaves.
 */
export const createRelayHost = () => {
  let up = true
  // what drop() has to end: each entry closes its real socket and tells its front, once
  const open = new Set()
  const heldAtDrop = []
  const blockers = []
  const binds = []
  const t0 = performance.now()
  const at = () => Math.round(performance.now() - t0)

  class Udp extends EventEmitter {
    real = null
    bound = null
    bind(port = 0) {
      binds.push({ at: at(), transport: 'udp', port, up })
      if (!up) { refused(this, 'udp socket'); return this }
      const real = dgram.createSocket('udp4')
      this.real = real
      real.on('message', (msg, rinfo) => { if (this.real === real) this.emit('message', msg, rinfo) })
      real.once('listening', () => {
        this.bound = real.address()
        const entry = () => {
          open.delete(entry)
          heldAtDrop.push({ transport: 'udp', port: this.bound.port })
          if (this.real === real) this.real = null
          try { real.close() } catch {}
          this.emit('error', new Error('WebVPN session closed'))
          this.emit('close')
        }
        this.drop = entry
        open.add(entry)
        this.emit('listening')
      })
      real.on('error', (err) => {
        normalizeErrno(err)
        if (this.bound || this.real !== real) return
        this.real = null
        try { real.close() } catch {}
        this.emit('error', err)
      })
      real.bind(port, LOOPBACK)
      return this
    }
    address() {
      if (!this.bound) throw new Error('EBADF')
      return this.bound
    }
    send(buf, offset, length, port, address) {
      if (!this.real || !loopback(address)) return
      host.onSend?.(buf.subarray(offset, offset + length), address, port)
      this.real.send(buf, offset, length, port, address)
    }
    close() {
      const real = this.real
      this.real = null
      if (this.drop) open.delete(this.drop)
      if (!real) return
      try { real.close() } catch {}
      setTimeout(() => this.emit('close'), 0)
    }
  }

  class Server extends EventEmitter {
    real = null
    bound = null
    listen(port = 0) {
      binds.push({ at: at(), transport: 'tcp', port, up })
      if (!up) { refused(this, 'tcp listener'); return this }
      const real = net.createServer()
      this.real = real
      real.on('connection', (sock) => {
        if (this.real !== real) { sock.destroy(); return }
        track(sock)
        this.emit('connection', sock)
      })
      real.once('listening', () => {
        this.bound = real.address()
        const entry = () => {
          open.delete(entry)
          heldAtDrop.push({ transport: 'tcp', port: this.bound.port })
          if (this.real === real) this.real = null
          try { real.close() } catch {}
          this.emit('error', new Error('WebVPN session closed'))
          this.emit('close')
        }
        this.drop = entry
        open.add(entry)
        this.emit('listening')
      })
      real.on('error', (err) => {
        normalizeErrno(err)
        if (this.bound || this.real !== real) return
        this.real = null
        this.emit('error', err)
      })
      real.listen(port, LOOPBACK)
      return this
    }
    address() { return this.bound }
    close() {
      const real = this.real
      this.real = null
      if (this.drop) open.delete(this.drop)
      if (!real) return
      try { real.close() } catch {}
      setTimeout(() => this.emit('close'), 0)
    }
  }

  const track = (sock) => {
    sock.on('error', normalizeErrno)
    const entry = () => { open.delete(entry); sock.destroy(new Error('WebVPN session closed')) }
    open.add(entry)
    sock.once('close', () => open.delete(entry))
    return sock
  }

  const connect = ({ host, port }) => {
    if (!up || !loopback(host)) {
      const away = new EventEmitter()
      Object.assign(away, { write: () => true, destroy() {}, setNoDelay() {}, setKeepAlive() {} })
      refused(away, 'tcp socket')
      return away
    }
    return track(net.connect({ host, port }))
  }

  const host = {
    onSend: null,
    net: { connect, createServer: () => new Server() },
    dgram: { createSocket: () => new Udp() },
    binds,
    get up() { return up },
    drop() {
      up = false
      heldAtDrop.length = 0
      for (const end of [...open]) end()
    },
    async restore({ portsTaken = false } = {}) {
      if (portsTaken) {
        for (const { transport, port } of heldAtDrop) {
          const blocker = transport === 'udp' ? dgram.createSocket('udp4') : net.createServer()
          await new Promise((resolve, reject) => {
            blocker.once('error', reject)
            if (transport === 'udp') blocker.bind(port, LOOPBACK, resolve)
            else blocker.listen(port, LOOPBACK, resolve)
          })
          blockers.push(blocker)
        }
      }
      up = true
    },
    close() {
      for (const b of blockers.splice(0)) { try { b.close() } catch {} }
    },
  }
  return host
}
