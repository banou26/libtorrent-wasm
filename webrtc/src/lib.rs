//! str0m behind a C ABI, for the wrapper in `src/webrtc`: data channels only, IPv4 only.
//!
//! The caller owns the UDP socket and the timer. Datagrams and the time go in, and everything
//! the stack has to say comes out of `rtc_poll`, one output per call.
//!
//! str0m's contract, which the wrapper keeps: every call that changes a connection is followed
//! by `rtc_poll` until it answers `TIMEOUT`, before the next one. That is every call here but
//! `rtc_accepts`, `rtc_buffered` and the four readers at the end of this file.
//!
//! A call that can fail answers a negative number and leaves the reason, as text, where
//! `rtc_out_ptr` and `rtc_out_len` point.
mod provider;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::config::DtlsCert;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

pub struct Connection {
    rtc: Rtc,
    local: SocketAddr,
    pending: Option<SdpPendingOffer>,
    /// A channel's position here is the number the wrapper knows it by.
    channels: Vec<ChannelId>,
    out: Vec<u8>,
    arg: u32,
    port: u32,
}

impl Connection {
    fn channel_number(&mut self, id: ChannelId) -> i32 {
        let known = self.channels.iter().position(|c| *c == id);
        known.unwrap_or_else(|| {
            self.channels.push(id);
            self.channels.len() - 1
        }) as i32
    }

    fn fail(&mut self, code: i32, reason: impl std::fmt::Display) -> i32 {
        self.out = reason.to_string().into_bytes();
        code
    }

    fn input<'a>(&self, ip: u32, port: u32, data: &'a [u8]) -> Option<Input<'a>> {
        let receive = Receive {
            proto: Protocol::Udp,
            source: address(ip, port),
            destination: self.local,
            contents: data.try_into().ok()?,
        };
        Some(Input::Receive(Instant::now(), receive))
    }
}

fn address(ip: u32, port: u32) -> SocketAddr {
    SocketAddr::new(Ipv4Addr::from(ip).into(), port as u16)
}

unsafe fn bytes<'a>(pointer: *const u8, length: usize) -> &'a [u8] {
    if length == 0 { &[] } else { unsafe { std::slice::from_raw_parts(pointer, length) } }
}

unsafe fn text(pointer: *const u8, length: usize) -> String {
    String::from_utf8_lossy(unsafe { bytes(pointer, length) }).into_owned()
}

#[unsafe(no_mangle)]
pub extern "C" fn rtc_alloc(length: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(length.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_free(pointer: *mut u8, length: usize) {
    drop(unsafe { Vec::from_raw_parts(pointer, 0, length.max(1)) });
}

/// A connection whose one host candidate is `ip:port`, or null when the stack refuses that
/// address. The certificate is DER and the key PKCS#8, for ECDSA P-256.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_new(
    certificate: *const u8,
    certificate_length: usize,
    key: *const u8,
    key_length: usize,
    ip: u32,
    port: u32,
    max_message_size: u32,
    send_buffer_size: usize,
) -> *mut Connection {
    let local = address(ip, port);
    let Ok(candidate) = Candidate::host(local, "udp") else { return std::ptr::null_mut() };
    let mut rtc = Rtc::builder()
        .set_crypto_provider(Arc::new(provider::default_provider()))
        .set_dtls_cert(DtlsCert {
            certificate: unsafe { bytes(certificate, certificate_length) }.to_vec(),
            private_key: unsafe { bytes(key, key_length) }.to_vec(),
        })
        .clear_codecs()
        .set_stats_interval(None)
        .set_sctp_max_message_size(max_message_size)
        .set_sctp_max_buffered_amount(send_buffer_size)
        .build(Instant::now());
    rtc.add_local_candidate(candidate);
    Box::into_raw(Box::new(Connection {
        rtc,
        local,
        pending: None,
        channels: Vec::new(),
        out: Vec::new(),
        arg: 0,
        port: 0,
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_delete(connection: *mut Connection) {
    drop(unsafe { Box::from_raw(connection) });
}

/// Opens an ordered, reliable channel and answers its number. The first channel of a
/// connection that has no description yet needs an offer, which is then left in `out`;
/// otherwise `out` is empty and the channel opens on the association there is.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_open(connection: *mut Connection, label: *const u8, length: usize) -> i32 {
    let c = unsafe { &mut *connection };
    let mut api = c.rtc.sdp_api();
    let id = api.add_channel(unsafe { text(label, length) });
    c.out.clear();
    if let Some((offer, pending)) = api.apply() {
        c.pending = Some(pending);
        c.out = offer.to_sdp_string().into_bytes();
    }
    c.channel_number(id)
}

/// Takes the remote offer and leaves the answer in `out`. -1 when the text is not SDP, which
/// changes nothing; -2 when the stack refuses the description, after which the connection is
/// not to be used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_accept_offer(connection: *mut Connection, sdp: *const u8, length: usize) -> i32 {
    let c = unsafe { &mut *connection };
    let offer = match SdpOffer::from_sdp_string(&unsafe { text(sdp, length) }) {
        Ok(offer) => offer,
        Err(e) => return c.fail(-1, e),
    };
    match c.rtc.sdp_api().accept_offer(offer) {
        Ok(answer) => {
            c.out = answer.to_sdp_string().into_bytes();
            0
        }
        Err(e) => c.fail(-2, e),
    }
}

/// Takes the remote answer to the offer `rtc_open` made. Fails as `rtc_accept_offer` does.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_accept_answer(connection: *mut Connection, sdp: *const u8, length: usize) -> i32 {
    let c = unsafe { &mut *connection };
    let answer = match SdpAnswer::from_sdp_string(&unsafe { text(sdp, length) }) {
        Ok(answer) => answer,
        Err(e) => return c.fail(-1, e),
    };
    let Some(pending) = c.pending.take() else { return c.fail(-2, "no offer to answer") };
    match c.rtc.sdp_api().accept_answer(pending, answer) {
        Ok(()) => 0,
        Err(e) => c.fail(-2, e),
    }
}

/// 1 when a datagram from `ip:port` belongs to this connection: a known remote address, or a
/// STUN request carrying this connection's ICE user name. Changes nothing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_accepts(connection: *mut Connection, ip: u32, port: u32, data: *const u8, length: usize) -> i32 {
    let c = unsafe { &*connection };
    let input = c.input(ip, port, unsafe { bytes(data, length) });
    input.is_some_and(|input| c.rtc.accepts(&input)) as i32
}

/// A datagram that is none of STUN, DTLS, RTP and RTCP is ignored and is not a failure.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_receive(connection: *mut Connection, ip: u32, port: u32, data: *const u8, length: usize) -> i32 {
    let c = unsafe { &mut *connection };
    let Some(input) = c.input(ip, port, unsafe { bytes(data, length) }) else { return 0 };
    match c.rtc.handle_input(input) {
        Ok(()) => 0,
        Err(e) => c.fail(-1, e),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_timeout(connection: *mut Connection) -> i32 {
    let c = unsafe { &mut *connection };
    match c.rtc.handle_input(Input::Timeout(Instant::now())) {
        Ok(()) => 0,
        Err(e) => c.fail(-1, e),
    }
}

/// Nothing more to say. `arg` is the milliseconds until `rtc_timeout` is due.
pub const TIMEOUT: i32 = 0;
/// `out` is a datagram for the IPv4 address in `arg` and the port in `rtc_port`.
pub const TRANSMIT: i32 = 1;
/// Channel `arg` is open. `out` is its label.
pub const OPEN: i32 = 2;
/// A binary message on channel `arg`, in `out`.
pub const BINARY: i32 = 3;
/// A text message on channel `arg`, in `out`.
pub const TEXT: i32 = 4;
/// Channel `arg` is closed, by either side.
pub const CHANNEL_CLOSED: i32 = 5;
/// ICE and DTLS are up.
pub const CONNECTED: i32 = 6;
/// Every candidate pair ran out of retransmissions, about 22 s after the peer went quiet.
pub const UNREACHABLE: i32 = 7;
/// The peer closed the connection.
pub const CLOSED: i32 = 8;
pub const OTHER: i32 = 9;

/// The next output of the stack.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_poll(connection: *mut Connection) -> i32 {
    let c = unsafe { &mut *connection };
    match c.rtc.poll_output() {
        Ok(Output::Timeout(at)) => {
            let wait = at.saturating_duration_since(Instant::now());
            c.arg = wait.as_micros().div_ceil(1000).min(3_600_000) as u32;
            TIMEOUT
        }
        Ok(Output::Transmit(transmit)) => {
            let SocketAddr::V4(to) = transmit.destination else { return OTHER };
            c.arg = (*to.ip()).into();
            c.port = to.port().into();
            c.out.clear();
            c.out.extend_from_slice(&transmit.contents);
            TRANSMIT
        }
        Ok(Output::Event(event)) => match event {
            Event::ChannelOpen(id, label) => {
                c.arg = c.channel_number(id) as u32;
                c.out = label.into_bytes();
                OPEN
            }
            Event::ChannelData(data) => {
                c.arg = c.channel_number(data.id) as u32;
                c.out = data.data;
                if data.binary { BINARY } else { TEXT }
            }
            Event::ChannelClose(id) => {
                c.arg = c.channel_number(id) as u32;
                CHANNEL_CLOSED
            }
            Event::Connected => CONNECTED,
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => UNREACHABLE,
            Event::Closed => CLOSED,
            _ => OTHER,
        },
        Err(e) => c.fail(-1, e),
    }
}

/// 1 when the stack took the message, 0 when its send buffer has no room for it yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_write(connection: *mut Connection, channel: u32, binary: u32, data: *const u8, length: usize) -> i32 {
    let c = unsafe { &mut *connection };
    let Some(mut channel) = c.channels.get(channel as usize).and_then(|id| c.rtc.channel(*id)) else {
        return c.fail(-1, "the channel is not open");
    };
    match channel.write(binary != 0, unsafe { bytes(data, length) }) {
        Ok(taken) => taken as i32,
        Err(e) => c.fail(-1, e),
    }
}

/// Bytes of the channel the stack holds, written and not yet acknowledged by the peer.
///
/// str0m reads this through `&mut Rtc`, which its contract counts as a change. All that changes
/// is the mark that makes the next poll look at everything, so nothing has to be polled after.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_buffered(connection: *mut Connection, channel: u32) -> usize {
    let c = unsafe { &mut *connection };
    let channel = c.channels.get(channel as usize).and_then(|id| c.rtc.channel(*id));
    channel.map_or(0, |mut channel| channel.buffered_amount())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_close_channel(connection: *mut Connection, channel: u32) {
    let c = unsafe { &mut *connection };
    if let Some(id) = c.channels.get(channel as usize) {
        c.rtc.direct_api().close_data_channel(*id);
    }
}

/// Starts the shutdown the peer can see: the SCTP shutdown and the DTLS close alert come out
/// of the polls that follow.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_close(connection: *mut Connection) {
    let _ = unsafe { &mut *connection }.rtc.close();
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_out_ptr(connection: *const Connection) -> *const u8 {
    unsafe { &*connection }.out.as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_out_len(connection: *const Connection) -> usize {
    unsafe { &*connection }.out.len()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_arg(connection: *const Connection) -> u32 {
    unsafe { &*connection }.arg
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rtc_port(connection: *const Connection) -> u32 {
    unsafe { &*connection }.port
}
