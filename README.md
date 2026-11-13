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
whole torrent, and the selection is persisted into resume data.

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
  memory), resume data is written and loaded without it, peer exchange does
  not send it (patch 0011), and a holepunch message carries it only back to a
  peer that named it (patch 0013).
- No address is given twice before all 4,194,304 have been used.
- The peer list shows the peer with `transport: 'webrtc'` and an `endpoint`
  that is not an address, and `reachable().inbound` never counts it.

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

## WebRTC peers

Two optional entries find WebRTC peers through WebSocket trackers and hand each open data channel to libtorrent as
a peer. The engine itself does not import them, and neither carries any wasm.

| entry | where it runs | what it is |
| --- | --- | --- |
| `libtorrent-wasm/webtorrent` | the engine worker | the tracker client, the swarm's rules, and the links to a WebRTC implementation |
| `libtorrent-wasm/webtorrent/page` | the page that owns the worker | makes the browser's peer connections for the worker and carries their bytes over one `MessagePort` |

A worker has no `RTCPeerConnection` in any browser, so with the browser's own WebRTC the connections are made in
the page and every decision stays in the worker:

```js
// the engine worker
import { webtorrentPeers, pageLinks, DEFAULT_TRACKERS } from 'libtorrent-wasm/webtorrent'

const { port1, port2 } = new MessageChannel()
postMessage({ type: 'peer-links', port: port2 }, [port2])
const peers = webtorrentPeers(session, { links: pageLinks(port1), WebSocket, trackers: DEFAULT_TRACKERS })
peers.onchange = () => postMessage({ type: 'peers', snapshot: peers.snapshot() })

// the page
import { servePeerLinks, DEFAULT_ICE_SERVERS } from 'libtorrent-wasm/webtorrent/page'

worker.addEventListener('message', ({ data }) => {
  if (data.type === 'peer-links') servePeerLinks(data.port, { RTCPeerConnection, iceServers: DEFAULT_ICE_SERVERS })
})
```

With a WebRTC stack that runs in the worker, the same signalling drives its class directly:

```js
import { webtorrentPeers, rtcLinks, DEFAULT_TRACKERS } from 'libtorrent-wasm/webtorrent'

webtorrentPeers(session, {
  links: rtcLinks({ RTCPeerConnection: StackPeerConnection }),
  WebSocket: RelayWebSocket,
  trackers: DEFAULT_TRACKERS,
  relay: true,
})
```

### What it promises

- **It contacts nothing on its own.** No tracker and no STUN host is built in: `trackers` and `iceServers` are the
  caller's, and both are empty when left out. `DEFAULT_TRACKERS` (`wss://tracker.openwebtorrent.com`,
  `wss://tracker.webtorrent.dev`) and `DEFAULT_ICE_SERVERS` (`stun:stun.l.google.com:19302`) are constants to
  pass, or not. Each host that is passed sees the person's IP address, and a tracker also sees which torrents run.
- **A torrent is announced to its own `ws` and `wss` trackers and to the ones passed.** A private torrent only to
  its own. A magnet whose private flag is not known yet is not announced to the passed ones until it is.
- **A tracker name that is the person's own machine or network is never opened**: `localhost`, a name with no dot,
  `.local`, and loopback, private, shared and link-local addresses. A browser asks permission before such a socket.
- **Only running torrents.** One that is paused, queued, checking or removed is told `stopped` and its attempts are
  closed.
- **An empty swarm costs no connection.** The first announce carries no offer; offers follow the count in the
  tracker's reply, and a seeding torrent makes none and only answers.
- **The first seconds wait for nothing.** The offers go out as soon as the first reply names somebody and their
  descriptions are read, and an offer that arrives while there is room is answered as soon as ours is read: no
  interval and no timer of the swarm's sits in between. In a swarm of libtorrent 2.1 peers (qBittorrent) the
  first batch is most of what a session gets, since the first one that connects passes our address on and the
  others then stay silent.
- **One channel per remote per torrent.** A remote is the peer id of its tracker messages, which for a libtorrent
  2.1 peer is never the id in its BitTorrent handshake, so the two are never compared. An open channel wins: an
  offer or an answer that arrives from its remote opens nothing beside it. Of an offer of ours and one of theirs
  that cross, both ends keep the one from the smaller tracker id. The attempt that loses is closed at our end
  every time, since a libtorrent 2.1 peer never closes its own.
- **A remote that never says a word is left alone.** When a channel that opened ends before a single byte came
  from its remote, the remote's offers are not answered and its answers not taken for 10 minutes, and with
  `relay` no channel from its address is taken either. That is how a libtorrent 2.1 peer that will not talk to
  this address looks: it answers, the channel opens, and nothing comes. Chrome 156 and libdatachannel see it end
  the channel within a millisecond of its opening; the reference client's stack sees it stay open until
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

### What the session has to provide

`webtorrentPeers` takes anything with this shape (`SwarmSession`):

| member | what it is |
| --- | --- |
| `addPeerStream(handle, socket)` | hands libtorrent an open stream as a peer; throws, or destroys the stream, when it cannot. When libtorrent gives a peer up it destroys the stream: one it had read and that never delivered a byte counts its remote as silent |
| `torrents()` | the handle of every torrent |
| `torrent(handle)` | `{ infoHash, trackers, running, hasMetadata, private, uploaded, downloaded, left, watched }`, or null |
| `on` / `off` | `add`, `remove`, `pause` and `resume`, each with the handle. Anything else is noticed within a second |
| `peers(handle)` | only with `relay: true`: the torrent's ordinary peers, by `endpoint`. Asked every 10 s for each running torrent, and when a channel opens |

`trackers` is `trackersOf(magnet or .torrent bytes)`: libtorrent drops `ws` and `wss` trackers when it parses
either, so they have to be read from what the torrent was added from.

### What the WebRTC class has to have

`rtcLinks` and `servePeerLinks` use these members of `RTCPeerConnection` and nothing else: the constructor with
`{ iceServers }`, `createDataChannel`, `createOffer`, `createAnswer`, `setLocalDescription`,
`setRemoteDescription`, `localDescription.sdp`, `iceGatheringState`, `connectionState`, `close`, the handlers
`onicecandidate`, `onicegatheringstatechange`, `onconnectionstatechange` and `ondatachannel`, and, where present,
`sctp.maxMessageSize` and `sctp.transport.iceTransport.getSelectedCandidatePair()`. Of the channel: `binaryType`,
`readyState`, `bufferedAmount`, `bufferedAmountLowThreshold`, `send`, `close`, and the handlers `onopen`,
`onmessage`, `onclose`, `onerror` and `onbufferedamountlow`. A class that reports gathering complete as soon as
its local description is set is read at once.

### Tests

```sh
npm run vite-build && node --test "tests/webtorrent/*.test.mjs"
```

They need no wasm and no browser, and `npm run test:ci` runs them with the engine's. Most run on in-memory
stand-ins. The rest use the reference tracker (`bittorrent-tracker`) on a loopback socket and libdatachannel
through `node-datachannel`, and skip themselves when its native module does not load. Nothing in them reaches a
public tracker or a public peer.

## Building

The full build runs inside Docker so the host needs nothing but Docker +
Node:

```sh
./build.sh     # one-shot: builds the image, copies dist/* out
```

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
