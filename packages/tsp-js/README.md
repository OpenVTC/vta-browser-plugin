# @openvtc/vti-tsp-js

Pure-TypeScript implementation of the **Trust Spanning Protocol (TSP)** message
layer — **byte-compatible with
[`affinidi-tsp`](https://crates.io/crates/affinidi-tsp)** (the Rust crate the VTA
links). **No WASM and no WebCrypto**: RFC 9180 HPKE, Ed25519 and X25519 all via
[`@noble`](https://paulmillr.com/noble/), binary CESR framing hand-ported from
the reference.

**Runs anywhere JavaScript does** — browsers, service workers, Node ≥ 20, Deno,
and **React Native** (whose Hermes engine ships no `crypto.subtle`, and which
real apps polyfill only partially). There is one code path, not one per
environment: no runtime backend detection, so behavior is identical everywhere.

The only platform requirement is `crypto.getRandomValues`, and only for
*sealing* — opening a message needs no randomness. Browsers, Node and Deno have
it natively; on React Native, import
[`react-native-get-random-values`](https://github.com/LinusU/react-native-get-random-values)
once at app startup.

## What it does

A TSP message is **encrypted-then-signed** (ETS): the payload is HPKE-Auth
sealed to the recipient (which also authenticates the sender), then the whole
CESR frame is Ed25519-signed. VIDs are DIDs. This package owns the wire layer —
CESR encode/decode, the `-E` envelope, HPKE seal/open, Ed25519 sign/verify, and
`pack`/`unpack` for Direct, Nested, and Routed messages.

- **HPKE-Auth** — RFC 9180, `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` +
  `ChaCha20Poly1305`. The `-E` envelope frame (sender VID · receiver VID) is the
  HPKE `info`, binding the ciphertext to both parties. The same module also
  exposes **base mode** (`hpke.sealBase` / `hpke.openBase`) over the identical
  suite, so the ecosystem has one RFC 9180 key schedule rather than one per
  caller — `@openvtc/pnm-core` uses it for VTA sealed bundles.
- **CESR** — binary `qb2` framing (selectors `-E`, `-Z`, `B`, `G`, `I`, `A`, `X`;
  markers `YTSP`, `XSCS`/`XHOP`, `XRFI`/`XRFA`/`XRFD`).
- **Message modes** — Direct, Nested (metadata privacy), and Routed (multi-hop
  through a relay/mediator).

Byte-compatibility is proven by an interop test that unpacks a message packed by
the Rust reference with fixed keys and recovers the plaintext + thread digest
exactly (`tests/interop.rust-vector.mjs`).

The HPKE implementation is pinned three ways on every CI run: the official CFRG
RFC 9180 `mode_auth` vector asserted in-tree (`tests/crypto.cfrg-vector.mjs` —
every key fixed, so exactly one correct output), and cross-implementation
equivalence against [hpke-js](https://github.com/dajiaji/hpke-js) in both modes
(`tests/crypto.hpke-js-equivalence.mjs`, each opening the other's output).
hpke-js is a **dev-dependency only** — it is never shipped and never loaded at
runtime.

## Install

```sh
npm install @openvtc/vti-tsp-js
```

## Usage

```ts
import { pack, unpack } from "@openvtc/vti-tsp-js";

// Keys are raw 32-byte Ed25519 (signing) / X25519 (encryption) scalars.
const packed = await pack(payloadBytes, senderDid, recipientDid, {
  senderSigningKey,       // Ed25519 private — signs the outer frame
  senderEncryptionKey,    // X25519 private  — HPKE-Auth sender authentication
  receiverEncryptionKey,  // X25519 public   — HPKE recipient (seal to)
});
// packed.bytes: the qb2 TSP message (first byte 0xF8) — send it over any transport.

const msg = await unpack(packed.bytes, {
  receiverDecryptionKey,  // X25519 private — our key
  senderEncryptionKey,    // X25519 public  — sender-auth verification
  senderSigningKey,       // Ed25519 public — outer-signature verification
});
// msg.sender / msg.receiver (proven VIDs) + msg.payload (the recovered bytes).
```

Multi-hop routing (seal end-to-end to the final recipient, wrap a routing layer
sealed to the first hop):

```ts
import { packRouted } from "@openvtc/vti-tsp-js";
```

## API

| Export | What |
| --- | --- |
| `pack` / `unpack` | Direct message seal+sign / verify+open |
| `packWithHops` | Lower-level pack with an explicit hop list |
| `packRouted` / `packNested` / `nextHop` | Routed (multi-hop) + Nested (metadata-privacy) messages |
| `encodeEnvelope` / `decodeEnvelope` | The `-E` cleartext envelope (also the HPKE `info`) |
| `sha256` | Thread-digest helper |
| `cesr` | Binary CESR frame primitives |
| `hpke` | RFC 9180 HPKE seal/open — auth mode (`seal`/`open`) and base mode (`sealBase`/`openBase`). Also importable directly as `@openvtc/vti-tsp-js/hpke`. |
| `sign` | Ed25519 sign/verify |

## Scope

v1 is **HPKE-Auth only** (classical), matching `affinidi-tsp` — no
post-quantum suite. VID → key resolution is left to the caller (DIDs resolve via
whatever resolver the host app uses).

## Test

```sh
npm test
```

## License

Apache-2.0
