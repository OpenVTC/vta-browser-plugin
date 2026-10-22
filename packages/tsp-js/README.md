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

## Version: TSP 1.0

This package speaks the released **TSP 1.0** specification (`YTSP-BAA`) and
nothing else, in step with [`affinidi-tsp`](https://crates.io/crates/affinidi-tsp)
0.3 and the ToIP reference `tsp_sdk` 0.16.

`unpack` and `decodeEnvelope` read the version marker first — it sits at a fixed
offset and needs no keys — and refuse any MAJOR but 1 with a `TspRevisionError`
(`code: "E_TSP_REVISION"`) that names the version found. That includes the two
drafts: Rev 2 (`YTSP-AAB`, 0.1) and Rev 3 (`YTSP-AAC`, 0.2). There is no
negotiation in the protocol; a peer still on a draft has to upgrade.

1.0 is Rev 3's wire with one payload rule changed: the ESSR sender field must
carry the sender's VID in every confidential payload, where Rev 3 let HPKE-Base
write the NULL VID `4BAA`. This package always wrote it; on receive, a NULL
sender is now refused.

## Relationships

§7.2.2: an endpoint SHOULD **drop** an application message from a VID it
holds no relationship with. Dropped, not refused — nothing comes back — so a
client that skips the handshake sees a timeout, not an error.

```ts
import { packInvite, packAccept, transition, canSend } from "@openvtc/vti-tsp-js";

const invite = await packInvite(ourVid, theirVid, keys);
// `invite.threadDigest` is the exchange's thread id. Keep it: the accept echoes
// it back, and a later cancellation names it. It cannot be known in advance —
// the digest is self-addressing over the envelope this call builds.

// …on receiving their accept:
const accept = await unpack(bytes, unpackKeys);
accept.control.inReplyTo; // equals invite.threadDigest
```

The state machine (`transition`, `canSend`, `admitsApplicationMessage`,
`resolveInviteRace`, `resolveAccept`, `resolveCancel`) is **pure** — state and event in, state or
a refusal out. No storage, no clock, no keys. That is the line: this package
owns what the protocol says happens next, and the client owns where that is
written down.

`unpack` deliberately does **not** apply it. A codec that mutated relationship
state would make receiving a message a side effect, and the one thing a client
must be able to do is look at an invite before answering it.

Two rules worth knowing before you use it:

- **An accept's two digests are not interchangeable.** The wire order is
  `Digest` then `Reply_Digest`, and — counter to how those read — the first is
  the *invite's* digest echoed and the second is the accept's own. This package
  names them `inReplyTo` and `digest` so the trap cannot spring.
- **The invite race (§7.2.3) is decided on bytes.** Both endpoints keep the
  invite with the lexicographically lower digest, so simultaneous invites
  converge on one exchange. No timestamps, no "ours wins" — either would let the
  two sides disagree and form two half-relationships.

## What it does

A TSP message is **encrypted-then-signed** (ETS): the payload is HPKE sealed to
the recipient, then the whole CESR frame is Ed25519-signed. VIDs are DIDs. This
package owns the wire layer — CESR encode/decode, the `-E` envelope, HPKE
seal/open, Ed25519 sign/verify, and `pack`/`unpack` for Direct, Nested, and
Routed messages.

- **HPKE-Base** — RFC 9180, `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` +
  `ChaCha20Poly1305`. The fixed code `YTSP-` is the HPKE `info`, and
  `TSP_Version ‖ VID_sndr ‖ VID_rcvr` is real AAD. The sender's key does not
  enter the KEM — sender authenticity is the ESSR sender field plus the outer
  signature.
- **CESR** — binary `qb2` framing (selectors `-E`, `-Z`, `-A`, `-J`, `B`, `F`,
  `I`; markers `YTSP`, `XSCS`/`XHOP`, `XRFI`/`XRFA`/`XRFD`/`XCTL`/`XPAD`).
- **Message modes** — Direct, Nested (metadata privacy), and Routed (multi-hop
  through a relay/mediator).
- **Relationships** — `XRFI` / `XRFA` / `XRFD`, the §7.2.1 self-addressing
  digest, and the §7.2/§7.3 state machine. TSP gates application messages on
  a relationship, so this is a precondition for sending anything, not an
  optional extra.

Byte-compatibility is proven in three ways, because a round trip proves none of
it — encoder and decoder agree with each other whatever they both get wrong,
which is exactly the failure mode one-character wire changes produce:

- **The specification's own Appendix A vectors** (`YTSP-BAA`, TSP 1.0 at
  [tswg-tsp-specification@ccda6b3](https://github.com/trustoverip/tswg-tsp-specification/commit/ccda6b33159d860f05c328eb436dabe83548b705))
  run as a test suite, fixed and external and produced by the ToIP reference
  implementation. Every HPKE-Base vector opens
  (`tests/interop.spec-vectors.mjs`, `tests/control.spec-vectors.mjs`), and
  every one this package can pack **re-packs byte for byte** from its published
  `ikmE` (`tests/interop.spec-vectors-repack.mjs`). Every published vector is
  either exercised or named as uncovered, so the list cannot quietly shrink.
- **Both directions against `affinidi-tsp` 0.3** — a message it packed unpacks
  here (`tests/interop.rust-vector.mjs`), and a message packed here unpacks
  there, thread digest included.
- **Pinned bytes** for the deterministic parts of what we emit, since the sealed
  message itself is not reproducible (HPKE draws a fresh ephemeral key). The
  vector re-pack fixes that key through a test-only subpath,
  `@openvtc/vti-tsp-js/unsafe-testing`, which is deliberately not part of the
  API above: a fixed ephemeral key destroys confidentiality, and nothing but a
  test reproducing a published vector has a reason to import it.

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
// The `-E` count covers the ciphertext, so large messages are long-framed.
// `isTsp()` accepts both; a classifier that knows only 0xF8 silently drops them.

const msg = await unpack(packed.bytes, {
  receiverDecryptionKey,  // X25519 private — our key
  senderSigningKey,       // Ed25519 public — outer-signature verification
});
// msg.sender / msg.receiver (proven VIDs), msg.payload.
```

```ts
import { peekRevision, isRevisionError } from "@openvtc/vti-tsp-js";

// Keyless, from the version marker. Throws TspRevisionError for any MAJOR but
// 1 — e.g. a peer still on a draft — before a key is touched.
const { major, minor } = peekRevision(bytes);  // 1, 0
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
| `decodeEnvelope` | The `-E` cleartext envelope of a 1.0 message — keyless, for relays |
| `peekRevision` / `describeRevision` / `describeVersion` | The version a message declares, from its marker alone; refuses any MAJOR but 1 |
| `TspRevisionError` / `isRevisionError` | A version that could not be established or is not spoken; `code: "E_TSP_REVISION"` |
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
| Composing a referral (§7.2.5) | A referral's `Signature_new` covers the invite's digest, so composing one needs the *introduced* VID's signing key at pack time. A wallet holding another VID's private key is not a shape this package should invite. Referrals are decoded and exposed unverified, with `referralSignedData` for a caller that can resolve `VID_new` and check. |
| Fillable padding (§7.5) | The field is always written, always empty. Conformant, and leaves the traffic-analysis defence unimplemented rather than half-implemented. |
| Reading or packing the Rev 2 / Rev 3 drafts | See *Version* above. |

## Test

```sh
npm test
```

## License

Apache-2.0
