// The page half in a thread of its own, standing in for the page that owns the engine worker while it is
// hidden. Its timers are taken over before anything loads: each delay asked for is recorded, and none runs
// until the test says `late`. An interval is a thrown error.

import { parentPort } from 'node:worker_threads'

const timers = []
const waiting = []
globalThis.setTimeout = (callback, ms) => {
  timers.push(ms)
  waiting.push(callback)
}
globalThis.setInterval = () => {
  timers.push('setInterval')
  throw new Error('setInterval was called in the page half')
}

const { servePeerLinks } = await import('../../build/webtorrent/page.js')
const { fakeRtc, handlersOf } = await import('./fakes.mjs')

const Class = fakeRtc({ gathering: {} })

parentPort.on('message', message => {
  if (message.ports) for (const port of message.ports) servePeerLinks(port, { RTCPeerConnection: Class })
  if (message.late) for (const callback of waiting.splice(0)) callback()
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
