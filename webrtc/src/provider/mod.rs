//! str0m's pure Rust crypto provider, copied from `crypto/rust-crypto/src` of algesten/str0m at
//! commit 5f2183ce7c67117cd1960dfeb11bed11fc188b66 (str0m 0.25.0, str0m-rust-crypto 0.7.0).
//!
//! It is a copy because that crate turns on dimpl's `rcgen` feature, which pulls aws-lc-rs, a C
//! library that does not build for wasm. Two things differ from the original: this file is its
//! `lib.rs` without the doc comment, and `dtls.rs` makes no certificate (the wrapper passes one
//! made with WebCrypto). `sha1.rs`, `sha256.rs` and `srtp.rs` are byte for byte the original.
#![allow(clippy::collapsible_if)]

mod dtls;
mod sha1;
mod sha256;
mod srtp;

use dtls::RustCryptoDtlsProvider;
use sha1::{RustCryptoSha1HmacProvider, RustCryptoSha1Provider};
use sha256::RustCryptoSha256Provider;
use srtp::RustCryptoSrtpProvider;
use str0m_proto::crypto::CryptoProvider;

pub fn default_provider() -> CryptoProvider {
    static SRTP: RustCryptoSrtpProvider = RustCryptoSrtpProvider;
    static SHA1_HMAC: RustCryptoSha1HmacProvider = RustCryptoSha1HmacProvider;
    static SHA1: RustCryptoSha1Provider = RustCryptoSha1Provider;
    static SHA256: RustCryptoSha256Provider = RustCryptoSha256Provider;
    static DTLS: RustCryptoDtlsProvider = RustCryptoDtlsProvider;

    CryptoProvider {
        srtp_provider: &SRTP,
        sha1_hmac_provider: &SHA1_HMAC,
        sha1_provider: &SHA1,
        sha256_provider: &SHA256,
        dtls_provider: &DTLS,
    }
}
