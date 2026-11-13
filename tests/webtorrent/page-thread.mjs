// The page half in a thread of its own, standing in for the page that owns the engine worker. Timers are
// taken away before anything loads, so a timer in the page half is a thrown error and a recorded call.

import { parentPort } from 'node:worker_threads'

const timers = []
for (const name of ['setTimeout', 'setInterval']) {
  globalThis[name] = () => {
    timers.push(name)
    throw new Error(`${name} was called in the page half`)
  }
}

const { servePeerLinks } = await import('../../build/webtorrent/page.js')
const { fakeRtc, handlersOf } = await import('./fakes.mjs')

const Class = fakeRtc({ gathering: {} })

parentPort.on('message', message => {
  if (message.ports) for (const port of message.ports) servePeerLinks(port, { RTCPeerConnection: Class })
  if (message.report) {
    parentPort.postMessage({
      timers,
      made: Class.stats.made,
      open: Class.all.filter(pc => !pc.closed).length,
      handlers: Class.all.reduce((count, pc) => count + handlersOf(pc).length, 0),
    })
  }
})
parentPort.postMessage({ ready: true })
