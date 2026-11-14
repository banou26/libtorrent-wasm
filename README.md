# libtorrent-wasm

[arvidn/libtorrent](https://github.com/arvidn/libtorrent) compiled to a
single-threaded WebAssembly module that runs in a Web Worker. Networking is
plumbed through the [FKN WebVPN](https://github.com/Banou26/fkn) via the
`@fkn/lib/net` and `@fkn/lib/dgram` polyfills, so a browser-hosted session can
talk real TCP and uTP to internet peers.

## Layout

```
libtorrent/    # git submodule, pinned at the merge base from upstream RC_2_0
patches/       # *.patch files applied to libtorrent/ at build time
src/           # the WASM port itself
  wrapper.cpp        - C++ entry points exposed to JS
  disk_io.{cpp,hpp}  - libtorrent disk_interface impl backed by a JS callback
  library_fkn.js     - emscripten js-library: socket syscalls + disk bridge
  index.ts           - public JS API (Session)
  opfs.ts            - StorageBackend impl backed by the OPFS
  types.ts           - shared TS types
  webtorrent/        - WebRTC peers through WebSocket trackers (two optional entries, no wasm)
  webrtc/            - the optional ./webrtc entry: an RTCPeerConnection over a UDP socket the caller owns
webrtc/        # that entry's stack: a Rust crate around str0m, built by cargo for wasm32-wasip1
src/app/       # browser harness with diagnostic pages
dist/          # emcc output (gitignored)
build/         # vite output + copied wasm artefacts (gitignored)
```

## Streaming

To play a file while it downloads, tell the session where each reader is and let
it plan:

```js
session.setStreamWindow(handle, [{ fileIndex, offset: playheadByte }])
const header = await session.read(handle, fileIndex, 0, 256 * 1024)
```

Call `setStreamWindow` again on every seek and as playback advances, on a real
position change rather than on every read: each call empties the time-critical
set, so the next deadline re-posts a cancel of every outstanding non-critical
block request, and it copies a full piece-count vector across the boundary.

`read()` resolves once the covering pieces have landed and rejects after 60 s
(`timeoutMs`) rather than waiting forever. Placing a deadline also raises the
piece to top priority and un-filters it, so reading into a file you set to
priority 0 starts downloading that range; pass `deadlineMs: null` to read
without touching priorities.

`popAlerts()` (or `alerts()`) has to be pumped for a `read()` to ever resolve:
that is where a state update lands and the have-bits are read. `tick()` asks for
the status updates on its own.

### Priority does not mean order

This is the part that catches people. In libtorrent a piece priority is a
*weight*, not a position:

- A band of top-priority (7) pieces is bucketed by how many peers have each one
  and shuffled inside each bucket, so it is served in effectively random order.
- Sequential mode's in-order walk **skips** top-priority pieces, on the
  assumption the priority pass already took them. Painting a whole file 7
  therefore removes it from the only in-order path there is.
- Ordering comes from `set_piece_deadline`, which is the mechanism upstream
  points at for streaming.

So `setStreamWindow` keeps the bulk of the claimed file at normal priority,
where the sequential cursor walks it in index order, and promotes only a small
window at the playhead with a staggered deadline ladder behind it. Widening
`windowPieces` past a couple of dozen makes playback worse, not better.

The other half of the surprise: under sequential mode only **0 versus not 0**
changes picking. Priority 1 and priority 4 pick identically, so demoting what is
behind the playhead buys nothing.

`deadlineStepMs` defaults to 1000, which is a placeholder. The honest value is
`pieceLength / playbackBytesPerSecond * 1000`, and only the caller knows the
bitrate. For small pieces the default authorizes falling behind real time.

Three sharp edges the API handles for you, worth knowing if you drive the
primitives directly:

- `clearPieceDeadlines()` leaves every cleared piece at priority **1**, below
  the default 4. Always clear *before* writing priorities, never after.
- `resetPieceDeadline()` demotes that one piece the same way, so put its
  priority back afterwards.
- A deadline is an absolute instant, and nothing removes it but the piece
  arriving. An expired deadline from an abandoned seek outranks every range
  requested after it, so retire deadlines you no longer want.

### When a read waits on a piece nobody will deliver

One peer can claim every block of a piece and then stop sending them. Nothing in
libtorrent recovers that on its own:

- The picker walks straight past it. Its "is this piece available" test checks
  only have/filtered, with no "already being downloaded" case, so the in-order
  walk keeps downloading ahead at full speed while the piece sits there. Bytes
  keep climbing and playback does not start.
- No other peer may duplicate the blocks while its own request queue is
  non-empty, which in a live swarm is always.
- The sweep that cancels stale requests deliberately skips pieces that have a
  deadline, so marking a piece urgent is what protects the stall.
- The duplicate-request rescue only engages once a deadlined piece has already
  completed, so it is inert exactly when it is needed, at startup.

`cancelPieceRequests(handle, piece)` is the way out: it drops every outstanding
request for that piece so any peer can pick it up again. Call it for a read that
has already been waiting several seconds, not on the first attempt, since it
discards partial blocks from peers that were merely slow.

### API

| Call | Purpose |
| --- | --- |
| `setStreamWindow(handle, claims, opts?)` | Plan priorities + deadlines from reader positions. The one to use. |
| `clearStreamWindow(handle)` | Drop the plan, everything back to normal, sequential off. |
| `read(handle, fileIndex, offset, len, opts?)` | Await a byte range. Clamps to EOF; `{ timeoutMs, signal, deadlineMs }`. |
| `setSequential(handle, on)` | The `sequential_download` flag on its own. |
| `setPieceDeadline(handle, piece, ms, alertWhenAvailable?)` | One deadline. `ms` is relative to now. |
| `resetPieceDeadline(handle, piece)` | Retire one deadline, leaving the rest. |
| `cancelPieceRequests(handle, piece)` | Take a piece back from peers sitting on it. See below. |
| `forgetPieces(handle, pieces)` | Stop claiming pieces whose bytes the storage drops (patch 0010). `{ forgotten, busy }`, or null for a seed or a check. |
| `clearPieceDeadlines(handle)` | Retire all of them. Demotes to priority 1. |
| `prioritizePieces(handle, prios)` | Positional map, one byte per piece from 0. |
| `prioritizePieceList(handle, entries)` | Sparse update; other pieces keep what they have. |
| `setFilePriorities(handle, prios)` | One byte per file. Rewrites piece priorities. |
| `setFilePriority(handle, fileIndex, prio)` | One file. Also rewrites its piece priorities. |
| `piecePriorities(handle)` | What this Session last wrote, or null. |
| `prioritizeRange(handle, fileIndex, offset, len)` | One-off prefetch. REPLACES an active window. |

Priorities are `PRIORITY.skip` (0), `low` (1), `normal` (4), `top` (7). Values
above 7 truncate into a 3-bit field, and 8 lands as 0 (never download), so stay
on those. Everything except `setSequential`, `setPieceDeadline` and
`setFilePriority` needs the file layout, so wait for `files(handle)` to be
non-null.

### Multi-file torrents

Pass `unclaimedPriority: PRIORITY.skip`. This is not just a bandwidth
optimization: sequential mode's cursor sits at the first piece the torrent does
not have, so with everything at the default 4 the capacity beyond the window
goes to the **first file in the torrent**, not the one being watched. Skipping
is what moves the cursor onto the watched file.

Pieces straddling a file boundary keep the claimed priority, so no byte the
watched file needs is ever skipped. Skipping files shrinks `totalWanted`, so
`progress` and the finished state then describe the selection rather than the
whole torrent, and the selection is persisted into resume data. `totalDone`
still counts a skipped file that is held, so what is left of the selection is
`totalWanted - totalWantedDone`.

## Peer streams

`session.addPeerStream(handle, socket)` makes a peer out of a byte stream the
caller opened, for a transport libtorrent does not have (a WebRTC data channel,
for one):

```js
const { address, port } = session.addPeerStream(handle, socket)
```

The stream gets an address of its own in `100.64.0.0/10`, port 6881. libtorrent
is told to dial it, and the socket shim answers that dial with `socket`, within
about a second. `socket` has the shape of a host socket (`PeerStreamSocket`):

| Member | Contract |
| --- | --- |
| `on('data' \| 'end' \| 'close' \| 'error' \| 'drain', fn)` | The engine attaches its listeners when libtorrent dials. Bytes that arrive before then are held and delivered in order. |
| `write(chunk)` | One call carries up to about 512 KiB, so a transport with a message limit slices it. |
| `destroy(error?)` | Called when libtorrent drops the peer, when the stream was never dialled, and when `maxRecvQueue` is passed. |
| `backpressure` | Set it `true` and answer `false` from `write()` to hold the engine back until `drain`. Unset, every write is taken. |
| `maxRecvQueue` | Unread bytes past which the stream is destroyed. Leave it unset: it becomes 96 MiB, above the 78 MiB of blocks the engine may have asked one peer for. |

What it promises:

- The address stays inside the engine. A connect or a datagram to the range
  never reaches `net` or `dgram` (a dial with no stream behind it is refused in
  memory), resume data is written without it, peer exchange does not send it
  (patch 0011), and a holepunch message carries it only back to a peer that
  named it (patch 0013).
- No address is given twice before all 4,194,304 have been used.
- The peer list shows the peer with `transport: 'webrtc'` and an `endpoint`
  that is not an address, and `reachable().inbound` never counts it.
- A stream peer is one the engine dialled inside the range. An ordinary peer
  that dialled in from there, on a carrier's network that uses it, keeps its
  address in the peer list, counts as inbound and is saved to resume data.

What it refuses:

- A stream libtorrent has not dialled within 10 s (the torrent is paused or
  queued, the session is at its connection limit) is destroyed with an error,
  and so is one for a torrent the engine does not hold, at once. Hand a stream
  over once it is open, for a torrent that is running.
- It does no signalling. Finding the remote, opening the stream and opening
  another after it closes are the caller's.
- It does not rewrite alerts. An alert's text is libtorrent's own and names the
  peer by its made-up address, so an address in `100.64.0.0/10` there is
  nobody's.

### A session with no relay

`offlineHost()` returns a `net`, a `dgram` and a `dnsLookup` that carry nothing:
connects are refused at once, datagrams are dropped, and no name gets an
address. A session on it reaches only the peers handed to `addPeerStream`:

```js
const session = await createSession({
  ...offlineHost(), storage, enableDht: false, reserveListenPort: false,
})
```

It is the ordinary engine otherwise, so the trackers and web seeds a torrent
names are still tried, and fail without a byte leaving. Pass both flags: there
is nobody to bootstrap the DHT from, and a port reservation would wait 8 s for a
port that cannot exist.

`dnsLookup` is an option of `createSession` on its own too. Without one the
engine resolves names over HTTPS at 1.1.1.1, from the page's own network.

## When the relay goes away

A relay that restarts, or a connection to it that drops, ends the engine's UDP
socket and its TCP listener. The socket layer keeps both fds and opens new
sockets under them, so libtorrent never sees the outage:

- It retries after 250 ms, 1 s, then every 2 s, so a relay that is back is
  found within 2 s. A socket that is back starts this over.
- A replacement socket counts for nothing until its bind is granted: the fd
  does not read writable and a send is answered `EAGAIN`. libtorrent's uTP
  connections wait for a writable fd to resend, so one that is kept resends as
  the socket comes back, and not on its next timeout, which the outage has
  backed off to 11.8 s, 21.0 s and 38.2 s after its last acknowledged packet.
- Each retry asks for the port the socket first held, the one trackers, peer
  exchange and the DHT were given and the one `reachable().port` names. For the
  first minute of an outage (`KEEP_PORT_MS`) it asks for nothing else, since a
  relay that lost the connection holds the port for the old session a while.
  After that, a refusal of it is followed at once by a retry on any free port,
  so a relay that comes back with the port free still hands it back, and only
  a number somebody else took is given up. That new port is then not announced
  anywhere, and `reachable().portOpen` reads false.
- When the UDP socket comes back more than 4 s after the drop
  (`REDIAL_AFTER_MS`), which is a relay away for more than about 3 s, every uTP
  peer the engine can dial back is sent a reset and disconnected, and once the
  socket has stayed up 2 s the ones that have not dialled us back are dialled
  again. A remote keeps its side of the old connection until its own resends
  give up and refuses a second one from us meanwhile, so the reset is what lets
  the new one in. It is numbered at the first packet the remote has not
  acknowledged (patch 0015): a libtorrent remote drops a reset numbered past
  its reorder window, which upstream's random number is half the time. A relay
  that goes away again within those 2 s holds the redial until a socket lasts.
- Left alone: the connections through a shorter outage, since every remote is
  still resending and they carry on by themselves, and a peer that dialled us
  over uTP, which nothing could dial back and which carries on the same way.
- `reachable().listeners` reads `healing` from the drop until each socket is
  back.

Measured with `tests/rig/relay-outage.mjs` (4 transmission seeders at 100 kB/s,
the relay away 20 s at 20% of a 30 MB download, a reader in the file): bytes
moved again 4.0 to 4.5 s after the relay was back, on the same port (4 runs),
and 4.5 to 12.0 s without the reset (4 runs, alternated). Before, libtorrent
kept the dead connections until uTP gave up on its resends (194 to 197 s after
the drop), waited `min_reconnect_time` (60 s) to dial again, and the bytes came
back 237 to 240 s after the relay, on two new ports. On two engines over
loopback (`tests/relay-return.test.mjs` and the same cases by hand, 3 runs
each): a seed behind the relay served the peer that had dialled it again 2.3 to
2.5 s after the relay, a relay away again 1 s after it came back cost 5.0 to
5.5 s after its second return, and a relay away 2 s cost 2.2 to 3.4 s with the
connections kept. One away 60 s or 300 s came back on the same port.

A seed behind the relay, serving a peer that had dialled in, has nothing but
that resend to come back with. While a replacement socket could be written to
before its bind, the resend that waited was written into one the relay then
refused, lost and counted as sent: with the relay away 22 s no byte moved
within 10 s of its return in 4 of 72 runs, and in the 2 of 25 instrumented
runs where a datagram went to the last refused replacement; with it away 14 s
none moved within 5 s in 11 of 12 runs, the next resend being due 21.0 s after
the drop. Since: 36 of 36 and 12 of 12, 1.8 to 4.0 s after the relay, and no
datagram to a socket without a port in 24 instrumented runs.

The reset's number decides it when this end sent packets into the outage. The
remote then takes the FIN of the disconnect only after those packets, and they
are resent on a timer the outage has backed off. With such packets made on
purpose (`tests/rig/rel-outage.mjs --queued`, the relay away 20 s, alternated
between the engine with upstream's random number and with patch 0015): no uTP
byte within the 40 s watched in 4 of 12 runs before, each of them one of the 6
whose reset was numbered past the window, and in 0 of 12 after (4.7 to 6.8 s).

What is left: a relay that goes away again in the moment between the redial's
dial and the remote's answer leaves the remote holding a connection this end
has dropped, and the remote turns the next dial away. With the relay away again
3 s after it came back, the bytes moved within 5 s of its second return in 3 of
6 runs, after 50 to 52 s in 2, and not within 90 s in 1.

## WebRTC peers

Two optional entries find WebRTC peers through WebSocket trackers and hand each open data channel to libtorrent as
a peer. The engine itself does not import them, and neither carries any wasm.

| entry | where it runs | what it is |
| --- | --- | --- |
| `libtorrent-wasm/webtorrent` | the engine worker | the tracker client, the swarm's rules, and the links to a WebRTC implementation |
| `libtorrent-wasm/webtorrent/page` | the page that owns the worker | makes the browser's peer connections for the worker and carries their bytes over one `MessagePort` |

One swarm serves two modes, and a session is in one of them. With no relay behind it, [the direct
mode](#the-direct-mode): every peer is a WebRTC peer, and the connections are the browser's own. Behind the
relay, [the relay mode](#the-relay-mode): WebRTC peers beside the ordinary ones, over a third optional entry,
[`libtorrent-wasm/webrtc`](#webrtc-over-a-socket-you-own-libtorrent-wasmwebrtc), a WebRTC stack of the
package's own.

### The direct mode

A session with no relay behind it, whose peers are all WebRTC peers. Three parts, each of which the caller
wires: the engine on `offlineHost()`, which reaches nothing by itself; the swarm in the engine worker, which
finds peers through WebSocket trackers; and the page that owns the worker, which makes the connections, since a
worker has no `RTCPeerConnection` in any browser. Every decision stays in the worker.

```js
// the engine worker
import { createSession, offlineHost } from 'libtorrent-wasm'
import { OPFSStorage } from 'libtorrent-wasm/opfs'
import { webtorrentPeers, pageLinks, DEFAULT_TRACKERS } from 'libtorrent-wasm/webtorrent'

const session = await createSession({
  ...offlineHost(), storage: new OPFSStorage(), enableDht: false, reserveListenPort: false,
})

const { port1, port2 } = new MessageChannel()
postMessage({ type: 'peer-links', port: port2 }, [port2])
const peers = webtorrentPeers(session, { links: pageLinks(port1), WebSocket, trackers: DEFAULT_TRACKERS })
peers.onchange = () => postMessage({ type: 'peers', snapshot: peers.snapshot() })

// the session's pump, as for any session: the swarm reads what it leaves behind
setInterval(() => {
  session.popAlerts()
  for (const handle of session.torrents()) session.postStatus(handle)
  peers.refresh()
}, 500)

// the page
import { RTCPeerConnection } from '@banou/ponyfill'
import { servePeerLinks, DEFAULT_ICE_SERVERS } from 'libtorrent-wasm/webtorrent/page'

worker.addEventListener('message', ({ data }) => {
  if (data.type === 'peer-links') servePeerLinks(data.port, { RTCPeerConnection, iceServers: DEFAULT_ICE_SERVERS })
})
```

- **The session** is the ordinary one over a host that carries nothing ([above](#a-session-with-no-relay)).
  Torrents are added, paused and removed on it as on any session, and the swarm follows.
- **The trackers and the STUN host are the caller's to pass.** `DEFAULT_TRACKERS` and `DEFAULT_ICE_SERVERS`
  are constants, and nothing is contacted when they are left out. A torrent's own `ws` and `wss` trackers come
  from the session (`webSocketTrackers`), from a magnet link, a .torrent file and resume data alike.
- **The class** is `RTCPeerConnection` of `@banou/ponyfill`, in a release after 0.0.13, which has none.
  Chromium counts a closed connection against its 500 a page until a garbage collection, and that class
  brings those slots back when a construction is refused. The browser's own class works until that limit.
- **A magnet is announced to the passed trackers before its metadata says whether it is private.** In this
  mode only a WebRTC peer can bring the metadata, and most magnets name `udp` and `http` trackers only. So a
  torrent whose private flag is not known yet is announced to its own `ws` and `wss` trackers and to the
  passed ones. For that time each passed tracker sees its info hash and the address the announce came from.
  That time lasts until a peer has sent the metadata, and for as long as the torrent runs when none does: a
  libtorrent client that holds a private torrent from its .torrent file sends no metadata, so the magnet of
  a private torrent whose only peers are such clients stays announced to the passed trackers.
  - **The metadata says it is not private:** nothing changes.
  - **The metadata says it is private:** each passed tracker is told `stopped` for it, once, and hears nothing
    of it again, however long the torrent runs. The `stopped` carries what the announces before it carried,
    not the size the metadata brought. It is said when the swarm next reads the session, within a second or
    at once on `refresh()` ([below](#what-it-reads-from-the-session)), and until then the swarm still acts at
    the passed trackers as for any magnet. That waits for no check of the files. Offers and answers that
    went through a passed tracker and have not opened a channel yet are closed. A channel that is already open
    stays: it is a peer of the engine's by then, and libtorrent keeps the peers a magnet had when its metadata
    says private. The torrent's own trackers are announced to as before. Nothing remembers the torrent past
    its removal: the same magnet added again is announced like any magnet until its metadata is back.
  - **A torrent known to be private from the start** (a .torrent file, or resume data saved once the metadata
    was there, which carries it) is announced to its own trackers only, never to a passed one. With no `ws` or
    `wss` tracker of its own it finds nobody in this mode.

What `peers.snapshot()` tells an interface, for each running torrent (`torrents[]`) and for the session:

| field | what it says |
| --- | --- |
| `open`, `pending` | WebRTC peers connected for the torrent, and attempts under way, unanswered offers included |
| `lastPeerAt` | when a peer last connected, or null: none yet in this session |
| `trackers[]` | for each: `url`, `connected`, `answeredAt` (null until its first answer), `seeders` and `leechers` as it counted them, this session included, and `failure`, its own words when it refused the last announce |
| `silent` | remotes whose channel opened and ended without a byte from them in the last ten minutes: peers that will not talk to this address, which is not the same as nobody being there |
| `unmade` (session) | connections the WebRTC class would not make because the page had no slot then. Not an error to show: the next announce tries again |
| `dropped` (session) | tracker messages that did not validate |

So "no peers yet, still searching" is a torrent whose trackers have answered, with `open` at 0 and `lastPeerAt`
null, and it is taken back when `open` rises. `onchange` fires after any of it changed.

### The relay mode

A session behind the relay keeps its ordinary peers and takes WebRTC peers beside them: the same swarm, in the
same worker, over a WebRTC stack whose every packet leaves through the relay. Nothing of it is in the page. Four
parts, each of which the caller wires: the ordinary session; one more UDP socket of its host; the class of
[`libtorrent-wasm/webrtc`](#webrtc-over-a-socket-you-own-libtorrent-wasmwebrtc) over that socket; and the swarm
with `relay` over that class.

```js
// the engine worker
import net from '@fkn/lib/net'
import dgram from '@fkn/lib/dgram'
import { WebSocket } from '@fkn/lib/websocket'
import { createSession } from 'libtorrent-wasm'
import { createWebRTC } from 'libtorrent-wasm/webrtc'
import { webtorrentPeers, rtcLinks, DEFAULT_TRACKERS } from 'libtorrent-wasm/webtorrent'

const session = await createSession({ net, dgram, storage })   // as without WebRTC: TCP, uTP, the DHT

// one UDP socket for every WebRTC connection, apart from the engine's own
const bound = () => new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4')
  socket.once('listening', () => resolve(socket))
  socket.once('error', reject)
  socket.bind(0)
})

const socket = await bound()
// address: the relay's public IPv4 address, which the socket does not know. With the port it is the one
// candidate of every description, so no STUN host is asked.
const webrtc = await createWebRTC({ socket, address, port: socket.address().port })
const peers = webtorrentPeers(session, {
  links: rtcLinks({ RTCPeerConnection: webrtc.RTCPeerConnection }),
  WebSocket,                    // the platform's shape, opened through the relay
  trackers: DEFAULT_TRACKERS,
  relay: true,
})
```

The pump and `peers.snapshot()` are the direct mode's. What differs:

| | the direct mode | the relay mode |
| --- | --- | --- |
| the session | on `offlineHost()`, with no DHT and no listen port | the ordinary one: its TCP, uTP and DHT peers stay, and a torrent takes pieces from both kinds |
| where a connection is made | in the page, by the platform's class or the ponyfill's (`servePeerLinks`) | in the worker, by the class of `libtorrent-wasm/webrtc` |
| `links` | `pageLinks(port)` | `rtcLinks({ RTCPeerConnection })` |
| our candidates | what the browser gathers, with the STUN host that was passed | one: the relay's public address and the socket's port. No STUN host, so `iceServers` is left out |
| a remote's candidates | all | public IPv4 addresses only: the rest never reach the stack, since a relay refuses a datagram to them |
| `WebSocket` | the platform's | a constructor of the platform's shape whose sockets go through the relay (`WebSocket` of `@fkn/lib/websocket`) |
| who sees the person's address | each tracker, the STUN host and every peer | none of them: they see the relay's |
| `relay` | left out | `true`: a channel whose remote address is an ordinary peer of the torrent, or was one earlier in the session, is closed before libtorrent hears of it |
| a magnet whose metadata has not said whether it is private | announced to its own trackers and to the passed ones, which are told `stopped` if it says private | announced to its own only: its ordinary peers bring the metadata, and the passed ones follow once it is known not to be private |
| when the socket ends | nothing to do: the browser's connections are the page's | the factory ends with it: make both again ([below](#when-the-relay-goes-away-in-the-relay-mode)) |

Its limits:

- **It is for browser peers.** A libtorrent 2.1 peer (qBittorrent) takes one WebRTC connection per address, and
  behind a relay that address is everybody's on it; it takes none from an address it holds as an ordinary peer.
  Two of our sessions behind one address against one 2.1 seed (the rig below, 3 runs): the first held its
  channel and downloaded over it; the second's channel opened and ended without a byte from the 2.1 peer, was
  counted `silent`, and nothing more was made with that peer through its next two announces (135 s). Such a
  peer is reached over TCP or uTP all the same, and the second session also took the file from the first, over
  a channel between the two.
- **One connection at a time between two sessions that both use this stack.** Two connections between one pair
  of sockets cannot be told apart, so a second torrent the two share connects once the first torrent's
  connection is gone, or is given up after 30 s and tried again at a later announce.
- **IPv4 only**, since the candidate is one IPv4 address.
- **An upload is held to the stack's send buffer for each round trip**: 4.64 to 4.79 MiB/s to a libtorrent 2.1
  peer over 50 ms with the default of 256 KiB (10 runs through the swarm), 10.5 to 12.4 with 4 MiB (10 runs).
  `sendBufferSize` of `createWebRTC` sets it for a whole factory.
- **What the swarm remembers goes with it**: the remotes that stayed silent and where the ordinary peers were.

Measured in the libtorrent 2.1 rig (the 2.1.1 wheel in private network namespaces, our session over real
sockets, the WebRTC entry's class and the swarm with `relay`, as above; 2026-11-14): 20 MiB down from a 2.1
seed to a magnet and 20 MiB up to a 2.1 magnet leecher, SHA-256 equal in 4 runs of 4 each, carried by the
channel alone, with the relay rule reading the 2.1 peer's address from the selected pair. 256 MiB up over 50 ms
of round trip: 10 runs of 10 complete on one channel with no early end, and the socket was handed at most 128
datagrams in a task and 193 within a millisecond; with the send buffer at 4 MiB, 10 of 10 again, 128 in a task
and 256 within a millisecond. With a session that takes no stream, both transfers fail.

#### When the relay goes away, in the relay mode

The engine heals its own sockets ([above](#when-the-relay-goes-away)). The WebRTC socket is the caller's, and
the factory ends with it: every connection fails at once and no new one is made. So when that socket closes,
close the swarm and the factory, and make both again on a new socket, on any port:

```js
for (;;) {
  const socket = await bound().catch(() => null)             // refused while the relay is away
  if (!socket) { await new Promise((resolve) => setTimeout(resolve, 500)); continue }
  const closed = new Promise((resolve) => socket.once('close', resolve))
  const webrtc = await createWebRTC({ socket, address, port: socket.address().port, wasm })
  const peers = webtorrentPeers(session, {
    links: rtcLinks({ RTCPeerConnection: webrtc.RTCPeerConnection }), WebSocket, trackers: DEFAULT_TRACKERS, relay: true,
  })
  await closed
  peers.close()
  webrtc.close()
}
```

With `wasm` passed as a compiled `WebAssembly.Module`, a new factory compiles nothing. Measured with
`tests/rig/rel-outage.mjs` (a download behind a relay that is taken away, with a uTP seed and a WebRTC seed at
256 KiB/s each, the WebRTC seed on this stack or on libdatachannel, everything on loopback; 2026-11-14):

| what is done with the WebRTC half | relay away | WebRTC bytes again, after the relay is back | runs |
| --- | --- | --- | --- |
| made again on a new socket, any port | 20 s | 1.5 to 3.2 s | 36 of 36 |
| made again, with every port the relay's sockets held taken by somebody else | 20 s | 1.5 to 2.3 s | 4 of 4 |
| made again on a new socket, any port | 5 s | 1.9 to 3.7 s | 33 of 33 |
| made again on the port it had, the remote on this stack | 5 s | not within 40 s | 0 of 2 |
| made again on the port it had, the remote on this stack | 20 s | 6.3 to 6.5 s | 2 of 2 |
| kept, over a socket replaced under it on the same port | 5 s | 1.2 to 3.9 s | 6 of 6 |
| kept, the remote on this stack | 10 s | 5.5 to 5.8 s | 2 of 2 |
| kept, the remote on libdatachannel | 10 s | not within 40 s | 0 of 2 |
| kept | 20 s | 11.2 s in the one run that lasted | 1 of 6 |
| kept, with the port changed | 5 s | 26 s to this stack, not within 40 s to libdatachannel | 2 of 4 |
| nothing | 5 s or 20 s | not while it was watched, 40 to 60 s: the download goes on over uTP alone | 0 of 8 |

So the connections are not kept. A remote on libdatachannel ended its side 12.7 to 13.7 s into the silence (5
runs), also when the relay was back by then; this stack failed a connection 22.9 to 23.3 s into it (6 runs);
and one that does last waits for SCTP's backed off resend. A new socket takes any port because a remote on this
stack still routes the old address and port to its old connection until that one fails.

The uTP bytes moved again on the engine's own, 3.4 to 6.2 s after the relay was back, in 42 of 42 runs with the
ports kept (30 with the relay away 20 s, 12 with 5 s). Before patch 0015, 2 of 83 such runs had no uTP byte
within the 40 s watched. The one that kept the seed's alerts shows the seed taking the redial and ending it at
once, as it does when it has dropped the reset ([above](#when-the-relay-goes-away)); the rig did not record the
reset then, and does now (`utpReset`, `utpResetAhead`). In 5 of the 30 runs at 20 s this end had sent a packet
into the outage with nothing done to make it, which is the case the reset's number decides.

What it costs: the new swarm has new tracker ids and an empty memory, so a remote that stayed silent is tried
once more, and each remote keeps its end of the old connection until its own stack gives it up.

### What it promises

- **It contacts nothing on its own.** No tracker and no STUN host is built in: `trackers` and `iceServers` are the
  caller's, and both are empty when left out. `DEFAULT_TRACKERS` (`wss://tracker.openwebtorrent.com`,
  `wss://tracker.webtorrent.dev`) and `DEFAULT_ICE_SERVERS` (`stun:stun.l.google.com:19302`) are constants to
  pass, or not. Each host that is passed sees the person's IP address, and a tracker also sees which torrents run.
- **A torrent is announced to its own `ws` and `wss` trackers and to the ones passed.** A private torrent only to
  its own. A magnet whose private flag is not known yet: with `relay`, only to its own until the metadata says
  it is not private; without, to the passed ones too, which are told `stopped` once if the metadata says private
  ([the direct mode](#the-direct-mode)).
- **A tracker name that is the person's own machine or network is never opened**: `localhost`, a name with no dot,
  `.local`, and loopback, private, shared and link-local addresses. A browser asks permission before such a socket.
- **Only running torrents.** One that is paused, queued, in error or removed is told `stopped` and its attempts
  are closed. One that is checking is not started, and one that starts checking while it runs makes and takes
  no new connection and keeps what it has, except what a magnet whose metadata says private had at the passed
  trackers ([the direct mode](#the-direct-mode)): the engine checks for a moment when a magnet's metadata
  arrives, with its peers kept, and closes them itself for a recheck.
- **An empty swarm costs no connection.** The first announce carries no offer; offers follow the count in the
  tracker's reply, and a seeding torrent makes none and only answers.
- **The first seconds wait for nothing.** The offers go out as soon as the first reply names somebody and their
  descriptions are read, and an offer that arrives while there is room is answered as soon as ours is read: no
  interval and no timer of the swarm's sits in between. In a swarm of libtorrent 2.1 peers (qBittorrent) the
  first batch is most of what a session gets, since the first one that connects passes our address on and the
  others then have no use for our channels.
- **One channel per remote per torrent.** A remote is the peer id of its tracker messages, which for a libtorrent
  2.1 peer is never the id in its BitTorrent handshake, so the two are never compared. An open channel wins: an
  offer or an answer that arrives from its remote opens nothing beside it. Of an offer of ours and one of theirs
  that cross, both ends keep the one from the smaller tracker id. The attempt that loses is closed at our end
  every time: it is never left for the remote to close.
- **A remote that never says a word is left alone.** When a channel that opened ends before a single byte came
  from its remote, the remote's offers are not answered and its answers not taken for 10 minutes, and with
  `relay` no channel from its address is taken either. That is how a libtorrent 2.1 peer that will not talk to
  this address looks: it answers, the channel opens, and nothing comes. Chrome 156 and libdatachannel see it end
  the channel as it opens, 0 to 1 ms later in Chrome; the reference client's stack sees it stay open until
  libtorrent's handshake timeout ends the stream, 10.4 to 12.7 s later. Both count. A remote that sent one byte
  never does, nor does a channel the swarm closed itself, nor a stream the engine let go without reading it.
  `snapshot()` counts these remotes per torrent (`silent`), so an interface can tell peers that refuse this
  address from nobody being there.
- **Its ids have the shape a libtorrent 2.1 peer reads.** The peer id and every offer id are exactly 20 bytes,
  each sent as a JSON string of one character for each byte. One message of another shape makes a 2.1.1 peer
  drop its tracker socket for up to a minute.
- **A connection is closed 5 ms after its last signalling step, or later**, however its link ended; its channel
  is closed at once. Chromium keeps one of the page's 500 slots for a connection closed sooner, until the frame
  is gone. The wait is a timer in the thread the connection lives in, and it is the page half's only timer: a
  hidden page runs it late, which only closes the connection later.
- **A connection the WebRTC class will not make is no error.** It means there is no slot now: the attempt ends,
  `snapshot().unmade` counts it, nothing more is asked of the class until the next announce goes out, and that
  announce tries again.
- **Queues are bounded in both directions**, and `write()` on a stream never throws. A stream sets `backpressure`
  and no `maxRecvQueue`: how much may sit unread in the engine is `addPeerStream`'s own number.
- **It keeps looking.** A torrent that found nobody is announced again at the tracker's interval for as long as it
  runs, and `snapshot()` says what each tracker last answered, when a peer last connected and how many remotes
  stayed silent, so an interface can say "no peers yet, still searching" and take it back.

### What it refuses

- Trickle ICE, scrape and TURN: the tracker protocol has no message for the first, the announce reply carries the
  counts, and there is no relay for the third.
- A tracker message that does not validate. It is dropped and counted (`snapshot().dropped`) and the socket stays
  open, since one socket serves every torrent.
- To tell the worker a remote's address when the connection lives in the page. `links.remoteAddress()` answers
  only where the WebRTC class is in the worker, which is where `relay: true` needs it.
- To store anything. Ids, counts and addresses live in memory and go with the session, and `snapshot()` names
  no address. With `relay` that includes where a torrent's ordinary peers are or were, which is read from
  `session.peers` and compared with the address a channel comes from, nothing else.

### Limits

| what | value |
| --- | --- |
| remotes a torrent is connected or connecting to | 20 |
| the same for a session | 60 |
| connections open or pending in a session, unanswered offers included | 80 |
| connections made in a minute | 40 |
| of each session-wide budget, kept free for the torrent being watched | 10, and 20 when the torrent asking is seeding |
| offers in one announce | 10, and never more than the tracker lists other peers |
| an offer nobody answered | closed after 50 s |
| an answered attempt that has not opened | closed after 30 s |
| an open channel nothing reads | closed after 10 s |
| an attempt whose description never comes | given up after 10 s |
| a remote whose channel closed | not answered for 60 s |
| a remote whose channel opened and ended before it had sent a byte | not answered, and its answers not taken, for 10 min |
| remotes a torrent leaves alone at one time | 200, then the oldest is forgotten |
| with `relay`, a channel whose remote address is or was an ordinary peer of the torrent in this session | closed |
| with `relay`, the addresses of ordinary peers a torrent remembers | 1000, then the oldest is forgotten; read every 10 s and when a channel opens |
| after the WebRTC class refuses a new connection | nothing is made until the next announce |
| when a connection is closed | 5 ms after its last signalling step, or later |
| our peer id, and each offer id | exactly 20 bytes |
| when a local description is read | gathering complete, or 300 ms after the first reflexive candidate, or 3 s |
| announce interval | the tracker's, kept within 60 to 600 s; 120 s until it answers |
| a lost tracker socket | opened again after 10 s, doubling to 10 min, plus up to a quarter |
| a stream's send queue | stops at 1 MiB, resumes at 256 KiB, in messages of 16 KiB or the remote's limit if smaller |
| what a stream keeps before anything reads it | 1 MiB |
| bytes the page has passed to a worker that has not taken them yet | 32 MiB, then the page closes the link |
| a tracker message | 128 KiB, its SDP 64 KiB |

`limits` overrides the first four.

### What it reads from the session

`webtorrentPeers` takes the engine's `Session` as it is (`SwarmSession` names the members it uses). It reads
them once a second, and at once when `refresh()` is called:

| member | what the swarm takes from it |
| --- | --- |
| `torrents()` | the handle of every torrent |
| `infohash(handle)` | what it announces. Null until the session's alerts were pumped: the torrent waits |
| `status(handle)` | whether the torrent runs (not paused, no error), whether it is checking, whether its metadata is known, the bytes still wanted and the payload this session moved. Null until a status was pumped: the torrent waits |
| `isPrivate(handle)` | a private torrent is announced to its own trackers only, and with `relay` so is one whose flag is not known yet |
| `webSocketTrackers(handle)` | the torrent's own `ws` and `wss` trackers |
| `hasStreamWindow(handle)` | a torrent somebody is reading is served before the others. A window planned with `deadlines: false`, a save, is not that |
| `addPeerStream(handle, socket)` | hands libtorrent an open stream as a peer. When libtorrent gives a peer up it destroys the stream: one it had read and that never delivered a byte counts its remote as silent |
| `peers(handle)` | only with `relay: true`: the torrent's ordinary peers, by `endpoint`. Asked every 10 s for each running torrent, and when a channel opens |

The swarm asks for no status and pumps no alert: both stay with the session's owner (`postStatus`,
`popAlerts`), and what the swarm sees is what was pumped last. `refresh()` right after a pump, or after a
torrent was removed, makes it act on that at once.

### What the WebRTC class has to have

`rtcLinks` and `servePeerLinks` take one shape, `PeerConnectionLike`, and three classes fit it as they are, with
no cast: the platform's `RTCPeerConnection`, the one of `@banou/ponyfill`, and the one a factory of
`libtorrent-wasm/webrtc` makes. They use these members and nothing else: the constructor with `{ iceServers }`,
`createDataChannel`, `createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription`,
`localDescription.sdp`, `iceGatheringState`, `connectionState`, `close`, and the handlers `onicecandidate`,
`onicegatheringstatechange`, `onconnectionstatechange` and `ondatachannel`. `sctp` may be absent or null; where
it is there, it has `maxMessageSize` and `transport.iceTransport.getSelectedCandidatePair()`, whose remote
address is what `relay` compares. Of the channel: `binaryType`, `readyState`, `bufferedAmount`,
`bufferedAmountLowThreshold`, `send`, `close`, and the handlers `onopen`, `onmessage`, `onclose`, `onerror` and
`onbufferedamountlow`. A class that reports gathering complete as soon as its local description is set is read
at once.

### Tests

```sh
npm run vite-build && node --test "tests/webtorrent/*.test.mjs"
```

They need no browser, and `npm run test:ci` runs them with the engine's. Most run on in-memory stand-ins and
need no wasm. The rest use the reference tracker (`bittorrent-tracker`) on a loopback socket and libdatachannel
through `node-datachannel`, and skip themselves when its native module does not load. Two files need what
`npm run build` makes. `engines.test.mjs` is the direct mode whole, on the built engine: two sessions on
`offlineHost()`, a swarm over each, a file moved each way through the reference tracker, a magnet that names
no tracker found through a passed one, a magnet that turns out private and leaves the passed tracker, a
private torrent that no passed tracker hears of, and every ask an engine makes of its host counted.
`relay.test.mjs` is the relay mode whole, on the built engine and the built WebRTC entry: sessions over real
loopback sockets with the entry's class under the swarm, a file moved each way, one torrent fed by a TCP peer
and a WebRTC peer at once, the channels of an address that is or was an ordinary peer closed unheard, the
entry against libdatachannel, and a relay outage through `tests/rig/rel-outage.mjs`. `types/classes.ts` is
compiled, never run: the three classes against `rtcLinks` as built. Nothing in them reaches a public tracker
or a public peer.

## Building

```sh
npm ci
npm run build       # make-docker, copy-wasm, then build:webrtc (webrtc-wasm, vite-build, types)
npm run test:ci     # the engine's tests and tests/webtorrent
npm run test:webrtc # the WebRTC entry's tests, with the system Chrome
```

The engine compiles inside Docker (`make-docker`: emsdk, boost and libtorrent with `patches/` applied, into
`dist/`), so it asks nothing of the host but Docker and Node. The WebRTC entry's wasm is Rust and compiles on
the host with cargo through rustup ([its section](#building-it) says what that needs); on NixOS,
`nix shell nixpkgs#rustup -c npm run build`. `vite-build` and `types` then write every entry into `build/`,
which is what the package ships.

The tests need Node 24 or later. Node 22 holds a whole test file to `--test-timeout`, where 24 holds each test
to it, and four files run to the 60 s the scripts give or past it: on 22.23.4 `npm run test:ci` ends with three
or four of them cancelled.

`./build.sh` is the engine alone, in one step: it builds the image and copies `dist/*` out.

For iterative C++ development:

```sh
npm install
npm run dev    # rebuilds dist/ + vite on change
```

After `dist/libtorrent.{js,wasm}` exists, the app harness can run:

```sh
cp dist/libtorrent.{js,wasm} src/app/
cd src/app
npm install
npm run dev    # vite dev server on :4560
```

## WebRTC over a socket you own (`libtorrent-wasm/webrtc`)

An optional entry, apart from the torrent engine: a WebRTC data channel stack
([str0m](https://github.com/algesten/str0m) 0.25.0, compiled to wasm) behind a
class shaped like `RTCPeerConnection`, whose every packet goes out through a UDP
socket the caller hands it. The browser's own `RTCPeerConnection` sends its
packets itself, from the device's address. With this one a peer sees the address
of the socket, so code written against `RTCPeerConnection` can take either
constructor. In TypeScript that code types the constructor as
`WebRTC['RTCPeerConnection']`, which the platform's own fits too; the entry's
does not fit `typeof RTCPeerConnection`, the type of the whole platform class.

```js
import { createWebRTC } from 'libtorrent-wasm/webrtc'

const webrtc = await createWebRTC({
  socket,          // dgram-shaped and already bound: send(bytes, port, address), 'message', 'error', 'close'
  address, port,   // the public IPv4 address and port at which peers reach that socket
})
const pc = new webrtc.RTCPeerConnection()
const channel = pc.createDataChannel('data')
await pc.setLocalDescription()
// once iceGatheringState is 'complete': send pc.localDescription, then set the peer's answer
webrtc.close()
```

It runs on one thread, in a page, a worker or node, and needs no cross-origin
isolation. It imports nothing: not `@fkn/lib`, not a node module, and nothing of
the engine. The wasm is fetched from beside the module; a bundler that moves
files passes it as `wasm` (`libtorrent-wasm/webrtc.wasm` resolves to it). So
does node, whose `fetch` reads no file: there `wasm` is the file's bytes. In
TypeScript node's `dgram.Socket` and the socket of `@fkn/lib/dgram` fit `socket`
as they are.

### What it stands in for

Events arrive through `addEventListener` and through the `on` handlers alike.

- **`RTCPeerConnection`**: `new RTCPeerConnection(config)` (`iceServers` is
  accepted and ignored: the one candidate is the pair the factory was given, and
  no STUN server is asked), `createDataChannel`, `createOffer`, `createAnswer`,
  `setLocalDescription`, `setRemoteDescription`, `localDescription`,
  `remoteDescription`, `iceGatheringState` with `icegatheringstatechange` and
  `icecandidate` (the host candidate, then `null`; the description carries the
  candidate from the start), `connectionState` with `connectionstatechange`,
  `ondatachannel`, `sctp.maxMessageSize`, `close()`, and
  `sctp.transport.iceTransport.getSelectedCandidatePair()`, which answers
  `{ remote: { address, port } }`, where the peer is reached, and nothing else of
  the platform's pair; it is `null` until ICE has chosen, and again once the
  connection is `closed` or `failed`.
- **`RTCDataChannel`**: `label`, `readyState`, `binaryType`, `send` (a string, an
  `ArrayBuffer` or a view), `bufferedAmount`, `bufferedAmountLowThreshold` with
  `bufferedamountlow`, `close()`, and `open`, `message`, `error`, `close`.
- **The errors are Chrome's**, compared with Chrome 156 by a test. `send` throws
  `InvalidStateError` unless the channel is open, `TypeError` over
  `sctp.maxMessageSize`, and `OperationError` once 16 MiB is queued, after which
  the channel goes on. `setRemoteDescription` rejects with `OperationError` for
  text that is not SDP, `InvalidAccessError` for a description the stack refuses
  (which ends the connection), `InvalidStateError` out of order.
- **Every connection of a factory shares the one socket.** A datagram from a new
  address goes to the connection whose ICE user name it carries; one that belongs
  to none is dropped and counted in `droppedDatagrams`. The socket's `error` or
  `close` ends every connection.
- **The socket is handed at most 128 datagrams in one task, and 256 within one
  millisecond**, over all its connections; what is ready beyond that waits and
  follows in order, 128 a millisecond. A task is told from the next by the
  microtasks running in between, so it holds for a socket that delivers its
  datagrams from a task's own code, one at a time as node's dgram or many in a
  loop as @fkn/lib's; for one that delivers them from microtasks the clock alone
  counts. A window that opens all at once is about a thousand datagrams once
  `sendBufferSize` is 1 MiB or more, and libtorrent 2.1 ends a connection when
  it reads 1000 without its socket running empty: with the send buffer at 4 MiB,
  11 of 45 uploads of 256 MiB over a 50 ms round trip ended that way, none of
  93 with the bound (see the measurements). At the default send buffer a window
  is some 220 datagrams, and nothing ended early without the bound either. Only
  closing the factory hands the socket more: the last words of every
  connection, at once.
- **`connectionState` is `failed` at once** when the peer closes its connection
  or the socket goes, and 21.5 s after the peer goes quiet (measured). `closed`
  comes from `close()`, with no event, as on the platform.

### What it refuses

- Media, trickle ICE (there is no `addIceCandidate`), a second offer on a
  connection, TURN, mDNS names, IPv6 and TCP candidates.
- Channels that are not ordered and reliable, and `negotiated`, `id` and
  `protocol`: `NotSupportedError`. `binaryType` is `'arraybuffer'` only.
- An empty message: `NotSupportedError` (see the traps).
- Remote candidates whose address is not a public IPv4 address, unless
  `allowPrivateCandidates` is set: private, loopback, link-local, shared
  (100.64.0.0/10), documentation, benchmark, multicast and reserved addresses. A
  relay refuses a datagram to any of them and writes a log line for each, and ICE
  would send several a second.
- **A second connection between the same two sockets.** Only STUN names the
  connection it belongs to, so two connections whose packets come from one
  address and port cannot be told apart. Measured between two factories: the
  second stays `connecting`, the first is not disturbed. Once the first is
  closed, the next one between them connects. Browsers and libdatachannel use a
  port per connection, so it takes two peers that both use this module.
- A connection no peer ever reaches stays `connecting`: close it on a timeout of
  your own.

### Where a caller can tell it from Chrome

One script run against Chrome 156's own `RTCPeerConnection` and against this
entry, besides what the entry refuses:

- **A peer that closes its connection.** Here its channels get `close` alone and
  the connection is `failed` at once and for good. Chrome's channels get `error`
  (`OperationError`) and then `close`, and its connection reads `disconnected`
  about 5 s later.
- **After `close()` on a connection** its channels read `closing` at once and
  `send` throws `InvalidStateError`. Chrome's still read `open`, and `send`
  returns, until their `close` event.
- **A channel has no `closing` event.**
- **On the answering side** `connectionstatechange` to `connecting` fires before
  `setLocalDescription()` resolves. In Chrome it fires just after.
- **`send` takes a string, an `ArrayBuffer` or a view.** A `Blob`, or anything
  else, is a `TypeError`. Chrome sends a `Blob`, sends the text of anything else,
  and sends an empty message.
- **`sctp.maxMessageSize` is 262144 as soon as one description is set.** Chrome
  says `Infinity` until both are.
- **`bufferedamountlow` comes when the peer has acknowledged**, not when the
  bytes leave, so it can come after an event Chrome would fire it before. A
  message sent right before `channel.close()` gets none; Chrome fires one before
  `close`.
- **A description the stack refuses ends the connection** as `failed`. Chrome
  rejects with the same error and leaves the connection as it was.
- **Descriptions are set once.** Chrome also takes a second remote offer, a local
  description set twice, one whose text was edited, and makes an offer with no
  data channel. Here each of those rejects.

### Building it

```sh
npm run build:webrtc   # build/webrtc.wasm, build/webrtc.js, build/webrtc/*.d.ts
npm run test:webrtc
```

It needs cargo through rustup (`webrtc/rust-toolchain.toml` pins Rust 1.100.0 and
the `wasm32-wasip1` target), `tar` and `patch`. No Docker, no Emscripten and no C
compiler. On NixOS: `nix shell nixpkgs#rustup -c npm run build:webrtc`. `npm run
build` runs it after the engine.

`webrtc/patch-sctp-proto.mjs` runs first: it takes sctp-proto 0.10.8 from
crates.io (checked against the SHA-256 the lockfile held for it), unpacks it into
`webrtc/vendor/` (gitignored) and applies `webrtc/patches/*.patch`, where
`[patch.crates-io]` then finds it. Deleting a patch file takes its change out.

The tests are `node --test` on loopback and in-memory sockets: against
libdatachannel 0.24 (`node-datachannel`) in both roles, against itself, and
against the system Chrome, headless (`CHROME_BIN`, or the first Chrome on the
`PATH`; skipped when there is none). `WEBRTC_TEST_MIB=64` makes the transfer
tests 64 MiB each way instead of 16.

### Measurements

2026-11-13, Ryzen 7 9800X3D, node 26.12.1, Chrome 156.0.8078.47, libdatachannel
0.24.2, everything on loopback, 16 KiB messages, SHA-256 equal in every run,
three runs each (lowest to highest), with other work on the machine (load 2 to
5). `tests/webrtc/rig/bench.mjs` produces every row but those against
libtorrent 2.1, whose rig is described with them. In a `bench.mjs` row "50 ms"
holds each datagram 25 ms in each direction in a JavaScript timer: an
indication, not a network.

**Shipped sizes**

| file | raw | gzip -9 | brotli -q 11 |
| --- | --- | --- | --- |
| `build/webrtc.wasm` | 3,124,349 | 1,038,975 | 752,403 |
| `build/webrtc.js` | 33,053 | 10,567 | 9,272 |

**Release profile**, MiB/s with libdatachannel at the default send buffer. These
four were built before the build remapped source paths, which took 19,312 bytes
off the shipped file.

| profile | raw | brotli | to it | from it |
| --- | --- | --- | --- | --- |
| `opt-level = 3`, LTO (shipped) | 3,143,661 | 752,104 | 52.6 to 56.0 | 70.4 to 71.2 |
| `opt-level = "s"` | 2,317,979 | 618,516 | 45.8 to 46.4 | 58.9 to 60.2 |
| `opt-level = "z"` | 2,059,742 | 578,238 | 28.2 to 29.3 | 35.3 to 36.0 |
| `opt-level = "z"` and `wasm-opt -Oz` (binaryen 133) | 1,757,906 | 579,005 | 37.3 to 39.0 | 44.8 to 46.8 |

The stack holds one core at 100% at these rates, so size is paid for in speed:
the smallest build saves 173,099 bytes of brotli once per download and costs 30%
of the rate one way and 35% the other for as long as the page runs, and it would
put binaryen in every build. So `opt-level = 3`.

**Rates at the default send buffer** (256 KiB), MiB/s

| remote | to it | from it |
| --- | --- | --- |
| libdatachannel 0.24.2, we offer | 43.2 to 54.2 | 58.6 to 70.5 |
| libdatachannel 0.24.2, it offers (two runs) | 48.7 to 53.5 | 59.6 to 67.3 |
| Chrome 156 | 44.0 to 52.8 | 56.6 to 71.4 |
| itself, both ends on one thread of a dedicated worker in Chrome | 34.1 to 34.4 |  |

**Bursts**: what the bound of 128 datagrams a task is for, and what it costs

Toward a libtorrent 2.1 peer the window is that peer's receive window, 1 MiB,
about 1000 datagrams, and a write into an idle connection sends all of it at
once. The libjuice inside libtorrent 2.1 (libdatachannel 0.24.1) reads at most
1000 datagrams each time it wakes and takes reaching that number for a failed
socket: it fails ICE, and the peer is dropped with no warning in its log.
libdatachannel 0.24.3 has that fixed; no libtorrent release carries it yet.

Measured against the libtorrent 2.1.1 wheel in private network namespaces, with
netem for the round trip, this entry over node's dgram as our end and the
torrent engine writing into the channel (it waits above 1 MiB queued and goes on
at 256 KiB). Each run is one upload of 256 MiB with the send buffer at 4 MiB,
runs with and without the bound alternated, two at a time (one at a time with
no delay):

| round trip | bound | runs | ended early | MiB/s, median (lowest to highest) | most datagrams in one task | within 1 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 50 ms | with | 21 | 0 | 11.89 (11.83 to 11.99) | 128 | 256 |
| 50 ms | without | 10 | 0 | 11.93 (11.61 to 11.99) | 1009 | 965 |
| 100 ms | with | 10 | 0 | 7.41 (6.11 to 7.42) | 128 | 256 |
| 100 ms | without | 4 | 1 | 7.41 (7.40 to 7.41) | 1007 | 965 |
| none | with | 10 | 0 | 35.42 (33.09 to 35.71) | 128 | 256 |
| none | without | 4 | 0 | 35.16 (11.44 to 36.00) | 1026 | 728 |

A task is one callback of node's event loop with its microtasks. Each early end
has libjuice's failure in the 2.1 peer's own log, and nothing before it. The
lowest figures at 100 ms and with no delay are runs beside other work on the
machine (load up to 8). Two counts can meet, so 256 datagrams can leave within
a millisecond. A capture on the wire, before the delay and after it, reads the
same as the counts our end keeps: with the bound 256 within a millisecond, and
128 back to back before the delay and 256 after it; without it 817 within a
millisecond, 1009 back to back, and five or six runs of 1000 or more in one
upload. At the default send buffer the window is some 220 datagrams: 4 uploads
at 50 ms without the bound handed the socket at most 224 in a task, and none
ended early.

These runs are on the code as it is, and an early end is a matter of chance:
over the whole day in this rig, 11 of 45 uploads at 50 ms without the bound
ended early (4 of 15, 5 of 10, 2 of 10 and none of 10 in four batches) and 1 of
13 at 100 ms; with a bound of 128, none of 93 at 50 ms and none of 34 at
100 ms. Of those, 46 and 14 were made with the count started again at each
datagram's arrival, which on node's dgram is the same thing, and 26 and 10 with
a task told by a message to itself (see the traps). Downloads of 256 MiB at
50 ms are the same either way, 5 runs each: 1.07 MiB/s (1.04 to 1.09) over the
3 that completed with the bound and 1.10 (0.97, 1.23) over the 2 without, the
rate libtorrent 2.1 falls to as a sender behind a round trip, with the others
still connected and unfinished after 300 s (at 211 to 248 MiB); our end sends
at most 38 datagrams in a millisecond there.

**A socket that delivers many datagrams in one task.** node's dgram delivers
each datagram in a callback of its own. @fkn/lib's dgram does not: what one task
hands it leaves together, and every datagram of one port message arrives in one
loop, in which the clock moves. Two factories in memory over a model of that
socket, each batch held 25 ms each way, 64 MiB up, three runs each: the most
datagrams that left together

| send buffer, and when the writer goes on | the bound as shipped | counted again at each arrival | no bound |
| --- | --- | --- | --- |
| 4 MiB, at 256 KiB (it waits above 1 MiB) | 128 | 516 | 736 |
| 4 MiB, at 4 MiB | 128 | 1012 | 1012 |
| 1 MiB, at 1 MiB | 128 | 1012 | 1012 |
| 256 KiB (default), at 256 KiB | 128 | 257 | 257 |

Every run of a row read the same number. With the count started again at each
arrival, 64 batches of an upload were of 900 datagrams or more in the second and
third rows, as with no bound. The rates with the bound as shipped were the same
or better: 9.63, 16.11, 16.12 and 4.61 MiB/s down the rows, against 9.56,
10.58, 10.45 and 4.31. It is a model, not the relay: how many datagrams one
port message carries on the real path has not been measured.

**The send buffer** (`sendBufferSize`), MiB/s from us to the remote, measured
again on the code as it is: three runs each at load 2 to 4. The last column is
from before the count went by tasks, with eight busy loops beside the run (load
5 to 18)

| send buffer | libdatachannel | libdatachannel, 50 ms | Chrome | Chrome, 50 ms | Chrome, 50 ms, busy machine |
| --- | --- | --- | --- | --- | --- |
| 256 KiB (default) | 52.3 to 54.6 | 4.5 to 4.6 | 49.9 to 52.3 | 4.5, 4.5, 4.5 | 4.5, 2.5, 3.9 |
| 512 KiB | 43.6 to 46.6 | 8.1 to 8.2 | 40.9 to 44.3 | 4.0, 6.1, 8.1 | 1.6, 1.6, 1.6 |
| 1 MiB | 32.4 to 32.7 | 12.3 to 12.4 | 32.7 to 34.0 | 1.6, 4.4, 5.1 | 2.6, 2.1, 1.1 |
| 2 MiB | 31.5 to 33.5 | 12.3 to 12.4 | 21.7 to 21.8 | 1.5, 3.7, 4.6 |  |
| 4 MiB | 31.4 to 32.9 | 12.0 to 12.4 | 12.4 to 13.3 | 2.5, 4.1, 4.5 |  |

Without the bound the picture was the same in every column when both were
measured, before the count went by tasks. Toward libtorrent 2.1 in the rig
above, where the delay is a real one, 256 MiB each run, with the bound, median
(lowest to highest):

| send buffer | 50 ms | 50 ms, writer that goes on at the buffer's size | 100 ms | no delay |
| --- | --- | --- | --- | --- |
| 256 KiB (default) | 4.55 (4.55 to 4.59) | the same writer | 2.35 (2.33, 2.38) | 46.40 (46.25 to 48.18) |
| 512 KiB | 8.04 (7.14 to 8.05) | 7.95 (7.78 to 8.14) |  |  |
| 1 MiB | 11.90 (11.78 to 11.92) | 16.80 (16.67 to 16.93) | 7.36 (7.36, 7.36) | 34.23 (33.18 to 34.63) |
| 2 MiB | 11.83 (11.78 to 11.91) | 18.88 (17.05 to 18.90) |  |  |
| 4 MiB | 11.89 (11.83 to 11.99), 21 runs | 19.09 (14.88 to 19.16) | 7.41 (6.11 to 7.42), 10 runs | 35.42 (33.09 to 35.71), 10 runs |

The 512 KiB and 2 MiB rows, and the 100 ms and no delay cells of the 256 KiB and
1 MiB rows, are from before the count went by tasks; every other cell is on the
code as it is.

The buffer is the window: at most that much is in flight, so the rate is at most
the buffer per round trip (5 MiB/s at 50 ms for 256 KiB, 4.55 measured), up to
what the peer's own window takes. Toward libtorrent 2.1 and libdatachannel every
step up is faster behind a round trip, and with the bound a large buffer no
longer sends a thousand datagrams at once. Toward Chrome it is not faster:
512 KiB held 8 MiB/s on a quiet machine and fell to 1.6 on a busy one, three
runs of three (0.8 and 1.5 in two runs before the bound), and every size above
it was erratic on a quiet one. The bound changes none of that, and at 1 MiB and
4 MiB a bound of 64 or 32 datagrams a millisecond was as erratic. Without delay
the smallest buffer is the fastest. So the default stays 256 KiB, the size whose
rate depended least on the peer and on the machine; it is also the least the
option takes, the largest message. A caller whose peers are libtorrent can
raise it.

**How much the writer keeps queued** matters from 1 MiB up. When the writer lets
`bufferedAmount` fall below the send buffer before it writes again, the stack's
buffer runs empty and the window is part empty for a round trip: at 1 MiB a
writer that went on at 256 KiB had 11.90 MiB/s at 50 ms and one that went on at
1 MiB had 16.80; at 4 MiB it is 11.89 against 19.09. So
`bufferedAmountLowThreshold` is the send buffer's size or more. At the default
there is nothing to gain: 4.55 MiB/s is the window.

**The two sctp-proto patches**, MiB/s with libdatachannel

| sctp-proto 0.10.8 | to it, 256 KiB buffer | to it, 1 MiB buffer | from it, 50 ms |
| --- | --- | --- | --- |
| as published | 33.9 to 36.5 | 12.9 to 13.4 | 0.7 to 0.9 |
| with `0001` (no expiry walk without a lifetime) | 44.4 to 55.2 | 29.6 to 33.3 | 0.6 to 1.1 |
| with `0002` (acknowledge after 20 ms, not 200) | 31.9 to 34.8 | 12.3 to 13.2 | 4.2 to 9.6 |
| with both (shipped) | 52.1 to 55.5 | 30.0 to 33.5 | 4.4 to 9.6 |

`0001`: upstream walks every chunk in flight on every poll to look for expired
messages, which reliable channels never have. `0002`: libdatachannel acknowledges
after 20 ms itself, and a libdatachannel sender behind a round trip is several
times slower toward a receiver that waits 200.

**A third patch that was measured and not taken: Max.Burst.** RFC 9260 (6.1 D)
has a sender stop after Max.Burst packets (4) at each occasion to send, and
sctp-proto has no such limit. Three forms of it were built and run beside the
bound in the wrapper, in the rig above at 50 ms, three runs each, three at a
time:

| what bounds a burst | MiB/s, median (lowest to highest) | most datagrams in one task | within 1 ms |
| --- | --- | --- | --- |
| nothing | 8.68 (7.34 to 11.97) | 1009 | 960 |
| the wrapper, 128 at a time (shipped) | 11.80 (11.57 to 11.98) | 128 | 256 |
| the wrapper, 64 at a time | 11.75 (11.67 to 11.82) | 64 | 128 |
| Max.Burst opened by a packet from the peer, a write, a T3-rtx expiry and every timer call | 8.23 (8.18 to 8.25) | 269 | 305 |
| the same without the timer call | 8.25 (8.11 to 8.25) | 269 | 304 |
| Max.Burst opened by a packet from the peer and a T3-rtx expiry alone | 2.48 (2.47 to 2.49) | 5 | 84 |
| the second form with the wrapper's bound | 8.26 (8.23 to 8.36) | 128 | 256 |
| the third form with the wrapper's bound | 2.45 (2.45 to 2.48) | 5 | 84 |

A burst that a write opens is four datagrams for each write of a task, so it
grows with what the caller writes: 269 here, 541 with a writer that waits above
2 MiB. One that only the peer opens is a slow start after every pause of the
writer, and this writer pauses several times a second. Opening one on every
timer call changed neither the rate nor the counts. The bound in the wrapper
holds whatever is written and whichever timer fires, and costs no rate, so no
third patch is carried. 64 at a time was as fast here; 128 leaves more room
above the 50 datagrams a millisecond the stack makes at its fastest on this
machine.

### Traps

Each of these was found by getting it wrong.

- **str0m's own `rust-crypto` feature pulls a C library.** It turns on dimpl's
  `rcgen` feature, which is `["dep:rcgen", "aws-lc-rs"]`. The crate depends on
  str0m with no feature and on dimpl with `rust-crypto` alone, carries a copy of
  str0m's provider (`webrtc/src/provider`), and takes its certificate from
  WebCrypto. `cargo build --locked` and `tests/webrtc/build.test.mjs` fail when
  that changes.
- **Every call that changes a connection is followed by a full drain of
  `poll_output`**, before the next one. That is str0m's one contract, and breaking
  it still passes every hash check. The wrapper makes each change an operation
  with its drain; a test reads the order of the calls into the wasm.
- **A description is followed by a timeout input.** str0m's ICE agent schedules
  nothing until it has been told the time once, so an answering side would wait
  for the peer's first check for ever.
- **`wasm32-wasip1`, not `wasm32-unknown-unknown`**: str0m reads the clock itself.
  The six WASI calls it imports are written by hand in `src/webrtc/wasi.ts`.
  rustup reads `rust-toolchain.toml` from the working directory, never from a
  `--manifest-path`.
- **str0m refuses a message larger than its free send buffer**, which defaults to
  128 KiB, so the send buffer is never below the largest message (262144).
- **A write str0m refuses waits for the next input.** The wrapper counts what the
  stack holds and asks for no write there is no room for, but the stack also
  counts the message that opens another channel, which cannot be measured from
  outside. Asked again at once the write is refused for ever, in a loop that
  never yields.
- **str0m 0.25.0 takes an empty message and sends nothing**, and the channel then
  waits for ever on the sequence number it used up. `send` refuses one.
- **Reading the buffered amount goes through `&mut Rtc`**, which the contract
  counts as a change. It only marks the next poll to look at everything, and
  draining after it cost 8 to 14% of the upload rate, so that one read is not
  drained.
- **`bufferedAmount` counts until the peer acknowledges**, because the stack holds
  the bytes until then. The platform stops counting when they leave.
- **A peer closing its connection arrives as one event for the connection**, with
  none for its channels: the wrapper closes them. A peer closing only its channel
  does arrive as that channel closing, and the connection stays up.
- **Rust writes the absolute path of every source file into its panic messages.**
  Unremapped, the wasm named 152 files under the cargo directory of the machine
  that built it. `RUSTFLAGS` in the `webrtc-wasm` script remaps them, and a test
  reads the wasm for any that is left.
- **tar keeps the times a crate's archive gives its files, which are from 2006**,
  and cargo builds a crate again only when one of its files is newer than its
  last build. Unpacked that way, taking the last patch out left the patched wasm
  in place with exit 0. The script unpacks with `-m`.
- **node's dgram sends nothing until the task ends.** An unconnected `send` to an
  address goes through `dns.lookup`, which answers on `process.nextTick`, so
  everything one task hands the socket reaches the kernel together: 1009
  datagrams back to back, 968 of them within one millisecond, measured.
- **The stack sends a whole window at once.** sctp-proto 0.10.8 has no Max.Burst
  (RFC 9260, 6.1 D): a write into an idle connection sends all the window
  allows, and each T3-rtx expiry sends everything outstanding again. The bound
  on the socket is what spreads both.
- **The clock moves inside a task**, and what one task hands a socket can leave
  together: a count that starts again by the clock alone lets one long task hand
  over a millisecond's worth many times before any of it leaves.
- **An arrival is not where a task begins.** node's dgram delivers each datagram
  in a callback of its own, but @fkn/lib's delivers every datagram of a port
  message in one loop. With the count started again at each arrival, a whole
  window of 1012 datagrams left at once over a model of that socket. So the
  count starts again only where the socket has been handed nothing since the
  microtasks last ran, on an arrival or on a timer. Not on a timer alone: a
  page whose timers are held back would send 128 datagrams a second.
- **A message to itself is too coarse a sign of a new task in node.** node
  delivers it once in a turn of its loop, in which it reads up to 32 datagrams,
  each in a callback that sends what it was handed. Counted that way nine
  arrivals in ten could not start the count again, datagrams waited up to 10 ms,
  and an upload to Chrome with a 1 MiB send buffer fell from 32 to 14 MiB/s on
  loopback. The microtasks run after each of those callbacks.
- **A test that proves a limit is a counted loop.** "Send until it throws" never
  ends once the limit is gone, and a loop that never yields is one no test
  timeout stops (`fill()` in `tests/webrtc/rig/local.mjs`).
- **On a Wayland desktop Chrome opens a window even when asked for none**, unless
  `WAYLAND_DISPLAY` and `NIXOS_OZONE_WL` are taken out of its environment.

## Patches

`patches/*.patch` carry the WASM-specific edits on top of pinned upstream
libtorrent. They're applied via `git apply` at build time (`make
apply-patches`). To rebase against a newer upstream, bump the submodule and
rerun `make apply-patches`; rejected hunks must be reconciled manually.

| Patch | What it changes |
| --- | --- |
| 0001 | The port itself: name lookups go to JS instead of a resolver thread, and there are no interfaces or routes to enumerate. |
| 0002 | The UDP read loop ends on the shim's "queue empty" instead of wedging the tick. |
| 0003 | WASI errno values (`EINPROGRESS` 26, `EAGAIN` 6) instead of Linux's. |
| 0004 | The minimum peer `request_timeout` is 30 s, so a fast peer is not snubbed by a stalled tick. |
| 0005 | TCP peers are no longer dropped when `m_socket.available()` is unsupported. |
| 0006 | The echoed uTP `timestamp_difference` is clamped to 1 us, which bypasses the peer's LEDBAT. |
| 0007 | The UDP drain takes WASI's `EAGAIN` for "queue empty" too, so the read is armed again. |
| 0008 | The uTP receive buffer capacity is a session-wide runtime setting. |
| 0009 | A late time-critical piece is rescued before the first one completes. |
| 0010 | `forget_pieces`, for a streaming storage that dropped a piece's bytes. |
| 0011 | Peer exchange neither sends local addresses, which mean nothing to a peer outside that network, nor takes them from a peer. That covers the addresses `addPeerStream` makes up, and the local addresses a stream peer could otherwise name for the engine to dial. |
| 0012 | A peer's `reqq` lowers the request queue and never raises it past `max_out_request_queue`, so no peer is asked for more than 5000 blocks at once, 78 MiB. The receive bound of a peer stream is sized from that. |
| 0013 | A peer the engine dialled on an `addPeerStream` address is read as having no `ut_holepunch`, so no holepunch message goes to it and none from it is acted on. Asked for a rendezvous, a libtorrent 2.1 remote tells the peer we could not reach our address, and that peer then leaves our stream to it silent. Asked by one, the engine would tell an ordinary peer to connect to the made-up address. A peer that dialled in from `100.64.0.0/10` is an ordinary one and keeps its holepunch. |
| 0014 | A uTP socket names the last sequence number it received, which the reset sent when the relay comes back has to acknowledge for a libtorrent remote to take it. |
| 0015 | A uTP reset is numbered at the first packet its remote has not acknowledged, where upstream numbers it at random. A libtorrent remote drops a packet numbered past its reorder window before it reads the type, which is half of all numbers. |
