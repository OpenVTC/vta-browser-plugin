// Binary CESR wire primitives for TSP — a faithful TS port of
// affinidi-tsp `src/message/wire.rs`, which is itself ported from
// `tsp_sdk::cesr` (v0.9.0-alpha2). Byte-compatible with both, so the JS
// wallet and the Rust VTA frame TSP messages identically.
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

/** TSP version `(major, minor, patch)` advertised on the wire. */
export const TSP_VERSION = { major: 0, minor: 0, patch: 1 } as const;

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

/** `B`: var-data plaintext payload / VID / (fixed-data) Ed25519 signature id. */
export const TSP_PLAINTEXT = cesrInt("B"); // 1
export const TSP_VID = cesrInt("B"); // 1
export const ED25519_SIGNATURE = cesrInt("B"); // 1
/** `G`: var-data HPKE-Auth ciphertext. */
export const TSP_HPKEAUTH_CIPHERTEXT = cesrInt("G"); // 6
/** `X`: 2-byte fixed-data marker emitted after the envelope VIDs. */
export const TSP_TMP = cesrInt("X"); // 23
/** `A`: fixed-data id for a relationship nonce (32 bytes). */
export const TSP_NONCE = cesrInt("A"); // 0
/** `I`: fixed-data id for a SHA-256 digest (32 bytes). */
export const TSP_SHA256 = cesrInt("I"); // 8

/** `-E`: outer count wrapper for an encrypted-then-signed (ETS) envelope. */
export const TSP_ETS_WRAPPER = cesrInt("E"); // 4
/** `-Z`: count wrapper for the (to-be-encrypted) CESR payload frame. */
export const TSP_PAYLOAD = cesrInt("Z"); // 25
/** `-J`: count group for a hop (routing) list. */
export const TSP_HOP_LIST = cesrInt("J");
/** `-C`: count attach group for the signature. */
export const TSP_ATTACH_GRP = cesrInt("C"); // 2
/** `-K`: count indexed-signature group for the signature. */
export const TSP_INDEX_SIG_GRP = cesrInt("K"); // 10

/** 3-byte payload-type markers (byte-exact with the reference). */
export const XSCS = cesrData3("XSCS"); // Direct
export const XHOP = cesrData3("XHOP"); // Nested (empty hops) / Routed
export const XRFI = cesrData3("XRFI"); // relationship invite
export const XRFA = cesrData3("XRFA"); // relationship accept
export const XRFD = cesrData3("XRFD"); // relationship cancel
export const YTSP = cesrData3("YTSP"); // TSP version genus marker

const encodedVersion = (): number => (TSP_VERSION.minor << 6) | TSP_VERSION.patch;

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

/** Encode a count-code group header carrying `count` quadlets. */
export function encodeCount(identifier: number, count: number, out: number[]): void {
  if (count < 4096) {
    const word = (DASH << 18) | (bits(identifier, 6) << 12) | bits(count, 12);
    for (const b of beBytes(word)) out.push(b);
  } else {
    const word1 =
      (DASH << 18) | (D0 << 12) | (bits(identifier, 6) << 6) | bits(count >>> 24, 6);
    const word2 = bits(count, 24);
    for (const b of beBytes(word1)) out.push(b);
    for (const b of beBytes(word2)) out.push(b);
  }
}

/** Encode the TSP version marker (`YTSP` genus + version count code). */
export function encodeVersion(out: number[]): void {
  for (const b of YTSP) out.push(b);
  encodeCount(TSP_VERSION.major, encodedVersion(), out);
}

/** Encode a hop (routing) list: a `-J<count>` header + one `B` var-data field
 *  per hop VID. An empty list encodes to just the `-J0` header. */
export function encodeHops(hops: Uint8Array[], out: number[]): void {
  encodeCount(TSP_HOP_LIST, hops.length, out);
  for (const hop of hops) encodeVariableData(TSP_VID, hop, out);
}

// ---- Decoding ----

/** A mutable read cursor into a byte stream. */
export interface Cursor {
  pos: number;
}

/** Decode a count-code group header for `identifier`. Advances `cur` and
 *  returns the quadlet count, or undefined on mismatch. */
export function decodeCount(
  identifier: number,
  stream: Uint8Array,
  cur: Cursor,
): number | undefined {
  const word = triplet(stream, cur.pos);
  if (word === undefined) return undefined;
  const index = word & bitsMask(12);
  const expected =
    ((DASH << 18) | (bits(identifier, 6) << 12) | bits(index, 12)) >>> 0;
  const expectedLong =
    ((DASH << 18) | (D0 << 12) | (bits(identifier, 6) << 6) | bits(index & 0x3f, 6)) >>> 0;
  if (word === expected) {
    cur.pos += 3;
    return index;
  }
  if (word === expectedLong) {
    const next = triplet(stream, cur.pos + 3);
    if (next === undefined) return undefined;
    cur.pos += 6;
    return ((index << 24) | next) >>> 0;
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

/** Max hops accepted in a routed message's hop list (bounds a hostile count). */
export const MAX_HOPS = 10;

/** Decode a hop (routing) list. Advances `cur` past the `-J` group + hops. */
export function decodeHops(stream: Uint8Array, cur: Cursor): Uint8Array[] | undefined {
  const count = decodeCount(TSP_HOP_LIST, stream, cur);
  if (count === undefined) return undefined;
  if (count > MAX_HOPS) return undefined;
  const hops: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const hop = decodeVariableData(TSP_VID, stream, cur);
    if (hop === undefined) return undefined;
    hops.push(hop);
  }
  return hops;
}

/** Decode + validate the TSP version marker. Advances `cur`. Returns whether
 *  the marker was well-formed. */
export function decodeVersion(stream: Uint8Array, cur: Cursor): boolean {
  if (cur.pos + YTSP.length > stream.length) return false;
  for (let i = 0; i < YTSP.length; i++) {
    if (stream[cur.pos + i]! !== YTSP[i]!) return false;
  }
  cur.pos += YTSP.length;
  return decodeCount(TSP_VERSION.major, stream, cur) !== undefined;
}
