# @openvtc/vti-tsp-js

WebCrypto / [hpke-js](https://github.com/dajiaji/hpke-js) implementation of the
**Trust Spanning Protocol (TSP)** message layer — **byte-compatible with
[`affinidi-tsp`](https://crates.io/crates/affinidi-tsp)** (the Rust crate the VTA
links). Pure TypeScript, **no WASM**: HPKE-Auth via `hpke-js`, Ed25519 and
X25519 via `@noble/curves`, binary CESR framing hand-ported from the reference.

Runs anywhere WebCrypto does — browsers, service workers, Node ≥ 20, Deno.

## What it does

A TSP message is **encrypted-then-signed** (ETS): the payload is HPKE-Auth
sealed to the recipient (which also authenticates the sender), then the whole
CESR frame is Ed25519-signed. VIDs are DIDs. This package owns the wire layer —
CESR encode/decode, the `-E` envelope, HPKE seal/open, Ed25519 sign/verify, and
`pack`/`unpack` for Direct, Nested, and Routed messages.

- **HPKE-Auth** — RFC 9180, `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` +
  `ChaCha20Poly1305`. The `-E` envelope frame (sender VID · receiver VID) is the
  HPKE `info`, binding the ciphertext to both parties.
- **CESR** — binary `qb2` framing (selectors `-E`, `-Z`, `B`, `G`, `I`, `A`, `X`;
  markers `YTSP`, `XSCS`/`XHOP`, `XRFI`/`XRFA`/`XRFD`).
- **Message modes** — Direct, Nested (metadata privacy), and Routed (multi-hop
  through a relay/mediator).

Byte-compatibility is proven by an interop test that unpacks a message packed by
the Rust reference with fixed keys and recovers the plaintext + thread digest
exactly (`tests/interop.rust-vector.mjs`).

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
| `hpke` | HPKE-Auth seal/open |
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
