// The defaults the owner chose, as data, and the two readers the swarm's tracker list is built from.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { DEFAULT_ICE_SERVERS, DEFAULT_TRACKERS, trackersOf, trackerUrl } from '../../build/webtorrent/index.js'
import * as page from '../../build/webtorrent/page.js'

const bencode = value => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (typeof value === 'string') return bencode(Buffer.from(value))
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value])
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
}

const torrent = extra => bencode({
  info: { length: 1 << 20, name: 'fixture.bin', 'piece length': 1 << 18, pieces: crypto.randomBytes(80) },
  ...extra,
})

test('the defaults are the two trackers and the STUN host the owner chose', () => {
  assert.deepEqual(DEFAULT_TRACKERS, ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'])
  assert.deepEqual(DEFAULT_ICE_SERVERS, [{ urls: 'stun:stun.l.google.com:19302' }])
  assert.equal(page.DEFAULT_ICE_SERVERS, DEFAULT_ICE_SERVERS)
})

test('a magnet link gives its ws and wss trackers, decoded, each once, and nothing else', () => {
  const magnet = 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=a+film'
    + '&tr=udp%3A%2F%2Ftracker.test%3A6969%2Fannounce'
    + '&tr=wss%3A%2F%2Ftracker.test&tr=http%3A%2F%2Ftracker.test%2Fannounce'
    + '&tr.1=ws%3A%2F%2Fother.test%3A8000%2Fannounce&tr=wss%3A%2F%2Ftracker.test&tr=WSS://upper.test&tr=%E0%A4%A&x.pe=192.0.2.1:6881'
  assert.deepEqual(trackersOf(magnet), ['wss://tracker.test', 'ws://other.test:8000/announce', 'WSS://upper.test'])
  assert.deepEqual(trackersOf('magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd'), [])
  assert.deepEqual(trackersOf(''), [])
})

test('a .torrent file gives the ws and wss trackers of announce and of every tier of announce-list', () => {
  const bytes = torrent({
    announce: 'wss://first.test',
    'announce-list': [
      ['udp://tracker.test:6969', 'wss://first.test'],
      ['http://tracker.test/announce'],
      ['ws://second.test/announce', 'wss://third.test:443/announce'],
    ],
  })
  assert.deepEqual(trackersOf(new Uint8Array(bytes)), ['wss://first.test', 'ws://second.test/announce', 'wss://third.test:443/announce'])
  assert.deepEqual(trackersOf(torrent({ announce: 'wss://only.test/announce' })), ['wss://only.test/announce'])
  assert.deepEqual(trackersOf(torrent({})), [])
  assert.deepEqual(trackersOf(torrent({ announce: 'udp://tracker.test:6969' })), [])
})

test('bytes that are not a torrent give an empty list and never throw', () => {
  const good = torrent({ announce: 'wss://first.test' })
  const cases = [
    new Uint8Array(0), crypto.randomBytes(512), good.subarray(0, good.length - 40), Buffer.from('l'.repeat(100_000)),
    Buffer.from('d8:announce'), Buffer.from('i12e'), Buffer.from('d8:announcei7ee'), Buffer.from('99999999999:x'),
  ]
  for (const bytes of cases) assert.deepEqual(trackersOf(bytes), [])
})

test('a tracker URL is normalised, so one tracker spelt two ways is one socket', () => {
  assert.equal(trackerUrl('WSS://Tracker.Test'), 'wss://tracker.test/')
  assert.equal(trackerUrl('wss://tracker.test:443/'), 'wss://tracker.test/')
  assert.equal(trackerUrl('ws://tracker.test:8000/announce'), 'ws://tracker.test:8000/announce')
  assert.equal(trackerUrl('wss://203.0.113.9/announce'), 'wss://203.0.113.9/announce')
  assert.equal(trackerUrl('wss://[2001:db8::1]/'), 'wss://[2001:db8::1]/')
})

test('a URL that is not a WebSocket tracker, or names the person’s own machine or network, is null', () => {
  const refused = [
    'udp://tracker.test:6969', 'http://tracker.test/announce', 'https://tracker.test/announce', 'not a url', '',
    'wss://localhost', 'wss://LOCALHOST.', 'wss://a.localhost', 'wss://nas', 'wss://printer.local',
    'ws://127.0.0.1:8000', 'ws://127.255.255.255', 'ws://2130706433', 'ws://0x7f.1', 'wss://0.0.0.0',
    'wss://10.1.2.3', 'wss://172.16.0.1', 'wss://172.31.255.255', 'wss://192.168.0.1', 'wss://169.254.1.1',
    'wss://100.64.0.1', 'wss://100.127.255.255',
    'wss://[::1]', 'wss://[::]', 'wss://[fe80::1]', 'wss://[febf::1]', 'wss://[fc00::1]', 'wss://[fdff::1]',
    'wss://[::ffff:10.0.0.1]', 'wss://[::ffff:7f00:1]',
  ]
  for (const url of refused) assert.equal(trackerUrl(url), null, url)
  const kept = [
    'wss://172.15.0.1', 'wss://172.32.0.1', 'wss://100.63.0.1', 'wss://100.128.0.1', 'wss://11.0.0.1',
    'wss://[fe7f::1]', 'wss://[fec0::1]', 'wss://[fe8::1]', 'wss://[::ffff:203.0.113.9]', 'wss://local.test',
  ]
  for (const url of kept) assert.notEqual(trackerUrl(url), null, url)
})
