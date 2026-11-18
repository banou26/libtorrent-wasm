export interface LtModule {
  /** The host object the module was created with. Absent on a stub module. */
  fkn?: FknHost

  HEAPU8: Uint8Array
  HEAP32: Int32Array
  HEAPU32: Uint32Array

  _malloc(n: number): number
  _free(ptr: number): void
  stringToNewUTF8(s: string): number
  UTF8ToString(ptr: number, maxBytes?: number): string

  _lt_set_utp_receive_buffer(bytes: number): void
  _lt_set_dht(on: number): void
  _lt_set_listen_port(port: number): void
  _lt_session_create(): number
  /** 1, ending nothing, when called from inside _lt_session_tick. */
  _lt_session_destroy(): number
  /** How many handlers it ran. More than 0 means work may still be queued (a tick ends on its 100 ms budget), so tick again. */
  _lt_session_tick(): number
  _lt_session_pump_alerts(): void

  _lt_alerts_size(): number
  _lt_alerts_data(): number
  _lt_alerts_clear(): void

  _lt_session_set_rate_limits(downloadBps: number, uploadBps: number, limitLocalPeers: number): void

  _lt_session_add_magnet(magnet: number, savePath: number): number
  _lt_session_add_torrent_file(buf: number, len: number, savePath: number): number
  _lt_session_add_torrent_with_resume(buf: number, len: number, savePath: number): number
  _lt_session_remove_torrent(handle: number): number
  _lt_session_remove_torrent_ex(handle: number, deleteFiles: number): number

  _lt_torrent_pause(handle: number): number
  _lt_torrent_resume(handle: number): number
  _lt_torrent_force_recheck(handle: number): number
  _lt_set_log(on: number): void
  _lt_torrent_save_resume_data(handle: number): number

  _lt_torrent_status(handle: number, out: number): number
  _lt_torrent_post_status(handle: number): number
  _lt_torrent_post_peers(handle: number): number
  _lt_torrent_post_trackers(handle: number): number
  _lt_torrent_add_tracker(handle: number, url: number): number
  _lt_torrent_piece_availability(handle: number, out: number, count: number): number
  _lt_session_dht_nodes(): number
  _lt_torrent_infohash(handle: number, out: number): number
  _lt_torrent_infohash_v2(handle: number, out: number): number
  _lt_torrent_private(handle: number): number
  _lt_torrent_ws_trackers(handle: number): number

  _lt_torrent_set_sequential(handle: number, on: number): number
  _lt_torrent_set_flags(handle: number, flags: number, mask: number): number
  _lt_torrent_add_channel_peer(handle: number, ipv4: number, port: number): number
  _lt_torrent_force_reannounce(handle: number): number
  _lt_torrent_queue_position(handle: number, where: number): number
  _lt_torrent_set_upload_limit(handle: number, bytesPerSecond: number): number
  _lt_torrent_set_download_limit(handle: number, bytesPerSecond: number): number
  _lt_torrent_read_piece(handle: number, piece: number): number
  _lt_torrent_set_piece_deadline(handle: number, piece: number, deadlineMs: number, alertWhenAvailable: number): number
  _lt_torrent_clear_piece_deadlines(handle: number): number
  _lt_torrent_reset_piece_deadline(handle: number, piece: number): number
  _lt_torrent_prioritize_pieces(handle: number, priosPtr: number, count: number): number
  _lt_torrent_prioritize_piece_list(handle: number, piecesPtr: number, priosPtr: number, count: number): number
  _lt_torrent_prioritize_files(handle: number, priosPtr: number, count: number): number
  _lt_torrent_set_file_priority(handle: number, fileIndex: number, prio: number): number
  _lt_torrent_cancel_piece_requests(handle: number, piece: number): number
  _lt_torrent_forget_pieces(handle: number, piecesPtr: number, count: number, busyPtr: number): number
}

export type LtModuleFactory = (init?: Partial<{ fkn: FknHost; wasmBinary: ArrayBuffer }>) => Promise<LtModule>

/**
 * A TCP listener and a UDP socket the host bound on the relay, on the same port number, before the
 * session existed. The shim adopts both instead of binding its own, which is what lets libtorrent
 * announce a port that something is actually listening on. `backlog` parks connections that arrive
 * between the reservation and the adoption; `adopted` stops the reservation's own handler once the
 * shim has taken over. Null when the reservation could not be made.
 */
export interface PreboundSockets {
  port: number
  /**
   * Null when the paired TCP bind lost its draw. The announce is then anchored on the UDP port
   * alone, which still reaches every peer that dials uTP (all of them try it first), and inbound
   * TCP is dark for the session exactly as it was before any of this.
   */
  server: any | null
  udp: any
  backlog: any[]
  adopted?: boolean
  serverTaken?: boolean
  udpTaken?: boolean
}

/**
 * One open byte stream to a remote peer, as `Session.addPeerStream` takes it: the shape the socket
 * shim expects of a host socket, for a transport the engine does not open itself (a WebRTC data
 * channel, for one).
 *
 * The engine attaches its listeners when libtorrent dials, up to 10 s after `addPeerStream`, and
 * never removes them. Bytes that arrive before a `data` listener is attached must be held and
 * delivered in order once it is: the remote's handshake is usually among them.
 *
 * Events, through `on`: `data` (a `Uint8Array` or `ArrayBuffer`, copied by the engine before the
 * listener returns), `end` or `close` (the remote is gone), `error` (an `Error`; libtorrent reads a
 * reset), and `drain` (see `backpressure`).
 */
export interface PeerStreamSocket {
  on(event: 'data' | 'drain' | 'end' | 'close' | 'error', listener: (arg?: any) => void): unknown
  /**
   * Send `chunk`, which the socket now owns. One call carries up to about 512 KiB, so a transport
   * with a message limit slices it. The answer is read only with `backpressure`.
   */
  write(chunk: Uint8Array): boolean
  /**
   * Close the stream and whatever carries it. The engine calls it when libtorrent drops the peer,
   * when it was never dialled, and when `maxRecvQueue` is passed, with an `Error` in the last two
   * cases. It can be called more than once.
   */
  destroy(error?: Error): void
  /**
   * Set true by a socket that can say when to stop: after a `write()` that answered false the
   * engine writes nothing more until the socket emits `drain`. Left unset, every write is taken
   * whatever it answers, so the socket queues without bound behind a slow remote.
   */
  backpressure?: boolean
  /**
   * The unread bytes past which the engine destroys the stream, for a transport that cannot pause
   * its sender. `addPeerStream` sets it to 96 MiB when the socket does not: the 78 MiB of blocks
   * the engine may have asked one peer for, whatever request queue that peer advertises, and room
   * for the messages around them. A lower value closes a fast peer that did nothing wrong.
   */
  maxRecvQueue?: number
}

export interface FknHost {
  net: any
  dgram: any
  storage: StorageBackend | null
  prebound?: PreboundSockets | null
  /**
   * Set by the Session. The shim asks it at every connect to an address in 100.64.0.0/10: the
   * stream `addPeerStream` registered for that address, handed over once, or undefined.
   */
  takeStream?: (address: string) => PeerStreamSocket | undefined
  /** Turn on the transport and tick traces. Off by default: they run to hundreds of
   *  lines a minute on an ordinary download. */
  debug?: boolean
  /**
   * Optional. When supplied, the WASM resolver routes DNS lookups through
   * this function (typically @fkn/lib's dnsLookup, which tunnels via
   * WebVPN). When omitted, the module falls back to plain fetch against
   * 1.1.1.1's DoH JSON endpoint.
   */
  dnsLookup?: (hostname: string, opts?: { family?: 0 | 4 | 6 })
    => Promise<{ address: string; family: 0 | 4 | 6 } | { address: string; family: 0 | 4 | 6 }[] | undefined>
}

export interface StorageBackend {
  onNewStorage(id: number, savePath: string, files: Array<{ path: string; size: number }>): void | Promise<void>
  onRemoveStorage(id: number): void | Promise<void>

  read(id: number, fileIndex: number, offset: number, len: number): Uint8Array | Promise<Uint8Array>
  write(id: number, fileIndex: number, offset: number, bytes: Uint8Array): void | Promise<void>

  release?(id: number): Promise<void>
  check?(id: number): Promise<number>  // status_t - 0 = no_error
  move?(id: number, newPath: string): Promise<void>
  deleteFiles?(id: number, flags: number): Promise<void>
  rename?(id: number, fileIndex: number, newName: string): Promise<void>
  stop?(id: number): Promise<void>
}
