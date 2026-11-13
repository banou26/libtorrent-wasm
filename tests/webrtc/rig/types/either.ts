// Compiled by tests/webrtc/build.test.mjs, never run: code that is given either constructor,
// the platform's own or this entry's, names one type for it. Both have to fit that type, and
// what such code does with a connection has to compile against it. And a socket typed as node
// types its own has to fit the factory.
import { createWebRTC, type WebRTC } from '../../../../build/webrtc/index'

type PeerConnection = WebRTC['RTCPeerConnection']

export async function constructors(options: Parameters<typeof createWebRTC>[0]): Promise<PeerConnection[]> {
  return [RTCPeerConnection, (await createWebRTC(options)).RTCPeerConnection]
}

export async function offer(PeerConnection: PeerConnection) {
  const pc = new PeerConnection({ iceServers: [] })
  const sizes: number[] = []
  const channel = pc.createDataChannel('data')
  channel.onmessage = ({ data }) => sizes.push(typeof data === 'string' ? data.length : data.byteLength)
  channel.onerror = ({ error }) => sizes.push(error.message.length)
  pc.ondatachannel = ({ channel }) => channel.send('hello')
  pc.onicecandidate = ({ candidate }) => sizes.push(candidate?.candidate?.length ?? 0)
  pc.addEventListener('connectionstatechange', () => sizes.push(pc.connectionState.length))
  channel.onopen = () => sizes.push(pc.sctp?.transport.iceTransport.getSelectedCandidatePair()?.remote.address?.length ?? 0)
  await pc.setLocalDescription(await pc.createOffer())
  return pc.localDescription?.sdp
}

// node's dgram socket and @fkn/lib's are node's EventEmitter, which types `on` and `off` this way
declare const socket: {
  send(data: Uint8Array, port: number, address: string, callback?: (error: Error | null) => void): void
  on(event: string | symbol, listener: (...args: any[]) => void): unknown
  off(event: string | symbol, listener: (...args: any[]) => void): unknown
}

export const overAnEmitter = () => createWebRTC({ socket, address: '192.0.2.1', port: 9 })
