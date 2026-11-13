const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const tlv = (tag: number, ...parts: (Uint8Array | number[])[]) => {
  const body = concat(parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part))))
  const length = body.length
  const header = length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : [0x82, length >> 8, length & 0xff]
  return concat([new Uint8Array([tag, ...header]), body])
}

const integer = (bytes: Uint8Array) => {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) start++
  const magnitude = bytes.subarray(start)
  return tlv(0x02, magnitude[0] & 0x80 ? [0] : [], magnitude)
}

const time = (date: Date) =>
  tlv(0x17, new TextEncoder().encode(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))

const ECDSA_WITH_SHA256 = tlv(0x30, tlv(0x06, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))
const NAME = tlv(0x30, tlv(0x31, tlv(0x30, tlv(0x06, [0x55, 0x04, 0x03]), tlv(0x0c, new TextEncoder().encode('WebRTC')))))
const DAY = 86_400_000

/**
 * A self-signed ECDSA P-256 certificate, as browsers make for a peer connection: X.509 in DER and
 * its key in PKCS#8. A peer checks it against the fingerprint in the description and nothing else.
 *
 * Made with WebCrypto because the stack's own generator pulls a C library into the build.
 */
export async function makeCertificate() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))
  const serial = crypto.getRandomValues(new Uint8Array(16))
  serial[0] = (serial[0] & 0x7f) | 0x40
  const now = Date.now()
  const body = tlv(
    0x30,
    tlv(0xa0, integer(new Uint8Array([2]))),
    integer(serial),
    ECDSA_WITH_SHA256,
    NAME,
    tlv(0x30, time(new Date(now - DAY)), time(new Date(now + 30 * DAY))),
    NAME,
    publicKey,
  )
  // WebCrypto signs as r and s back to back, X.509 wants them as two DER integers.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, body))
  const signed = tlv(0x30, integer(signature.subarray(0, 32)), integer(signature.subarray(32)))
  return {
    certificate: tlv(0x30, body, ECDSA_WITH_SHA256, tlv(0x03, [0], signed)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
  }
}
