// The system Chrome, headless and muted, and its own RTCPeerConnection as the remote end.
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { chromium } from 'playwright'
import { gathered, once } from './local.mjs'

/** CHROME_BIN, or the first Chrome on the PATH, or undefined. */
export function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {}
  }
  return undefined
}

/**
 * Chrome, and a loopback origin that answers `files` ({ path: [bytes, content type] }) and an
 * empty page for anything else. No COOP or COEP header, so its pages are not cross-origin isolated.
 */
export async function launchChrome(executablePath, files = {}) {
  const server = http.createServer((request, response) => {
    const [body, type] = files[request.url] ?? ['<!doctype html><title>webrtc</title>', 'text/html']
    response.writeHead(200, { 'content-type': type }).end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // on a Wayland desktop these two make Chrome open a window even when asked for none
  const { WAYLAND_DISPLAY: _display, NIXOS_OZONE_WL: _ozone, ...env } = process.env
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    env,
    args: [
      '--headless=new',
      '--ozone-platform=headless',
      '--mute-audio',
      // so that Chrome's own RTCPeerConnection offers this machine's addresses, loopback included
      '--allow-loopback-in-peer-connection',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  })
  return {
    browser,
    async page() {
      const page = await (await browser.newContext()).newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      return page
    },
    async close() {
      await browser.close()
      server.close()
    },
  }
}

const inPage = () => {
  window.pc = new RTCPeerConnection()
  window.gathered = async () => {
    while (pc.iceGatheringState !== 'complete') await new Promise((resolve) => pc.addEventListener('icegatheringstatechange', resolve, { once: true }))
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
  }
  window.sha256 = async (chunks) => {
    const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      all.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  window.opened = new Promise((resolve) => {
    window.wire = (channel) => {
      window.channel = channel
      channel.binaryType = 'arraybuffer'
      channel.onopen = resolve
    }
  })
  pc.ondatachannel = ({ channel }) => wire(channel)
}

/** Chrome's own RTCPeerConnection in `page` as the remote end of one of ours. */
export async function chromeRemote(page) {
  await page.evaluate(inPage)
  return {
    /** Connects `pc`, ours, with either side offering, and answers our open channel. */
    async connect(pc, { offer, label = 'chrome' }) {
      let channel
      if (offer) {
        channel = pc.createDataChannel(label)
        const opened = once(channel, 'open')
        await pc.setLocalDescription()
        const answer = await page.evaluate(async (description) => {
          await pc.setRemoteDescription(description)
          await pc.setLocalDescription()
          return gathered()
        }, await gathered(pc))
        await pc.setRemoteDescription(answer)
        await opened
      } else {
        const announced = once(pc, 'datachannel')
        const theirs = await page.evaluate(async (label) => {
          wire(pc.createDataChannel(label))
          await pc.setLocalDescription()
          return gathered()
        }, label)
        await pc.setRemoteDescription(theirs)
        await pc.setLocalDescription()
        await page.evaluate((description) => pc.setRemoteDescription(description), await gathered(pc))
        channel = (await announced).channel
      }
      await page.evaluate(() => opened)
      return channel
    },
    maxMessageSize: () => page.evaluate(() => pc.sctp.maxMessageSize),
    /** Starts collecting, and answers a function that resolves with the SHA-256 of the next `bytes` bytes Chrome receives. */
    async expect(bytes) {
      await page.evaluate((bytes) => {
        window.arrived = new Promise((resolve) => {
          const chunks = []
          let total = 0
          channel.onmessage = ({ data }) => {
            chunks.push(data)
            total += data.byteLength
            if (total >= bytes) resolve(sha256(chunks))
          }
        })
      }, bytes)
      return () => page.evaluate(() => arrived)
    },
    /** Has Chrome send `bytes` in messages of `size`, paced on its own queue, and answers their SHA-256. */
    transfer: (bytes, size) =>
      page.evaluate(
        async ({ bytes, size }) => {
          const chunks = []
          channel.bufferedAmountLowThreshold = 1024 * 1024
          for (let sent = 0; sent < bytes; sent += size) {
            if (channel.bufferedAmount > 4 * 1024 * 1024) await new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, { once: true }))
            const message = crypto.getRandomValues(new Uint8Array(Math.min(size, bytes - sent)))
            channel.send(message)
            chunks.push(message)
          }
          return sha256(chunks)
        },
        { bytes, size },
      ),
  }
}
