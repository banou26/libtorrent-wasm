// Compiled by tests/webtorrent/build.test.mjs, never run: the classes a caller hands the signalling, against
// the declarations as built. Each has to fit its parameter as it is, with no cast.
import { rtcLinks, webtorrentPeers, type RtcLinksOptions, type SwarmSession } from '../../../build/webtorrent/index'
import { servePeerLinks, type PortLike } from '../../../build/webtorrent/page'
import { createWebRTC } from '../../../build/webrtc/index'

type Class = RtcLinksOptions['RTCPeerConnection']
type Platform = InstanceType<typeof RTCPeerConnection>

// what @banou/ponyfill declares for its class
declare const Ponyfill: typeof globalThis.RTCPeerConnection

/** The platform's class, the ponyfill's and the WebRTC entry's, each under the links and the first two in a page. */
export async function classes(options: Parameters<typeof createWebRTC>[0], port: PortLike) {
  const stack = await createWebRTC(options)
  servePeerLinks(port, { RTCPeerConnection, iceServers: [] })
  servePeerLinks(port, { RTCPeerConnection: Ponyfill })
  return [rtcLinks({ RTCPeerConnection }), rtcLinks({ RTCPeerConnection: Ponyfill }), rtcLinks({ RTCPeerConnection: stack.RTCPeerConnection })]
}

/** The relay mode's swarm: the entry's class in the worker, and the platform's WebSocket for the trackers. */
export async function relayed(session: SwarmSession, options: Parameters<typeof createWebRTC>[0]) {
  const { RTCPeerConnection } = await createWebRTC(options)
  return webtorrentPeers(session, { links: rtcLinks({ RTCPeerConnection }), WebSocket, relay: true })
}

// The compiler can refuse a class: one with no data channel, one whose channel has no `bufferedAmount`, and one
// whose selected pair names no address, which is what the relay rule reads.
declare const noChannel: new () => Omit<Platform, 'createDataChannel'>
declare const unpaced: new () => Omit<Platform, 'createDataChannel'> & { createDataChannel(label: string): Omit<RTCDataChannel, 'bufferedAmount'> }
declare const noAddress: new () => Omit<Platform, 'sctp'> & {
  sctp: { maxMessageSize: number, transport: { iceTransport: { getSelectedCandidatePair(): { remote: { port: number } } | null } } } | null
}
export const refused: Class[] = [
  // @ts-expect-error
  noChannel,
  // @ts-expect-error
  unpaced,
  // @ts-expect-error
  noAddress,
]
