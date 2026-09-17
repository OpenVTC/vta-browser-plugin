// Binary CESR wire primitives for TSP — a faithful TS port of
// affinidi-tsp `src/message/wire.rs`, which is itself ported from
// `tsp_sdk::cesr`. Byte-compatible with both, so the JS wallet and the Rust
// VTA frame TSP messages identically.
//
// TSP uses a compact *binary* CESR domain: each frame packs a
// `selector | identifier | size` triple into the leading bits of the header
// and encodes lead-padding bytes in the selector. This is a different encoding
// from text/qb64 CESR — do not reuse a general CESR lib for it.
//
// Frame kinds:
//   - fixed data     `encodeFixedData(id, payload)`   — selector|id header sized
//                                                        to pad len up to a ×3.
//   - variable data  `encodeVariableData(id, payload)` — selector(D4+lead)|id|size
//                                                        header + lead zeros + data.
//   - count code     `encodeCount(id, count)`          — a `-`-framed group header
//                                                        carrying a quadlet count.
//
// ── Two revisions ──
//
// The frame *primitives* — fixed data, variable data, the short count code —
// are identical in spec Rev 2 and Rev 3, so they live here once. Exactly two
// things in this file are revision-dependent, and both are decode-side only
// because this package packs Rev 3 and nothing else (see `../revision.ts`):
//
//   1. The long count code's second selector: Rev 2 spelled it `-0X#####`,
//      Rev 3 spells it `--X#####`. `decodeCount` takes the form to expect.
//   2. The code table. Rev 3 struck HPKE-Auth's `G` ciphertext and the `X`
//      trailing marker and added `F`, `C`, `-A`, `XCTL` and `XPAD`. Both sets
//      are named below; the revision modules pick.

// CESR base64url selector values (index of the char in the base64url alphabet).
const D0 = 52; // '0'
const D1 = D0 + 1;
const D4 = D0 + 4;
const D5 = D0 + 5;
const D6 = D0 + 6;
const D7 = D0 + 7;
const D8 = D0 + 8;
const D9 = D0 + 9;
const DASH = 62; // '-'

/** Max size accepted for a single variable-data field (mirrors the reference's
 *  `DATA_LIMIT = 3 * (1 << 24)`, ~48 MiB). Guards against hostile size headers. */
export const MAX_FIELD_SIZE = 3 * (1 << 24);

/** Which spelling of the *long* count code a decoder should expect.
 *
 *  The value is the second selector of the six-byte header. Rev 2 used `0`
 *  (D0), from a superseded draft of the CESR v2 tables; Rev 3 pins the master
 *  table for genus `-_AAACAA`, which carries only the double-dash form. One
 *  character, and encoder and decoder agree with themselves either way — which
 *  is why `cesr.wire.mjs` pins the bytes rather than round-tripping them. */
export const LONG_COUNT_REV2 = D0;
/** @see LONG_COUNT_REV2 */
export const LONG_COUNT_REV3 = DASH;

/** TSP version `(major, minor)` this package **packs** — Rev 3, `YTSP-AAC`.
 *
 *  MAJOR.MINOR, two components rather than three: MINOR occupies the whole
 *  12-bit count. Pre-merge drafts of §9.1 read the three characters as MAJOR,
 *  MINOR, PATCH and gave `YTSP-ABA`; affinidi-tsp deliberately does not follow
 *  that reading, and neither do we — see that crate's `TSP_VERSION` for the
 *  argument. The merged specification's Appendix A vectors carry `YTSP-AAC`,
 *  the marker packed here. Nothing about interoperating depends on the choice: only MAJOR
 *  gates processability, it is the same character either way, and no
 *  implementation refuses a message on MINOR. */
export const TSP_VERSION = { major: 0, minor: 2 } as const;

/** The MINOR value Rev 2 carried (`YTSP-AAB`). Read, never written. */
export const REV2_MINOR = 1;

/** Interpret a base64url string as a big-endian integer of its 6-bit symbols.
 *  Only used on ASCII base64url constants ≤ 4 chars (≤ 24 bits), so a JS number
 *  is exact. */
export function cesrInt(s: string): number {
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    let v: number;
    if (ch >= 0x41 && ch <= 0x5a) v = ch - 0x41; // A-Z
    else if (ch >= 0x61 && ch <= 0x7a) v = ch - 0x61 + 26; // a-z
    else if (ch >= 0x30 && ch <= 0x39) v = ch - 0x30 + 52; // 0-9
    else if (ch === 0x2d) v = 62; // '-'
    else if (ch === 0x5f) v = 63; // '_'
    else v = 0;
    acc = (acc << 6) | v;
  }
  return acc >>> 0;
}

/** The 3-byte big-endian form of a short CESR code (for markers like `XSCS`). */
function cesrData3(s: string): Uint8Array {
  const val = cesrInt(s);
  return new Uint8Array([(val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff]);
}

const bitsMask = (n: number): number => (1 << n) - 1;
const bits = (value: number, n: number): number => value & bitsMask(n);
const beBytes = (word: number): [number, number, number] => [
  (word >>> 16) & 0xff,
  (word >>> 8) & 0xff,
  word & 0xff,
];
const nextMul3 = (n: number): number => n + ((3 - (n % 3)) % 3);

function triplet(stream: Uint8Array, i: number): number | undefined {
  if (i + 3 > stream.length) return undefined;
  return ((stream[i]! << 16) | (stream[i + 1]! << 8) | stream[i + 2]!) >>> 0;
}

// ---- TSP identifiers / framing codes (from tsp_sdk::cesr::packet) ----

/** `B`: var-data plaintext payload / VID / padding / (fixed-data) Ed25519
 *  signature id. An empty VID field encodes to `4BAA` — the Rev 3 NULL VID,
 *  which is how "absent" is spelled for every VID-shaped field. */
export const TSP_PLAINTEXT = cesrInt("B"); // 1
export const TSP_VID = cesrInt("B"); // 1
export const ED25519_SIGNATURE = cesrInt("B"); // 1
/** `G`: var-data HPKE-Auth ciphertext. **Rev 2 only** — Rev 3 strikes the `G`
 *  codes from the table along with HPKE-Auth itself. */
export const TSP_HPKEAUTH_CIPHERTEXT = cesrInt("G"); // 6
/** `F`: var-data HPKE-Base ciphertext (Rev 3 §9.4). */
export const TSP_HPKE_BASE_CIPHERTEXT = cesrInt("F"); // 5
/** `C`: var-data libsodium sealed-box ciphertext (Rev 3 §8.3).
 *
 *  Named so a decoder can *recognise* the scheme and say so, rather than fail
 *  at the `F` selector with "missing ciphertext". We do not implement the
 *  sealed box: §8 tells new implementations not to use it, and our only TSP
 *  peers are the VTA and the mediator, which do not send one. */
export const TSP_SEALED_BOX_CIPHERTEXT = cesrInt("C"); // 2
/** `X`: 2-byte fixed-data marker emitted after the envelope VIDs. **Rev 2
 *  only** — Rev 3 deletes it and always writes the receiver-VID field. */
export const TSP_TMP = cesrInt("X"); // 23
/** `A`: fixed-data id for a relationship nonce (32 bytes in Rev 2, 16 in
 *  Rev 3 — the code follows from the payload length). */
export const TSP_NONCE = cesrInt("A"); // 0
/** `I`: fixed-data id for a SHA-256 digest (32 bytes). */
export const TSP_SHA256 = cesrInt("I"); // 8

/** `-E`: the envelope frame.
 *
 *  Rev 2's count covered only the header fields; Rev 3's covers *all* signable
 *  content — version, VIDs and the ciphertext — so it cannot be written until
 *  the ciphertext size is known. Rev 2's separate `-S` signed-only wrapper is
 *  gone in Rev 3. */
export const TSP_ETS_WRAPPER = cesrInt("E"); // 4
/** `-Z`: count wrapper for the (to-be-encrypted) CESR payload frame. */
export const TSP_PAYLOAD = cesrInt("Z"); // 25
/** `-J`: count group for a hop (routing) list — and in Rev 3 also for the
 *  reply path and the referral field.
 *
 *  Rev 3 §9.2 changed what the count means: it is the **byte length** of the
 *  group in quadlets, not the number of VIDs in it. */
export const TSP_HOP_LIST = cesrInt("J"); // 9
/** `-A`: generic CESR stream, the container Rev 3 §9.2.3 requires around every
 *  `XSCS` / `XCTL` upper-layer payload. Rev 2 had no such wrapper. */
export const TSP_GENERIC_STREAM = cesrInt("A"); // 0
/** `-C`: count attach group for the signature. */
export const TSP_ATTACH_GRP = cesrInt("C"); // 2
/** `-K`: count indexed-signature group for the signature. */
export const TSP_INDEX_SIG_GRP = cesrInt("K"); // 10

/** 3-byte payload-type markers (byte-exact with the reference). */
export const XSCS = cesrData3("XSCS"); // generic message / Direct
export const XHOP = cesrData3("XHOP"); // Nested (empty hops) / Routed
export const XRFI = cesrData3("XRFI"); // relationship invite
export const XRFA = cesrData3("XRFA"); // relationship accept
export const XRFD = cesrData3("XRFD"); // relationship cancel
export const XCTL = cesrData3("XCTL"); // generic control payload (Rev 3)
export const XPAD = cesrData3("XPAD"); // padding-only message (Rev 3)
export const YTSP = cesrData3("YTSP"); // TSP version genus marker

/** The TSP protocol code `YTSP-`, used verbatim as the Rev 3 HPKE-Base `info`
 *  (§8). Five ASCII characters, not the 3-byte binary {@link YTSP} marker —
 *  Rev 2 passed the whole envelope frame as `info` instead. */
export const TSP_INFO = new TextEncoder().encode("YTSP-");

/** The leading byte of a TSP message framed with a **short** `-E` count code
 *  (`-E##`). The triplet is `f8 4X XX` — `f8` is the `-` (DASH) selector packed
 *  with the `E` identifier. */
export const TSP_MAGIC_BYTE = 0xf8;
/** The leading byte of a TSP message framed with a **long** `-E` count code,
 *  which is `0xFB` for both revisions' spellings.
 *
 *  Rev 2 could never emit it: its `-E` count covered only the envelope header,
 *  a couple of dozen quadlets whatever the message size. Rev 3 widened the
 *  count to cover the ciphertext, so any message past ~12 KB is framed long.
 *  An ingress classifier that knows only `0xF8` starts dropping large messages
 *  the moment Rev 3 is switched on. */
export const TSP_MAGIC_BYTE_LONG = 0xfb;

/** Cheap ingress classifier: does `bytes` look like a TSP message?
 *
 *  A pre-classifier for routing, not a validator — it inspects only the leading
 *  byte, and the caller then parses. DIDComm, being JSON or compact JWS, starts
 *  with `{` (`0x7B`) or `ey…`, so neither byte is ambiguous against it. */
export function isTsp(bytes: Uint8Array): boolean {
  const first = bytes[0];
  return first === TSP_MAGIC_BYTE || first === TSP_MAGIC_BYTE_LONG;
}

// ---- Encoding ----

/** Encode fixed-size data with a known identifier. */
export function encodeFixedData(identifier: number, payload: Uint8Array, out: number[]): void {
  const total = nextMul3(payload.length + 1);
  const hdr = total - payload.length;
  let word: number;
  if (hdr === 1) word = bits(identifier, 6) << 18;
  else if (hdr === 2) word = (D0 << 18) | (bits(identifier, 6) << 12);
  else word = (D1 << 18) | bits(identifier, 18);
  const hb = beBytes(word);
  for (let i = 0; i < hdr; i++) out.push(hb[i]!);
  for (let i = 0; i < payload.length; i++) out.push(payload[i]!);
}

/** Encode variable-size data with a known identifier. */
export function encodeVariableData(identifier: number, payload: Uint8Array, out: number[]): void {
  const padded = nextMul3(payload.length);
  const lead = padded - payload.length;
  const selector = D4 + lead;
  const size = padded / 3;

  if (size < 64 * 64 && identifier < 64) {
    const word = (bits(selector, 6) << 18) | (bits(identifier, 6) << 12) | bits(size, 12);
    for (const b of beBytes(word)) out.push(b);
  } else {
    const word = (bits(selector + 3, 6) << 18) | bits(identifier, 18);
    for (const b of beBytes(word)) out.push(b);
    for (const b of beBytes(bits(size, 24))) out.push(b);
  }
  for (let i = 0; i < lead; i++) out.push(0);
  for (let i = 0; i < payload.length; i++) out.push(payload[i]!);
}

/** Encode a count-code group header carrying `count` quadlets.
 *
 *  Always the Rev 3 long spelling `--X#####`, because this package packs Rev 3
 *  and nothing else. A Rev 2 message is read, never written. */
export function encodeCount(identifier: number, count: number, out: number[]): void {
  if (count < 4096) {
    const word = (DASH << 18) | (bits(identifier, 6) << 12) | bits(count, 12);
    for (const b of beBytes(word)) out.push(b);
  } else {
    const word1 =
      (DASH << 18) | (LONG_COUNT_REV3 << 12) | (bits(identifier, 6) << 6) | bits(count >>> 24, 6);
    const word2 = bits(count, 24);
    for (const b of beBytes(word1)) out.push(b);
    for (const b of beBytes(word2)) out.push(b);
  }
}

/** Encode the TSP version marker (`YTSP` genus + version count code). */
export function encodeVersion(out: number[]): void {
  for (const b of YTSP) out.push(b);
  encodeCount(TSP_VERSION.major, TSP_VERSION.minor, out);
}

/** Encode an *indexed* Ed25519 signature (`B#` + 64 bytes), the Rev 3 §9.5
 *  attachment. Rev 2 used the non-indexed fixed-data code `0B` — the same 66
 *  bytes with a different two-byte header, which is why only a byte-level test
 *  catches a regression here. */
export function encodeIndexedEd25519Signature(
  index: number,
  signature: Uint8Array,
  out: number[],
): void {
  const word = (bits(ED25519_SIGNATURE, 6) << 18) | (bits(index, 6) << 12);
  const hb = beBytes(word);
  out.push(hb[0]!, hb[1]!);
  for (let i = 0; i < signature.length; i++) out.push(signature[i]!);
}

// ---- Decoding ----

/** A mutable read cursor into a byte stream. */
export interface Cursor {
  pos: number;
}

/** Decode a count-code group header for `identifier`. Advances `cur` and
 *  returns the quadlet count, or undefined on mismatch.
 *
 *  `longForm` is the second selector to accept for the six-byte long header —
 *  {@link LONG_COUNT_REV3} (the default) or {@link LONG_COUNT_REV2}. */
export function decodeCount(
  identifier: number,
  stream: Uint8Array,
  cur: Cursor,
  longForm: number = LONG_COUNT_REV3,
): number | undefined {
  const word = triplet(stream, cur.pos);
  if (word === undefined) return undefined;
  const index = word & bitsMask(12);
  const expected =
    ((DASH << 18) | (bits(identifier, 6) << 12) | bits(index, 12)) >>> 0;
  const expectedLong =
    ((DASH << 18) | (longForm << 12) | (bits(identifier, 6) << 6) | bits(index & 0x3f, 6)) >>> 0;
  if (word === expected) {
    cur.pos += 3;
    return index;
  }
  if (word === expectedLong) {
    const next = triplet(stream, cur.pos + 3);
    if (next === undefined) return undefined;
    cur.pos += 6;
    // The long count is 30 bits: the high 6 live in the low 6 bits of this
    // word, *alongside the identifier*, and the low 24 in the next. `index`
    // still carries the identifier in its upper bits, so it must be masked
    // before being shifted in — unmasked, the count comes back enormous. Rev 2
    // never emitted a long `-E`, which is why this went unnoticed; Rev 3 frames
    // everything past ~12 KB this way.
    return (((index & 0x3f) << 24) | next) >>> 0;
  }
  return undefined;
}

/** Decode fixed-size data of `n` bytes with a known identifier. Advances `cur`
 *  and returns the `n` data bytes, or undefined on mismatch. */
export function decodeFixedData(
  identifier: number,
  n: number,
  stream: Uint8Array,
  cur: Cursor,
): Uint8Array | undefined {
  const total = nextMul3(n + 1);
  const hdr = total - n;
  let word: number;
  if (hdr === 1) word = bits(identifier, 6) << 18;
  else if (hdr === 2) word = (D0 << 18) | (bits(identifier, 6) << 12);
  else if (hdr === 3) word = (D1 << 18) | bits(identifier, 18);
  else return undefined;
  const hb = beBytes(word);
  if (cur.pos + total > stream.length) return undefined;
  for (let i = 0; i < hdr; i++) {
    if (stream[cur.pos + i]! !== hb[i]!) return undefined;
  }
  const data = stream.slice(cur.pos + hdr, cur.pos + total);
  cur.pos += total;
  return data;
}

/** Decode a variable-data field, returning its `[begin, end)` byte range within
 *  `stream`. Advances `cur` past the field. */
export function decodeVariableDataRange(
  identifier: number,
  stream: Uint8Array,
  cur: Cursor,
): { begin: number; end: number } | undefined {
  const head = triplet(stream, cur.pos);
  if (head === undefined) return undefined;
  const selector = head >>> 18;

  let size: number;
  let foundId: number;
  if (selector === D4 || selector === D5 || selector === D6) {
    foundId = (head >>> 12) & bitsMask(6);
    size = head & bitsMask(12);
  } else if (selector === D7 || selector === D8 || selector === D9) {
    foundId = head & bitsMask(18);
    const s2 = triplet(stream, cur.pos + 3);
    if (s2 === undefined) return undefined;
    size = s2;
  } else {
    return undefined;
  }

  if (foundId !== identifier) return undefined;
  if (size * 3 > MAX_FIELD_SIZE) return undefined;

  const offset = selector - D4;
  const dataBegin = offset + 3;
  const dataEnd = nextMul3(offset + 1) + 3 * size;
  if (cur.pos + dataEnd > stream.length) return undefined;
  const range = { begin: dataBegin + cur.pos, end: dataEnd + cur.pos };
  cur.pos = range.end;
  return range;
}

/** Decode a variable-data field, returning a copy of its bytes. */
export function decodeVariableData(
  identifier: number,
  stream: Uint8Array,
  cur: Cursor,
): Uint8Array | undefined {
  const range = decodeVariableDataRange(identifier, stream, cur);
  if (range === undefined) return undefined;
  return stream.slice(range.begin, range.end);
}

/** Max hops accepted in a routed message's hop list or reply path (bounds a
 *  hostile count). The spec sets no maximum, so this is a local choice that
 *  caps interoperability: 64 matches the other affinidi TSP implementations.
 *  It was 10, which refused 12-hop routes every other implementation opens. */
export const MAX_HOPS = 64;

/** Read the `YTSP` genus marker and its version count code. Advances `cur`.
 *
 *  Returns the raw `(major, minor)` without judging either: the caller decides
 *  what to do with them, because "which revision is this?" is the one question
 *  that has to be answered before anything else can be parsed. */
export function readVersion(
  stream: Uint8Array,
  cur: Cursor,
): { major: number; minor: number } | undefined {
  if (cur.pos + YTSP.length > stream.length) return undefined;
  for (let i = 0; i < YTSP.length; i++) {
    if (stream[cur.pos + i]! !== YTSP[i]!) return undefined;
  }
  const word = triplet(stream, cur.pos + YTSP.length);
  if (word === undefined) return undefined;
  if (word >>> 18 !== DASH) return undefined;
  cur.pos += YTSP.length + 3;
  return { major: (word >>> 12) & bitsMask(6), minor: word & bitsMask(12) };
}
