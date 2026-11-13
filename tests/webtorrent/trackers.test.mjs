// The defaults the owner chose, as data, and which of a torrent's trackers the swarm opens.

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ICE_SERVERS, DEFAULT_TRACKERS, trackerUrl } from '../../build/webtorrent/index.js'
import * as page from '../../build/webtorrent/page.js'

test('the defaults are the two trackers and the STUN host the owner chose', () => {
  assert.deepEqual(DEFAULT_TRACKERS, ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'])
  assert.deepEqual(DEFAULT_ICE_SERVERS, [{ urls: 'stun:stun.l.google.com:19302' }])
  assert.equal(page.DEFAULT_ICE_SERVERS, DEFAULT_ICE_SERVERS)
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
