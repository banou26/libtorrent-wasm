// A libdatachannel peer in a child process (libdatachannel-peer.mjs), driven by messages.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const peer = fileURLToPath(new URL('./libdatachannel-peer.mjs', import.meta.url))

/** `options` go to node-datachannel's PeerConnection, for instance { maxMessageSize }. */
export async function spawnRemote(options = {}) {
  const child = fork(peer, [JSON.stringify(options)])
  const inbox = []
  const waiters = []
  let asked = false
  let dead
  child.on('message', (message) => {
    const waiting = waiters.findIndex((waiter) => waiter.t === message.t)
    if (waiting >= 0) waiters.splice(waiting, 1)[0].settle(message)
    else inbox.push(message)
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  // libdatachannel throws now and then, and what it throws ends the child with its error on
  // standard error. Whoever waits on the remote hears of it at once instead of waiting out a deadline.
  const died = new Promise((_, reject) => {
    child.on('exit', (code, signal) => {
      if (asked) return
      dead = new Error(`the remote exited by itself (${signal ?? `code ${code}`}): its own error is in the output above`)
      for (const waiter of waiters.splice(0)) waiter.settle(undefined, dead)
      reject(dead)
    })
  })
  died.catch(() => {})
  const remote = {
    send: (message) => child.send(message),
    /** The next message of type `t`, already received or not. Rejects after `ms`, or at once when the remote has died. */
    next(t, ms = 30_000) {
      const had = inbox.findIndex((message) => message.t === t)
      if (had >= 0) return Promise.resolve(inbox.splice(had, 1)[0])
      if (dead) return Promise.reject(dead)
      return new Promise((resolve, reject) => {
        const waiter = {
          t,
          settle(message, error) {
            clearTimeout(timer)
            if (error) reject(error)
            else resolve(message)
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
    /** Never resolves. Rejects when the remote exits without having been asked to. */
    died,
    async exit() {
      if (child.exitCode !== null || child.signalCode) return
      asked = true
      child.send({ t: 'exit' })
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    },
  }
  await remote.next('ready')
  return remote
}
