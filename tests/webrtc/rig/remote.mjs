// A libdatachannel peer in a child process (libdatachannel-peer.mjs), driven by messages.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const peer = fileURLToPath(new URL('./libdatachannel-peer.mjs', import.meta.url))

/** `options` go to node-datachannel's PeerConnection, for instance { maxMessageSize }. */
export async function spawnRemote(options = {}) {
  const child = fork(peer, [JSON.stringify(options)])
  const inbox = []
  const waiters = []
  child.on('message', (message) => {
    const waiting = waiters.findIndex((waiter) => waiter.t === message.t)
    if (waiting >= 0) waiters.splice(waiting, 1)[0].resolve(message)
    else inbox.push(message)
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  const remote = {
    send: (message) => child.send(message),
    /** The next message of type `t`, already received or not. Rejects after `ms`. */
    next(t, ms = 30_000) {
      const had = inbox.findIndex((message) => message.t === t)
      if (had >= 0) return Promise.resolve(inbox.splice(had, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = {
          t,
          resolve(message) {
            clearTimeout(timer)
            resolve(message)
          },
        }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          reject(new Error(`the remote sent no '${t}' in ${ms} ms`))
        }, ms)
        waiters.push(waiter)
      })
    },
    /** True when a message of type `t` has arrived and not been taken. */
    has: (t) => inbox.some((message) => message.t === t),
    async exit() {
      if (child.exitCode !== null || child.signalCode) return
      child.send({ t: 'exit' })
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    },
  }
  await remote.next('ready')
  return remote
}
