// What the cases that put a real engine under a real swarm share: the tracker's public name and a socket
// class on whose network that name is the reference tracker, a session seen through a recorder, a swarm over
// an engine, a seed and a download.

import fs from 'node:fs'
import path from 'node:path'

import { TORRENT_STATE } from '../../build/index.js'
import { webtorrentPeers } from '../../build/webtorrent/index.js'
import { bdecode, bencode, magnetFor } from '../rig/make-torrent.mjs'
import { waitFor } from '../rig/peer-handshake.mjs'
import { done } from '../rig/stream-engine.mjs'

// The name every torrent gives its tracker. The swarm opens no socket to a loopback name a torrent gives,
// so `routedWebSocket` is a network on which this public name is the reference tracker.
export const TRACKER = 'wss://tracker.test/'

/** A WebSocket class that reaches the tracker at `url` under the name `TRACKER`, and refuses every other name. */
export const routedWebSocket = (url) => {
  const Routed = class extends WebSocket {
    static opened = []
    constructor(asked) {
      Routed.opened.push(asked)
      if (asked !== TRACKER) throw new Error(`a socket to ${asked}`)
      super(url)
    }
  }
  return Routed
}

/**
 * What the swarm reads of a session, with every stream it hands over recorded in `handed`. `cut` refuses
 * each one. `mute` drops what the engine writes to the first one, so its remote hears nothing from it. `checks`
 * holds the state the engine passes through when a magnet's metadata arrives for half a second, which is how a
 * pump that read it at that moment leaves it until its next round.
 */
export const seenThrough = (session, handed, { cut = false, mute = false, checks = false } = {}) => {
  const since = new Map()
  return {
    torrents: () => session.torrents(),
    infohash: (handle) => session.infohash(handle),
    status: (handle) => {
      const status = session.status(handle)
      if (!checks || !status?.hasMetadata) return status
      if (!since.has(handle)) since.set(handle, Date.now())
      return Date.now() - since.get(handle) < 500 ? { ...status, state: TORRENT_STATE.checkingResumeData } : status
    },
    isPrivate: (handle) => session.isPrivate(handle),
    webSocketTrackers: (handle) => session.webSocketTrackers(handle),
    hasStreamWindow: (handle) => session.hasStreamWindow(handle),
    peers: (handle) => session.peers(handle),
    addPeerStream: (handle, socket) => {
      handed.push(handle)
      if (cut) throw new Error('this session takes no stream')
      if (mute && handed.length === 1) socket.write = () => true
      return session.addPeerStream(handle, socket)
    },
  }
}

/**
 * A swarm over `engine`'s session, as it is or seen through `seenThrough`, closed with the test. `options`
 * are the swarm's: `links`, `WebSocket`, `relay`.
 */
export const swarmOver = (defer, engine, options, through) => {
  const handed = []
  const peers = webtorrentPeers(through ? seenThrough(engine.session, handed, through) : engine.session, options)
  defer(() => peers.close())
  return { peers, handed, of: (handle) => peers.snapshot().torrents.find((torrent) => torrent.handle === handle) }
}

/** `from` holds the fixture and seeds it under `savePath`, and the tracker lists it. */
export const seed = async (from, fx, savePath) => {
  fs.mkdirSync(path.join(from.dir, savePath), { recursive: true })
  fs.writeFileSync(path.join(from.dir, savePath, fx.meta.name), fx.bytes)
  const torrent = bencode({ ...bdecode(fx.meta.torrent), announce: TRACKER })
  const handle = await from.running(from.session.addTorrentFile(torrent, `/${savePath}`))
  await waitFor('the seed to hold every piece', () => from.session.status(handle)?.numPiecesHave === fx.meta.pieces)
  // a download that announced before its seed is told of nobody, and asks again only at the tracker's interval
  await waitFor('the tracker to list the seed', () => from.of(handle)?.trackers[0]?.seeders === 1)
  return handle
}

/** The fixture's magnet with the tracker in it. */
export const magnetOf = (fx) => `${magnetFor(fx.meta.infoHash, fx.meta.name)}&tr=${encodeURIComponent(TRACKER)}`

/**
 * Resolves once `to` holds the file of `handle`, with what carried its peers meanwhile (two seeds drop each
 * other, so a peer is gone soon after) and the most each kind of peer delivered. Rejects after `ms`.
 */
export const finished = async (to, handle, ms) => {
  const delivered = {}
  await waitFor('the download', () => {
    void to.session.peers(handle)
    for (const peer of to.session.lastPeers(handle)) delivered[peer.transport] = Math.max(delivered[peer.transport] ?? 0, peer.totalDownload)
    return done(to.session, handle)
  }, ms)
  return { handle, carriedBy: Object.keys(delivered), delivered }
}

/** `to` adds the fixture's magnet and downloads it: `finished` of that torrent. */
export const download = async (to, fx, savePath, ms) =>
  finished(to, await to.running(to.session.addMagnet(magnetOf(fx), `/${savePath}`)), ms)
