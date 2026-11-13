/**
 * The WebSocket trackers the owner chose to add to every torrent that is not private: WebTorrent's defaults
 * that still answer. Nothing announces to them unless a caller passes them.
 */
export const DEFAULT_TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']

const PRIVATE_V4: [prefix: number, bits: number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8],
  [0x64400000, 10], // shared address space, where the engine's made-up peer addresses live
  [0x7f000000, 8],
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12],
  [0xc0a80000, 16],
]

const localV4 = (address: number): boolean =>
  PRIVATE_V4.some(([prefix, bits]) => (address >>> (32 - bits)) === (prefix >>> (32 - bits)))

// `new URL` has already made every IPv4 spelling dotted decimal and every IPv6 one compressed lowercase hex.
const localHost = (hostname: string): boolean => {
  if (hostname.startsWith('[')) {
    const v6 = hostname.slice(1, -1)
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
    if (mapped) return localV4(((parseInt(mapped[1]!, 16) << 16) | parseInt(mapped[2]!, 16)) >>> 0)
    return v6 === '::' || v6 === '::1' || /^fe[89ab][0-9a-f]:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6)
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname)
  if (v4) return localV4(((+v4[1]! << 24) | (+v4[2]! << 16) | (+v4[3]! << 8) | +v4[4]!) >>> 0)
  const name = hostname.replace(/\.$/, '')
  return !name.includes('.') || name.endsWith('.localhost') || name.endsWith('.local')
}

/**
 * A torrent's tracker as the URL to open, or null when it is not a `ws` or `wss` URL or its host is the
 * person's own machine or network: `localhost`, a name with no dot, `.local`, or a loopback, private, shared
 * or link-local address. A browser asks permission before it opens such a socket for a public page.
 */
export const trackerUrl = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
  return localHost(parsed.hostname) ? null : parsed.href
}

const latin1 = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

type Bencoded = number | Uint8Array | Bencoded[] | Map<string, Bencoded>

const decode = (bytes: Uint8Array): Bencoded => {
  let at = 0
  const until = (stop: number): string => {
    const start = at
    while (bytes[at] !== stop) if (++at >= bytes.length) throw new Error('truncated')
    return latin1(bytes.subarray(start, at++))
  }
  const value = (): Bencoded => {
    const head = bytes[at]
    if (head === 0x69) { // i
      at++
      return Number(until(0x65))
    }
    if (head === 0x6c) { // l
      at++
      const list: Bencoded[] = []
      while (bytes[at] !== 0x65) list.push(value())
      at++
      return list
    }
    if (head === 0x64) { // d
      at++
      const dict = new Map<string, Bencoded>()
      while (bytes[at] !== 0x65) {
        const key = value()
        if (!(key instanceof Uint8Array)) throw new Error('a key that is not a string')
        dict.set(latin1(key), value())
      }
      at++
      return dict
    }
    const length = Number(until(0x3a))
    if (!Number.isInteger(length) || length < 0 || at + length > bytes.length) throw new Error('bad string')
    return bytes.subarray(at, at += length)
  }
  return value()
}

const announced = (torrent: Bencoded): string[] => {
  if (!(torrent instanceof Map)) return []
  const urls: string[] = []
  const add = (url: Bencoded | undefined) => { if (url instanceof Uint8Array) urls.push(latin1(url)) }
  add(torrent.get('announce'))
  const tiers = torrent.get('announce-list')
  if (Array.isArray(tiers)) for (const tier of tiers) if (Array.isArray(tier)) tier.forEach(add)
  return urls
}

const magnetTrackers = (magnet: string): string[] => {
  const urls: string[] = []
  for (const part of magnet.slice(magnet.indexOf('?') + 1).split('&')) {
    const equals = part.indexOf('=')
    if (!/^tr(\.\d+)?$/.test(part.slice(0, equals))) continue
    try {
      urls.push(decodeURIComponent(part.slice(equals + 1)))
    } catch { /* not an escaped URL */ }
  }
  return urls
}

/**
 * The `ws` and `wss` trackers a magnet link or a .torrent file names, each once, as written. libtorrent drops
 * them when it parses either, so the session cannot say. Anything that does not parse gives an empty list.
 */
export const trackersOf = (source: string | Uint8Array): string[] => {
  let urls: string[]
  try {
    urls = typeof source === 'string' ? magnetTrackers(source) : announced(decode(source))
  } catch {
    return []
  }
  return [...new Set(urls.map(url => url.trim()).filter(url => /^wss?:\/\//i.test(url)))]
}
