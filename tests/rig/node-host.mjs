// node's net/dgram as the WASM socket shim's host, with every socket error counted.
//
// The shim in src/library_fkn.js was written against @fkn/lib, whose modules are
// node-API-shaped by design, so the call surface already matches: net.connect,
// net.createServer, dgram.createSocket, and the connect/data/end/close/error and
// message/listening events. Nothing needs wrapping.

import net from 'node:net'
import dgram from 'node:dgram'

/**
 * @param {{ onError?: (kind: string, err: Error) => void }} [opts]
 *   onError observes every socket error for diagnostics. It does not suppress
 *   anything; the shim still sees the event.
 */
export const createNodeHost = (opts = {}) => {
  const seen = { tcpErrors: 0, udpErrors: 0, serverErrors: 0 }
  const watch = (kind, emitter, counter) => {
    emitter.on('error', (err) => {
      seen[counter]++
      opts.onError?.(kind, err)
    })
    return emitter
  }

  return {
    stats: seen,
    net: {
      connect: (options, ...rest) => watch('tcp', net.connect(options, ...rest), 'tcpErrors'),
      createServer: (...args) => watch('server', net.createServer(...args), 'serverErrors'),
    },
    dgram: {
      createSocket: (options, ...rest) => watch('udp', dgram.createSocket(options, ...rest), 'udpErrors'),
    },
  }
}
