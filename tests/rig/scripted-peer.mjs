// A peer that dials the engine and speaks the wire protocol by hand, with the fast extension
// (BEP 6) and lt_donthave (BEP 54), so a test sees every message the engine sends it. Given a
// `socket` (one end of a stream the engine holds the other end of) it speaks over that instead.
// Given `metadata` it serves that too (BEP 9).

import crypto from 'node:crypto'
import net from 'node:net'

import { bdecode, bencode } from './make-torrent.mjs'
import { PROTOCOL } from './peer-handshake.mjs'

const MSG = {
  unchoke: 1, interested: 2, request: 6, piece: 7, haveAll: 14, haveNone: 15, reject: 16, extended: 20,
}
// the ids this peer asks the engine to use for the lt_donthave, ut_pex, ut_holepunch and ut_metadata messages it sends
const DONT_HAVE_ID = 7
const PEX_ID = 8
const HOLEPUNCH_ID = 9
const METADATA_ID = 10
// BEP 9
const METADATA_PIECE = 16 * 1024
// BEP 55
const HOLEPUNCH_TYPE = ['rendezvous', 'connect', 'failed']
/** pex flag (BEP 11 as libtorrent extends it): the named peer supports ut_holepunch. */
export const PEX_HOLEPUNCH = 0x08

const compactEndpoint = (endpoint) => {
  const [address, port] = endpoint.split(':')
  return Buffer.from([...address.split('.').map(Number), port >> 8, port & 0xff])
}

const frame = (id, payload = Buffer.alloc(0)) => {
  const b = Buffer.allocUnsafe(5 + payload.length)
  b.writeUInt32BE(1 + payload.length, 0)
  b.writeUInt8(id, 4)
  payload.copy(b, 5)
  return b
}

const u32s = (...values) => {
  const b = Buffer.allocUnsafe(4 * values.length)
  values.forEach((v, i) => b.writeUInt32BE(v, 4 * i))
  return b
}

/**
 * `serve` makes it a seed: it claims every piece, unchokes, and answers a request with the bytes
 * `serve(piece, offset, length)` returns, or never answers it when that is null. Without `serve`
 * it is a leech that has nothing and says it is interested.
 */
export class ScriptedPeer {
  unchoked = false
  /** Requests the engine sent, as { piece, offset, length }. */
  requests = []
  /** Rejects the engine sent for our requests. */
  rejects = []
  /** Pieces the engine withdrew through lt_donthave. */
  dontHave = []
  /** The bencoded payload of every ut_pex message the engine sent. */
  pex = []
  /** Every ut_holepunch message the engine sent, as { type, endpoint } with an IPv4 `address:port`. */
  holepunch = []
  /** The ids the engine reads ut_pex and ut_holepunch under, null until its extension handshake has arrived. */
  enginePexId = null
  engineHolepunchId = null
  #engineMetadataId = null
  #socket = null
  #serve
  #reqq
  #listenPort
  #metadata

  /**
   * `reqq` is how many requests this peer says it takes at once, and `listenPort` the port it says
   * it can be dialled on (both BEP 10), 0 to say nothing. `metadata` is the bencoded info dictionary:
   * with it the peer says it holds the metadata, and answers every request for a piece of it.
   */
  constructor({ infoHash, port, serve = null, socket = null, reqq = 0, listenPort = 0, metadata = null }) {
    this.infoHash = Buffer.from(infoHash, 'hex')
    this.port = port
    this.#serve = serve
    this.#socket = socket
    this.#reqq = reqq
    this.#listenPort = listenPort
    this.#metadata = metadata
  }

  /**
   * Resolves once the engine's handshake is back and this peer's opening messages are sent.
   * Rejects when the socket fails, and when no handshake is back after 20 s: an engine that
   * closes the connection or never answers says nothing, and a wait on it would never end.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const given = this.#socket
      const socket = given ?? net.createConnection({ host: '127.0.0.1', port: this.port })
      this.#socket = socket
      socket.on('error', reject)
      const late = setTimeout(() => reject(new Error('no handshake from the engine within 20 s')), 20_000).unref()
      const open = () => socket.write(Buffer.concat([
        Buffer.from([PROTOCOL.length]),
        Buffer.from(PROTOCOL, 'ascii'),
        // extension protocol (BEP 10) and fast extension (BEP 6)
        Buffer.from([0, 0, 0, 0, 0, 0x10, 0, 0x04]),
        this.infoHash,
        Buffer.concat([Buffer.from('-SP0001-'), crypto.randomBytes(12)]),
      ]))
      if (given) open()
      else socket.on('connect', open)
      let buf = Buffer.alloc(0)
      let shookHands = false
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (!shookHands) {
          if (buf.length < 68) return
          buf = buf.subarray(68)
          shookHands = true
          clearTimeout(late)
          socket.write(frame(MSG.extended, Buffer.concat([Buffer.from([0]), bencode({
            m: { lt_donthave: DONT_HAVE_ID, ut_holepunch: HOLEPUNCH_ID, ut_pex: PEX_ID, ut_metadata: this.#metadata ? METADATA_ID : undefined },
            metadata_size: this.#metadata?.length,
            p: this.#listenPort || undefined,
            reqq: this.#reqq || undefined,
          })])))
          if (this.#serve) socket.write(Buffer.concat([frame(MSG.haveAll), frame(MSG.unchoke)]))
          else socket.write(Buffer.concat([frame(MSG.haveNone), frame(MSG.interested)]))
          resolve()
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0)
          if (buf.length < 4 + len) break
          if (len > 0) this.#onMessage(buf.readUInt8(4), buf.subarray(5, 4 + len))
          buf = buf.subarray(4 + len)
        }
      })
    })
  }

  request(piece, offset, length) {
    this.#socket.write(frame(MSG.request, u32s(piece, offset, length)))
  }

  /** Sends a block, for instance one that `serve` withheld when it was asked for. */
  send(piece, offset, data) {
    this.#socket.write(frame(MSG.piece, Buffer.concat([u32s(piece, offset), data])))
  }

  /** Names peers to the engine in a ut_pex message, as IPv4 `address:port` strings, each with `flags`. */
  sendPex(added, flags = 0) {
    const compact = Buffer.concat(added.map(compactEndpoint))
    this.#socket.write(frame(MSG.extended, Buffer.concat([
      Buffer.from([this.enginePexId]),
      Buffer.from(`d5:added${compact.length}:`), compact,
      Buffer.from(`7:added.f${added.length}:`), Buffer.alloc(added.length, flags),
      Buffer.from('e'),
    ])))
  }

  /**
   * Sends a ut_holepunch message about the peer at `endpoint`: `rendezvous` asks the engine to
   * introduce this peer to it, `connect` tells the engine to dial it.
   */
  sendHolepunch(type, endpoint) {
    this.#socket.write(frame(MSG.extended, Buffer.concat([
      Buffer.from([this.engineHolepunchId, HOLEPUNCH_TYPE.indexOf(type), 0]),
      compactEndpoint(endpoint),
    ])))
  }

  close() {
    this.#socket?.destroy()
    this.#socket = null
  }

  #onMessage(id, payload) {
    if (id === MSG.unchoke) this.unchoked = true
    else if (id === MSG.reject) {
      this.rejects.push({ piece: payload.readUInt32BE(0), offset: payload.readUInt32BE(4), length: payload.readUInt32BE(8) })
    } else if (id === MSG.extended && payload[0] === 0) {
      const { m } = bdecode(payload.subarray(1))
      this.enginePexId = m?.ut_pex ?? null
      this.engineHolepunchId = m?.ut_holepunch ?? null
      this.#engineMetadataId = m?.ut_metadata ?? null
    } else if (id === MSG.extended && payload[0] === METADATA_ID) {
      // msg_type 0 asks for a piece and 1 carries one, its bytes after the dictionary
      const { msg_type: type, piece } = bdecode(payload.subarray(1))
      if (type !== 0) return
      this.#socket.write(frame(MSG.extended, Buffer.concat([
        Buffer.from([this.#engineMetadataId]),
        bencode({ msg_type: 1, piece, total_size: this.#metadata.length }),
        this.#metadata.subarray(piece * METADATA_PIECE, (piece + 1) * METADATA_PIECE),
      ])))
    } else if (id === MSG.extended && payload[0] === DONT_HAVE_ID) {
      this.dontHave.push(payload.readUInt32BE(1))
    } else if (id === MSG.extended && payload[0] === PEX_ID) {
      this.pex.push(Buffer.from(payload.subarray(1)))
    } else if (id === MSG.extended && payload[0] === HOLEPUNCH_ID) {
      // type, address family (0 is IPv4), then the compact endpoint
      this.holepunch.push({
        type: HOLEPUNCH_TYPE[payload[1]],
        endpoint: `${payload.subarray(3, 7).join('.')}:${payload.readUInt16BE(7)}`,
      })
    } else if (id === MSG.request && this.#serve) {
      const piece = payload.readUInt32BE(0)
      const offset = payload.readUInt32BE(4)
      const length = payload.readUInt32BE(8)
      this.requests.push({ piece, offset, length })
      const data = this.#serve(piece, offset, length)
      if (data) this.send(piece, offset, data)
    }
  }
}
