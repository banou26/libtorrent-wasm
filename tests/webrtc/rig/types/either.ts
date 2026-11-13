// Compiled by tests/webrtc/build.test.mjs, never run: code that is given either constructor,
// the platform's own or this entry's, names one type for it. Both have to fit that type, and
// what such code does with a connection has to compile against it.
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
  await pc.setLocalDescription(await pc.createOffer())
  return pc.localDescription?.sdp
}
