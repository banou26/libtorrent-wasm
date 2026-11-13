// dgram-shaped sockets joined in memory, for runs with no network and no native module.
// A datagram arrives in a later microtask and never inside send(); with `inside` it arrives
// inside send(), which a socket joined in memory may also do; with `task` it arrives in a task
// of its own, which is how node's dgram delivers; with `batch` everything one task hands a
// socket leaves together and arrives in one task, which is how @fkn/lib's dgram carries a port
// message.
// Plain JavaScript with no import, so a browser worker loads the same file.

// A task is a message, never a timer: a test that stops the timers still gets its datagrams.
const { port1, port2 } = new MessageChannel()
const tasks = []
port1.onmessage = () => tasks.shift()()
// node waits for a port that listens before it exits
port1.unref?.()
function inTask(run) {
  tasks.push(run)
  port2.postMessage(0)
}

export function network({ inside = false, task = false, batch = false } = {}) {
  const sockets = new Map()
  return {
    /**
     * A socket at `address:port`. Its `sent` lists every datagram handed to send(), delivered or
     * not, and its `batches` how many left together each time, with `batch`.
     */
    socket(address, port) {
      const listeners = { message: new Set(), error: new Set(), close: new Set() }
      const leaving = []
      const socket = {
        address,
        port,
        sent: [],
        batches: [],
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
          else if (task) inTask(deliver)
          else if (!batch) queueMicrotask(deliver)
          else if (leaving.push(deliver) === 1) {
            // its send() is a promise and then a microtask, so a batch is what one task handed over
            Promise.resolve().then(() =>
              queueMicrotask(() => {
                const together = leaving.splice(0)
                socket.batches.push(together.length)
                inTask(() => together.forEach((arrive) => arrive()))
              }),
            )
          }
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
