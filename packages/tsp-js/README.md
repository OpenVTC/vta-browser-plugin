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

## Revisions: packs Rev 3, reads Rev 3 and Rev 2

The specification's **Rev 3** changed the crypto mode, the version byte, the
long count-code prefix, the ciphertext code and layout, the `-E` count's
meaning, the signature code and every payload layout — at once. Nothing a Rev 2
peer packs can be unpacked by a Rev 3 one or the reverse, and there is no
negotiation in the protocol.

So this package is deliberately asymmetric:

- **`unpack` dispatches on the version marker**, which sits at a fixed offset
  and needs no keys. A Rev 2 message is read by a frozen, decode-only codec in
  `src/rev2/`, and the result reports `revision: "rev2"`.
- **`pack` does not dispatch on anything**, because there is nothing to
  dispatch on. An inbound message says what it is; an outbound one has to be
  decided before a byte exists, and no field on the wire says what a peer can
  read. We pack Rev 3. A Rev 2 peer cannot read it, and nothing here retries or
  falls back.

`unpack`'s `revision` is how a caller learns what a peer actually speaks.
Remembering that per peer belongs above this package — a codec has no business
holding state about who it has talked to.

## What it does

A TSP message is **encrypted-then-signed** (ETS): the payload is HPKE sealed to
the recipient, then the whole CESR frame is Ed25519-signed. VIDs are DIDs. This
package owns the wire layer — CESR encode/decode, the `-E` envelope, HPKE
seal/open, Ed25519 sign/verify, and `pack`/`unpack` for Direct, Nested, and
Routed messages.

- **HPKE-Base** (Rev 3) — RFC 9180, `DHKEM(X25519, HKDF-SHA256)` +
  `HKDF-SHA256` + `ChaCha20Poly1305`. The fixed code `YTSP-` is the HPKE
  `info`, and `TSP_Version ‖ VID_sndr ‖ VID_rcvr` is real AAD. The sender's
  key no longer enters the KEM — sender authenticity is the ESSR sender field
  plus the outer signature. **HPKE-Auth** remains for reading Rev 2, where the
  envelope frame was the `info` and the AAD was empty.
- **CESR** — binary `qb2` framing (selectors `-E`, `-Z`, `-A`, `-J`, `B`, `F`,
  `I`; markers `YTSP`, `XSCS`/`XHOP`, `XRFI`/`XRFA`/`XRFD`/`XCTL`/`XPAD`).
- **Message modes** — Direct, Nested (metadata privacy), and Routed (multi-hop
  through a relay/mediator).

Byte-compatibility is proven in three ways, because a round trip proves none of
it — encoder and decoder agree with each other whatever they both get wrong,
which is exactly the failure mode Rev 3's one-character changes produce:

- **The specification's own Appendix A vectors** run as a test suite
  (`tests/interop.spec-vectors.mjs`), fixed and external and produced by the
  ToIP reference implementation. Every published vector is either exercised or
  named as uncovered, so the list cannot quietly shrink.
- **Both directions against `affinidi-tsp`** — its Rev 2 vector unpacks here
  (`tests/interop.rust-vector.mjs`), and a message packed here unpacks there,
  thread digest included.
- **Pinned bytes** for the deterministic parts of what we emit, since the sealed
  message itself is not reproducible (HPKE draws a fresh ephemeral key).

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
  receiverEncryptionKey,  // X25519 public   — HPKE-Base recipient (seal to)
});
// packed.bytes: the qb2 TSP message. First byte 0xF8, or 0xFB past ~12 KB —
// Rev 3's `-E` count covers the ciphertext, so large messages are long-framed.
// `isTsp()` accepts both; a classifier that knows only 0xF8 silently drops them.

const msg = await unpack(packed.bytes, {
  receiverDecryptionKey,  // X25519 private — our key
  senderSigningKey,       // Ed25519 public — outer-signature verification
  senderEncryptionKey,    // X25519 public  — OPTIONAL, Rev 2 only (see below)
});
// msg.sender / msg.receiver (proven VIDs), msg.payload, and msg.revision.
```

`senderEncryptionKey` is Rev 2's alone: HPKE-Auth puts the sender's static key
in the KEM, so without it a Rev 2 message cannot be *opened*, let alone
verified. Omit it and a Rev 2 message is refused by name rather than by a
decryption failure. Rev 3 has no use for it at all.

```ts
import { peekRevision, isRevisionError } from "@openvtc/vti-tsp-js";

// Keyless, from the version marker — for routing, metrics, or deciding whether
// you hold the extra key a Rev 2 message needs.
const { revision, minor } = peekRevision(bytes);  // "rev3" | "rev2"
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
| `decodeEnvelope` | The `-E` cleartext envelope, dispatching on revision — keyless, for relays |
| `peekRevision` / `describeRevision` | Which revision framed a message, from its version marker alone |
| `TspRevisionError` / `isRevisionError` | A revision that could not be established or is not spoken; `code: "E_TSP_REVISION"` |
| `isTsp` | Ingress classifier — accepts both `0xF8` and `0xFB` framings |
| `sha256` | Thread-digest helper |
| `cesr` | Binary CESR frame primitives |
| `hpke` | RFC 9180 HPKE seal/open — auth mode (`seal`/`open`) and base mode (`sealBase`/`openBase`). Also importable directly as `@openvtc/vti-tsp-js/hpke`. |
| `sign` | Ed25519 sign/verify |

## Scope

Classical only, matching `affinidi-tsp`'s default build: no post-quantum suite
(§8.1/§8.2.1's ML-KEM-768/X25519 and ML-DSA-65). VID → key resolution is left to
the caller (DIDs resolve via whatever resolver the host app uses).

Deliberately **not** implemented, each for a stated reason rather than by
omission:

| Not here | Why |
| --- | --- |
| The libsodium sealed box (§8.3) | §8 tells new implementations not to use it. A `C`-coded ciphertext is *recognised* and refused by name, so it never reads as a corrupt `F`. |
| Relationship control messages (§7.2/§7.3) | `XRFI`/`XRFA`/`XRFD` are recognised and reported as `messageType: "control"`, but the state machine — gating, the invite race, cancellation — is protocol behaviour that belongs above a codec. **Note that Rev 3 gates application messages on a relationship by default**, so a peer enforcing §7.2.2 will drop what this package sends until that layer exists. |
| Fillable padding (§7.5) | The field is always written, always empty. Conformant, and leaves the traffic-analysis defence unimplemented rather than half-implemented. |
| Packing Rev 2 | See *Revisions* above. |

## Test

```sh
npm test
```

## License

Apache-2.0
