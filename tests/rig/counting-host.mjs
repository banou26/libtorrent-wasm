// node's sockets with every connect and datagram recorded, for a test that has to know what a
// session asked of its host. Nothing leaves this machine through it: a destination outside
// 127.0.0.0/8 is refused (tcp) or dropped (udp), unless `routes` names a loopback address that
// stands in for it, and no name is looked up.

import { offlineHost } from '../../build/index.js'
import { createNodeHost } from './node-host.mjs'

const isLoopback = (address) => address.startsWith('127.')

/** Whether a dotted address is in 100.64.0.0/10, where Session.addPeerStream takes its addresses from. */
export const inStreamRange = (address) => {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && (b & 0xc0) === 0x40
}

/**
 * @param {{ routes?: Record<string, string>, acceptedFrom?: string }} [opts]
 *   routes maps an address to the loopback address a tcp connect to it really goes to, so a peer
 *   on this machine can stand at an address libtorrent takes for a public one. acceptedFrom is
 *   the address every accepted tcp connection reads as coming from, for a peer that dials in.
 */
export const countingHost = ({ routes = {}, acceptedFrom } = {}) => {
  const real = createNodeHost()
  const offline = offlineHost()
  /** Every tcp connect asked of the host, as { address, port }. */
  const connects = []
  /** Every datagram asked of the host, as { address, port }. */
  const datagrams = []
  return {
    connects,
    datagrams,
    dnsLookup: offline.dnsLookup,
    net: {
      connect: (options, ...rest) => {
        connects.push({ address: options.host, port: options.port })
        const host = routes[options.host] ?? options.host
        return isLoopback(host) ? real.net.connect({ ...options, host }, ...rest) : offline.net.connect()
      },
      createServer: (...args) => {
        const server = real.net.createServer(...args)
        // before the shim's own listener, which reads the address
        if (acceptedFrom) server.on('connection', (socket) => Object.defineProperty(socket, 'remoteAddress', { value: acceptedFrom }))
        return server
      },
    },
    dgram: {
      createSocket: (...args) => {
        const socket = real.dgram.createSocket(...args)
        const send = socket.send.bind(socket)
        socket.send = (buf, offset, length, port, address, ...rest) => {
          // node holds a send made before the bind has landed and makes it again through this
          // same property, as (list, port, address, callback): already counted, so it goes through
          if (Array.isArray(buf)) return send(buf, offset, length, port)
          datagrams.push({ address, port })
          if (isLoopback(address)) send(buf, offset, length, port, address, ...rest)
        }
        return socket
      },
    },
  }
}
