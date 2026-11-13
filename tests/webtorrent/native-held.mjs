// A process that node-datachannel keeps alive for good, run by links.test.mjs. `node native-held.mjs release`
// calls what the test files call when they are done, and ends with code 0. `node native-held.mjs hold` does
// not, is still there 3 s later, and ends itself with code 3.
//
// It gets there the one way that happens every time: the offering end closes its channel while this thread
// is kept busy, so the answering end's channel is already closed, natively, when the thread hears of it, and
// the closed callback that would free the event loop never comes. Loopback only, no ICE server.

import { PeerConnection } from 'node-datachannel'

import { releaseNativeRtc } from './fakes.mjs'

/** Keeps the thread busy until `done()` or for `ms`, whichever is first, and says whether it was done. */
const spin = (done, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) if (done()) return true
  return false
}

/** The connection's own description once it has every candidate, or a failure 10 s later. */
const described = pc => new Promise((resolve, reject) => {
  const late = setTimeout(() => reject(new Error('gathering never completed')), 10_000)
  pc.onGatheringStateChange(state => {
    if (state !== 'complete') return
    clearTimeout(late)
    resolve(pc.localDescription().sdp)
  })
})

const [a, b] = [new PeerConnection('a', { iceServers: [] }), new PeerConnection('b', { iceServers: [] })]
// As the polyfill does for every connection and channel: without these two callbacks nothing is ever let go.
a.onStateChange(() => {})
b.onStateChange(() => {})
let theirs = null
b.onDataChannel(channel => {
  theirs = channel
  channel.onClosed(() => {})
})
const offer = described(a)
const ours = a.createDataChannel('held')
ours.onClosed(() => {})
const answer = described(b)
b.setRemoteDescription(await offer, 'offer')
a.setRemoteDescription(await answer, 'answer')
// Not one task from here to the close: the answering end cannot be told of its channel before it is closed.
if (!spin(() => ours.isOpen(), 10_000)) throw new Error('the channel never opened')
ours.close()
spin(() => false, 300)
for (let tries = 0; !theirs && tries < 400; tries++) await new Promise(resolve => setTimeout(resolve, 5))
if (!theirs || theirs.isOpen()) throw new Error('the answering end was not told of a channel already closed')
theirs.close()
a.close()
b.close()
if (process.argv[2] === 'release') await releaseNativeRtc()
// It does not keep the process alive, so it only runs when something else still does.
setTimeout(() => process.exit(3), 3000).unref()
