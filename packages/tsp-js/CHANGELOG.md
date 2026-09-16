# Changelog

All notable changes to `@openvtc/vti-tsp-js` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
For history before this file, see `git log` on `packages/tsp-js`.

## [Unreleased]

### Added

- `resolveAccept(state, answeredDigest, ourInviteDigest)`: whether a received
  accept answers the invite we have outstanding (§7.2.2). `transition` sees
  only the state, so until now every client had to compare the digests itself
  or adopt an accept for an invite it never sent.

### Fixed

- `MAX_HOPS` is 64 (was 10). The specification sets no maximum, and 12-hop
  routes packed by every other implementation were refused on decode. The same
  bound applies when packing a route and when decoding a hop list or reply path.
- An XSCS/XCTL body that is not exactly one Bytes primitive is refused. It was
  read as its first primitive, silently dropping the rest of the `-A##` stream,
  and data after the stream was ignored. See
  [tswg-tsp-specification#77](https://github.com/trustoverip/tswg-tsp-specification/issues/77).

## [0.3.0] — Trust Spanning Protocol specification Rev 3

**Breaking. This package now packs Rev 3, and a Rev 2 peer cannot read what it
sends.** There is no negotiation and no fallback. Rev 3 changed the crypto mode,
the version byte, the long count-code prefix, the ciphertext code and layout,
the `-E` count's meaning, the signature code and every payload layout at once,
so the two revisions share no frame either side can classify.

Reading is dual. `unpack` dispatches on the version marker every message
carries — a fixed offset, no keys — and a Rev 2 message is read by a frozen,
decode-only codec in `src/rev2/`. The asymmetry is the design: an inbound
message says what it is, an outbound one has nothing to read, and a dual
*packer* could only be a guess dressed as a protocol.

### Added

- `peekRevision` / `describeRevision` — the keyless discriminator, and
  `TspRevisionError` (`code: "E_TSP_REVISION"`) with `isRevisionError`.
- `revision` on every `unpack` result, and on `decodeEnvelope`. How a caller
  learns what a peer speaks; persisting it per peer belongs above this package.
- `isTsp`, accepting both `0xF8` and the long framing's `0xFB`.
- **Relationship control messages** (§7.2, §7.3): `packInvite`, `packAccept`,
  `packCancel`, and `unpack` returning a verified `control` message. Rev 3 gates
  application messages on a relationship, so without these a peer enforcing
  §7.2.2 drops everything a client sends — silently, since a dropped message
  answers nothing.

  The §7.2.1 `TSP_Digest` is the substance of it: self-addressing over the
  message's own envelope and payload with its own slot filled by 33 dummy
  bytes, carried on the wire, and recomputed by the receiver, which refuses the
  message on a mismatch. Rev 2 correlated on a hash of the encrypted payload
  that was never transmitted and so could never be checked. The three published
  control vectors exercise the derivation directly.

- **The §7.2/§7.3 state machine** (`relationship.ts`): `transition`, `canSend`,
  `admitsApplicationMessage`, `resolveInviteRace`, `resolveCancel`. Pure — state
  and event in, state or a refusal out — with no storage, clock or keys, so the
  rules can be tested against the specification rather than against a mock.
  `unpack` does not apply them: a codec that mutated relationship state would
  make receiving a message a side effect.

- `XCTL` and `XPAD` are recognised and reported rather than refused as unknown
  type codes. `XCTL` carries an upper-layer control payload and is opaque to
  TSP, sharing nothing with a relationship-forming message but the word.
- The specification's own Appendix A vectors run as a test suite
  (`tests/interop.spec-vectors.mjs`). Every published vector is either
  exercised or named as uncovered.

### Changed — wire format

- **HPKE-Auth → HPKE-Base.** The sender's key leaves the KEM, so `PackKeys` and
  `UnpackKeys` each lost `senderEncryptionKey` — it survives on `UnpackKeys` as
  an **optional, Rev 2-only** member, because HPKE-Auth cannot *open* a message
  without it. `info` is the fixed code `YTSP-`; the AAD is
  `TSP_Version ‖ VID_sndr ‖ VID_rcvr`, where Rev 2 passed the envelope frame as
  `info` with empty AAD.
- **Version `YTSP-AAB` → `YTSP-AAC`**, MAJOR.MINOR with MINOR filling the
  12-bit count. Only MAJOR gates processability, so any other MINOR at MAJOR 0
  — including upstream's `ABA` (64) — reads as Rev 3.
- **Ciphertext code `G` → `F`**, and the field is `enc ‖ ct`; Rev 2 put `enc`
  last. A `C`-coded sealed box (§8.3) is recognised and refused by name.
- **Long count codes `-0X#####` → `--X#####`.**
- **The `-E` count covers all signable content**, so the frame is finalized
  after sealing. `encodeEnvelope` is gone; Rev 3's `encodeFields` +
  `finalizeFrame` replace it, and the split is where the AAD boundary falls.
- **The trailing `X 00 00` marker is deleted**; the receiver field is always
  written, with `4BAA` meaning absent.
- **The signature is indexed** (`B#`) under length-based counts `-C23 -K22`.
- **Payload layouts** carry an ESSR sender VID and a padding field; a direct
  body sits in a `-A` generic stream; `-J` counts bytes rather than VIDs; a
  nested inner message is carried raw, so it must be quadlet-aligned.

### Fixed

- **`decodeCount` returned long-form counts with the identifier bits still in
  them**, so every long-framed message decoded to a wrong length. The test that
  covered it asserted the wrong behaviour on purpose, calling it "a reference
  quirk ... benign, TSP frames by cursor position and discards this value".
  That reasoning was wrong and Rev 3 makes it fatal: the `-E` and `-Z` counts
  are now load-bearing lengths. `affinidi-tsp` fixed the same bug independently.
- `MAX_HOPS` was 16 on the packing side against a decoder that stopped at 10, so
  a 12-hop route packed cleanly and could not be read back by this library.


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
