# Changelog

All notable changes to `@openvtc/vti-tsp-js` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
For history before this file, see `git log` on `packages/tsp-js`.

## [Unreleased]

### Added

- **Pluggable key custody for HPKE-Auth and Ed25519 signing.** Two capability
  interfaces — `KeyAgreement` (the raw X25519 ECDH half of AuthEncap/AuthDecap)
  and `SigningKey` — let a backend that never exports a private key drive
  sealing, opening and signing: `hpke.sealWithKeyAgreement`,
  `hpke.openWithKeyAgreement` and `sign.signWithSigningKey`, plus
  `authEncapWithKeyAgreement` / `authDecapWithKeyAgreement` on the internal
  module for test-vector verification.

  Purely additive. Every existing export keeps its signature, its output and
  its sync/async shape; `pack`/`unpack` still take raw keys (a capability-driven
  pair is the next increment); base mode has no local key to hold and so needs
  no variant.

  This targets non-exporting *software* custody — an Askar-backed KMS, say. It
  is **not** an enclave claim: the suite pins DHKEM(X25519, HKDF-SHA256), and
  Secure Enclave, StrongBox and mainstream cloud KMS ECDH are all
  NIST-curve-only, so none of them can perform this DH at all. Ed25519 signing
  is a separate question, and Android Keystore has supported it since API 33.

  A capability is foreign code, so its outputs are validated on every call:
  32-byte lengths, and RFC 9180 §4.1's mandatory all-zero-DH abort. That abort
  lives in `dh()` on the raw path, and a backend whose DH is opaque has no
  reason to reject a low-order peer key on our behalf — leaving it unchecked
  would make HPKE-Auth's sender authentication forgeable by a peer publishing a
  low-order key. A signature is likewise verified under the capability's own
  `publicKey` before it is returned.

## [0.2.0] - 2026-08-17

### Changed

- **HPKE no longer requires WebCrypto.** The RFC 9180 implementation moved off
  [hpke-js](https://github.com/dajiaji/hpke-js) onto the
  [@noble](https://paulmillr.com/noble/) primitives
  (`src/crypto/hpke-noble.ts`). hpke-js reaches for `crypto.subtle` for HKDF
  and X25519, which React Native's Hermes engine does not have — and which real
  apps polyfill only *partially*, so a wallet exposing `subtle.digest` alone
  passes any feature probe and then fails at runtime.

  There is **one code path for every runtime**: no environment detection, no
  per-environment behavior. Same suite (KEM `0x0020`
  `DHKEM(X25519, HKDF-SHA256)`, KDF `0x0001` HKDF-SHA256, AEAD `0x0003`
  ChaCha20Poly1305), single-shot, byte-identical output. `seal`/`open`
  signatures and the wire bytes are unchanged, so this is transparent to
  callers — the package simply runs in more places.

  The only platform requirement is now `crypto.getRandomValues`, and only for
  *sealing*; opening needs no randomness. Native in browsers, Node and Deno; on
  React Native, import
  [`react-native-get-random-values`](https://github.com/LinusU/react-native-get-random-values)
  once at startup.

### Added

- **`@openvtc/vti-tsp-js/hpke` subpath export**, and **base mode**
  (`sealBase` / `openBase`) alongside the existing auth mode.

  Base and auth already shared the KEM, the key schedule and the AEAD — they
  differ only in the DH inputs to Encap/Decap and the mode byte — so `mode` is
  a parameter rather than a second implementation. This exists so
  `@openvtc/pnm-core` can retire its own copy of the same suite for VTA sealed
  bundles: one RFC 9180 key schedule in the ecosystem instead of one per
  caller.

  Auth mode remains what TSP messages use; base mode is only appropriate where
  the sender is authenticated by the surrounding format.

### Security

- The HPKE implementation is pinned three ways on every CI run: the official
  CFRG RFC 9180 `mode_auth` vector asserted in-tree (every key fixed, so
  exactly one correct output), and cross-implementation equivalence against
  hpke-js **in both modes**, each opening the other's output. hpke-js is
  retained as a **dev-dependency** for exactly that check — it is never shipped
  and never loaded at runtime.
- `@hpke/core` and `@hpke/chacha20poly1305` are no longer runtime
  dependencies. Runtime deps are now `@noble/ciphers`, `@noble/curves` and
  `@noble/hashes` only.

[Unreleased]: https://github.com/OpenVTC/vta-browser-plugin/compare/tsp-js-v0.2.0...HEAD
[0.2.0]: https://github.com/OpenVTC/vta-browser-plugin/releases/tag/tsp-js-v0.2.0
