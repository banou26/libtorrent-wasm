// A session with no relay is an ordinary session on offlineHost(): the engine still asks for the
// trackers and peers a torrent names, and every one of those asks has to end at once and inside
// the thread.

import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

const ENGINE = new URL('./rig/offline-engine.mjs', import.meta.url)

const run = (workerData, ms) => new Promise((resolve, reject) => {
  const worker = new Worker(ENGINE, { workerData })
  const arrivals = []
  const reports = []
  worker.on('message', (report) => { arrivals.push(performance.now()); reports.push(report) })
  worker.on('error', reject)
  setTimeout(async () => {
    await worker.terminate()
    const times = [...arrivals, performance.now()]
    const maxGapMs = Math.max(...times.slice(1).map((at, i) => at - times[i]))
    resolve({ reports, last: reports.at(-1), maxGapMs })
  }, ms)
})

test('a session on offlineHost() asks for its trackers and its peer, and nothing leaves', async () => {
  const hex = Array.from({ length: 20 }, (_, i) => ((i * 53 + 7) & 0xff).toString(16).padStart(2, '0')).join('')
  const trackers = ['udp://tracker.example.org:6969/announce', 'http://tracker.example.net/announce', 'wss://tracker.example.com']
  const magnet = `magnet:?xt=urn:btih:${hex}&dn=offline${trackers.map((url) => `&tr=${encodeURIComponent(url)}`).join('')}&x.pe=192.0.2.10:6881`
  // the peer is tried over uTP first, and dialled about 5 s after the add
  const { reports, last, maxGapMs } = await run({ magnet }, 8000)

  assert.ok(last, 'the engine never reported')
  assert.ok(maxGapMs < 1000, `the worker stopped answering for ${Math.round(maxGapMs)} ms`)
  assert.ok(last.maxTickMs < 1000, `one tick ran for ${Math.round(last.maxTickMs)} ms`)
  const earlier = reports.find((r) => r.at > last.at - 2000)
  assert.ok(last.statusUpdates > earlier.statusUpdates, 'no status update in the last two seconds')

  assert.equal(last.fetches, 0, 'a name left through the engine\'s own lookup')
  assert.deepEqual([...new Set(reports.flatMap((r) => r.sockets))], [], 'the thread opened a socket')

  // and the zeros are not for want of asking
  assert.deepEqual([...new Set(last.lookups)].sort(), ['tracker.example.net', 'tracker.example.org'])
  assert.ok(last.datagrams >= 1, 'the peer was never tried over uTP')
  assert.deepEqual([...new Set(last.connects.map((c) => c.address))], ['192.0.2.10'])
  for (const c of last.connects) {
    assert.ok(c.closedAfterMs != null && c.closedAfterMs < 500, `a connect was left open: ${JSON.stringify(c)}`)
  }
})
