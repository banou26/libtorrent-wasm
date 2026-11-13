// The module and a real browser, with the system Chrome, headless and muted:
//  - the module inside a dedicated worker of a page that is not cross-origin isolated, two
//    factories back to back over in-memory sockets;
//  - the module in node, over node's dgram on loopback, against Chrome's own RTCPeerConnection
//    in both roles;
//  - the names of the errors it stands in for, asked of Chrome itself.
//
// Chrome is CHROME_BIN, or the first of google-chrome-stable, google-chrome and chromium on the
// PATH. With none of them the tests are skipped and say so; a CHROME_BIN that does not launch
// fails them.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { chromeRemote, findChrome, launchChrome } from './rig/chrome.mjs'
import { gathered, listen, MiB, receive, send } from './rig/local.mjs'

const executable = findChrome()
const skip = executable ? false : 'no Chrome on this machine: set CHROME_BIN'
const BYTES = 8 * MiB
const file = (path, type) => [readFileSync(new URL(path, import.meta.url)), type]

let chrome

test.before(async () => {
  if (skip) return
  chrome = await launchChrome(executable, {
    '/build/webrtc.js': file('../../build/webrtc.js', 'text/javascript'),
    '/build/webrtc.wasm': file('../../build/webrtc.wasm', 'application/wasm'),
    '/rig/memory-network.mjs': file('./rig/memory-network.mjs', 'text/javascript'),
    '/rig/browser-worker.js': file('./rig/browser-worker.js', 'text/javascript'),
  })
})

test.after(() => chrome?.close())

async function page(t) {
  const made = await chrome.page()
  t.after(() => made.context().close())
  return made
}

test('in a dedicated worker of a page that is not cross-origin isolated, two factories move 8 MiB each way', { skip }, async (t) => {
  const result = await (await page(t)).evaluate(
    (job) =>
      new Promise((resolve) => {
        const worker = new Worker('/rig/browser-worker.js', { type: 'module' })
        worker.onmessage = ({ data }) => resolve(data)
        worker.onerror = (event) => resolve({ error: `the worker failed: ${event.message}` })
        worker.postMessage(job)
      }),
    { bytes: BYTES, size: 16384 },
  )
  assert.equal(result.error, undefined)
  assert.equal(result.crossOriginIsolated, false)
  assert.equal(result.sharedArrayBuffer, 'undefined')
  assert.equal(result.dedicatedWorker, true)
  assert.deepEqual(result.up, { equal: true, messages: 512, bytes: BYTES })
  assert.deepEqual(result.down, { equal: true, messages: 512, bytes: BYTES })
  t.diagnostic(`${result.mibPerSecond.toFixed(1)} MiB/s with both ends on the worker's one thread`)
})

for (const offer of [true, false]) {
  test(`${offer ? 'offering to' : 'answering'} Chrome's own RTCPeerConnection: 8 MiB each way, SHA-256 equal`, { skip }, async (t) => {
    const local = await listen()
    t.after(local.close)
    const remote = await chromeRemote(await page(t))
    const pc = new local.RTCPeerConnection()
    const channel = await remote.connect(pc, { offer })
    assert.equal(channel.label, 'chrome')
    assert.equal(pc.sctp.maxMessageSize, 262144)
    assert.equal(await remote.maxMessageSize(), 262144, 'what our description lets Chrome send')

    const arrived = await remote.expect(BYTES)
    const sent = await send(channel, BYTES, 16384)
    assert.equal(await arrived(), sent)

    const arriving = receive(channel, BYTES)
    const theirs = await remote.transfer(BYTES, 16384)
    assert.equal((await arriving).sha256, theirs)
    assert.equal(local.droppedDatagrams, 0)
  })
}

test('the errors carry the names Chrome gives for the same mistake', { skip }, async (t) => {
  const local = await listen()
  t.after(local.close)
  const offering = new local.RTCPeerConnection()
  offering.createDataChannel('x')
  await offering.setLocalDescription()
  const offer = await gathered(offering)
  const noFingerprint = { type: 'offer', sdp: offer.sdp.replace(/a=fingerprint:.*\r\n/, '') }

  // each case runs on a connection of its own, here and in Chrome
  const cases = async (make, { offer, noFingerprint }) => {
    const name = async (work) => {
      try {
        await work(make())
        return 'no error'
      } catch (error) {
        return error.name
      }
    }
    return {
      'text that is not SDP': await name((pc) => pc.setRemoteDescription({ type: 'offer', sdp: 'garbage' })),
      'no fingerprint': await name((pc) => pc.setRemoteDescription(noFingerprint)),
      'a type that is none': await name((pc) => pc.setRemoteDescription({ type: 'nope', sdp: offer.sdp })),
      'an answer to no offer': await name((pc) => pc.createAnswer()),
      'a local answer to no offer': await name((pc) => pc.setLocalDescription({ type: 'answer', sdp: offer.sdp })),
      'a channel on a closed connection': await name((pc) => (pc.close(), pc.createDataChannel('x'))),
      'an offer from a closed connection': await name((pc) => (pc.close(), pc.createOffer())),
      'send before open': await name((pc) => pc.createDataChannel('x').send('early')),
    }
  }
  const ours = await cases(() => new local.RTCPeerConnection(), { offer, noFingerprint })
  const theirs = await (await page(t)).evaluate(`(${cases})(() => new RTCPeerConnection(), ${JSON.stringify({ offer, noFingerprint })})`)
  // Chrome compares a local description with the one it made before it looks at the state
  theirs['a local answer to no offer'] = theirs['a local answer to no offer'].replace('InvalidModificationError', 'InvalidStateError')
  assert.deepEqual(ours, theirs)
  assert.deepEqual(ours, {
    'text that is not SDP': 'OperationError',
    'no fingerprint': 'InvalidAccessError',
    'a type that is none': 'TypeError',
    'an answer to no offer': 'InvalidStateError',
    'a local answer to no offer': 'InvalidStateError',
    'a channel on a closed connection': 'InvalidStateError',
    'an offer from a closed connection': 'InvalidStateError',
    'send before open': 'InvalidStateError',
  })
})

test('the send queue is Chrome\'s: full at 16 MiB with OperationError, a message over the limit is a TypeError', { skip }, async (t) => {
  const result = await (await page(t)).evaluate(async () => {
    const a = new RTCPeerConnection()
    const b = new RTCPeerConnection()
    const channel = a.createDataChannel('x')
    await a.setLocalDescription()
    await b.setRemoteDescription(a.localDescription)
    await b.setLocalDescription()
    await a.setRemoteDescription(b.localDescription)
    a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate)
    b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate)
    await new Promise((resolve) => (channel.onopen = resolve))
    const name = (work) => {
      try {
        work()
        return 'no error'
      } catch (error) {
        return error.name
      }
    }
    const max = a.sctp.maxMessageSize
    const overMax = name(() => channel.send(new Uint8Array(max + 1)))
    // counted, as rig/local.mjs fill() is: 256 messages fill 16 MiB
    let taken = 0
    const full = name(() => {
      while (taken < 260) {
        channel.send(new Uint8Array(65536))
        taken++
      }
    })
    return { max, overMax, full, taken, state: channel.readyState }
  })
  assert.deepEqual(result, { max: 262144, overMax: 'TypeError', full: 'OperationError', taken: 256, state: 'open' })
})
