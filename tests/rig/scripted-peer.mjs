// A peer that dials the engine and speaks the wire protocol by hand, with the fast extension
// (BEP 6) and lt_donthave (BEP 54), so a test sees every message the engine sends it. Given a
// `socket` (one end of a stream the engine holds the other end of) it speaks over that instead.

import crypto from 'node:crypto'
import net from 'node:net'

import { bdecode } from './make-torrent.mjs'
import { PROTOCOL } from './peer-handshake.mjs'

const MSG = {
  unchoke: 1, interested: 2, request: 6, piece: 7, haveAll: 14, haveNone: 15, reject: 16, extended: 20,
}
// the ids this peer asks the engine to use for the lt_donthave and ut_pex messages it sends
const DONT_HAVE_ID = 7
const PEX_ID = 8

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
  /** The id the engine reads ut_pex under, null until its extension handshake has arrived. */
  enginePexId = null
  #socket = null
  #serve
  #reqq

  /** `reqq` is how many requests this peer says it takes at once (BEP 10), 0 to say nothing. */
  constructor({ infoHash, port, serve = null, socket = null, reqq = 0 }) {
    this.infoHash = Buffer.from(infoHash, 'hex')
    this.port = port
    this.#serve = serve
    this.#socket = socket
    this.#reqq = reqq
  }

  /** Resolves once the engine's handshake is back and this peer's opening messages are sent. */
  connect() {
    return new Promise((resolve, reject) => {
      const given = this.#socket
      const socket = given ?? net.createConnection({ host: '127.0.0.1', port: this.port })
      this.#socket = socket
      socket.on('error', reject)
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
          socket.write(frame(MSG.extended, Buffer.concat([
            Buffer.from([0]),
            Buffer.from(`d1:md11:lt_donthavei${DONT_HAVE_ID}e6:ut_pexi${PEX_ID}ee${this.#reqq ? `4:reqqi${this.#reqq}e` : ''}e`),
          ])))
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

  /** Names peers to the engine in a ut_pex message, as IPv4 `address:port` strings. */
  sendPex(added) {
    const compact = Buffer.concat(added.map((endpoint) => {
      const [address, port] = endpoint.split(':')
      return Buffer.from([...address.split('.').map(Number), port >> 8, port & 0xff])
    }))
    this.#socket.write(frame(MSG.extended, Buffer.concat([
      Buffer.from([this.enginePexId]),
      Buffer.from(`d5:added${compact.length}:`), compact,
      Buffer.from(`7:added.f${added.length}:`), Buffer.alloc(added.length),
      Buffer.from('e'),
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
      this.enginePexId = bdecode(payload.subarray(1)).m?.ut_pex ?? null
    } else if (id === MSG.extended && payload[0] === DONT_HAVE_ID) {
      this.dontHave.push(payload.readUInt32BE(1))
    } else if (id === MSG.extended && payload[0] === PEX_ID) {
      this.pex.push(Buffer.from(payload.subarray(1)))
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
