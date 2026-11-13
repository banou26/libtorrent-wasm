// dgram-shaped sockets joined in memory, for runs with no network and no native module.
// A datagram arrives in a later microtask and never inside send(), which is how a real socket
// delivers; with `inside` it arrives inside send(), which a socket joined in memory may also do.
// Plain JavaScript with no import, so a browser worker loads the same file.

export function network({ inside = false } = {}) {
  const sockets = new Map()
  return {
    /** A socket at `address:port`. Its `sent` lists every datagram handed to send(), delivered or not. */
    socket(address, port) {
      const listeners = { message: new Set(), error: new Set(), close: new Set() }
      const socket = {
        address,
        port,
        sent: [],
        on(event, listener) {
          listeners[event].add(listener)
          return socket
        },
        off(event, listener) {
          listeners[event].delete(listener)
          return socket
        },
        emit(event, ...args) {
          for (const listener of listeners[event]) listener(...args)
        },
        listenerCount: (event) => listeners[event].size,
        send(data, toPort, toAddress, callback) {
          socket.sent.push({ address: toAddress, port: toPort, length: data.length })
          const to = sockets.get(`${toAddress}:${toPort}`)
          const deliver = () => to?.emit('message', data, { address, port })
          if (inside) deliver()
          else queueMicrotask(deliver)
          callback?.(null)
        },
      }
      sockets.set(`${address}:${port}`, socket)
      return socket
    },
  }
}

/** Two joined sockets on documentation addresses: a factory on one needs `allowPrivateCandidates`. */
export function socketPair(options) {
  const { socket } = network(options)
  return [socket('203.0.113.1', 40001), socket('198.51.100.2', 40002)]
}
