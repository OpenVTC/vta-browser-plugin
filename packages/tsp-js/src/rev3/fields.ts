// Rev 3 payload *field* codecs — the pieces every payload layout is built from.
//
// These live apart from both `payload.ts` (which dispatches on the type code)
// and `control.ts` (which composes the relationship-forming layouts) because
// both need them and neither owns them. Splitting them out is also what keeps
// the two from importing each other in a cycle.
//
// §9.2 gives every Rev 3 layout the same skeleton — type code, ESSR sender VID,
// type-specific fields, padding — so most of what differs between a generic
// message and an invite is which of these appear and in what order.

import * as wire from "../cesr/wire.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** SHA-256 digest length, and the width of a `TSP_Digest` field's payload. */
export const DIGEST_LEN = 32;
/** A digest field on the wire: the one-byte `I` code plus 32 bytes. This is the
 *  width the SAID derivation dummies out, so it is a constant rather than a
 *  computation at each use. */
export const ENCODED_DIGEST_LEN = 33;
/** §9.2 (D9) fixes the relationship nonce at 128 bits; Rev 2 used 256. The CESR
 *  code follows from the length, so this is the only place it is stated. */
export const NONCE_LEN = 16;
/** 64-byte Ed25519 signature, as carried in a referral. */
export const SIG_LEN = 64;

/** Generate a cryptographically random 128-bit nonce. */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_LEN);
  crypto.getRandomValues(nonce);
  return nonce;
}

/** The ESSR sender-VID field. Always written; the NULL VID is the empty string. */
export function encodeSenderField(senderVid: string, out: number[]): void {
  wire.encodeVariableData(wire.TSP_VID, utf8.encode(senderVid), out);
}

/** Bytes of the ESSR sender field, for the SAID derivation input. */
export function senderFieldBytes(senderVid: string): Uint8Array {
  const out: number[] = [];
  encodeSenderField(senderVid, out);
  return new Uint8Array(out);
}

/** The padding field — always empty here. §7.5 makes it fillable and excludes
 *  it from the digest derivation; we write it and leave it at zero width. */
export function encodeEmptyPadding(out: number[]): void {
  wire.encodeVariableData(wire.TSP_PLAINTEXT, new Uint8Array(0), out);
}

/** Read and discard the padding field, which every layout carries. */
export function decodePadding(frame: Uint8Array, cur: wire.Cursor): void {
  if (wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur) === undefined) {
    throw new Error("tsp: missing padding field");
  }
}

/** A `TSP_Digest` field, under the `I` (SHA-256) code.
 *
 *  The code is a property of the PKAE scheme, not the message: §8.3 pairs the
 *  sealed box with Blake2b-256 under `F`. We implement HPKE-Base only, so `I`
 *  is the only code that can appear — and a `F`-coded digest is refused here
 *  rather than at the comparison further on, where a wrong-scheme message would
 *  read as a tampered one. */
export function encodeDigest(digest: Uint8Array, out: number[]): void {
  if (digest.length !== DIGEST_LEN) throw new Error(`tsp: digest must be ${DIGEST_LEN} bytes`);
  wire.encodeFixedData(wire.TSP_SHA256, digest, out);
}

export function decodeDigest(frame: Uint8Array, cur: wire.Cursor): Uint8Array {
  const digest = wire.decodeFixedData(wire.TSP_SHA256, DIGEST_LEN, frame, cur);
  if (digest === undefined) {
    throw new Error("tsp: missing digest field, or one not coded for HPKE-Base");
  }
  return digest;
}

/** The relationship nonce field. */
export function encodeNonce(nonce: Uint8Array, out: number[]): void {
  if (nonce.length !== NONCE_LEN) throw new Error(`tsp: nonce must be ${NONCE_LEN} bytes`);
  wire.encodeFixedData(wire.TSP_NONCE, nonce, out);
}

export function decodeNonce(frame: Uint8Array, cur: wire.Cursor): Uint8Array {
  const nonce = wire.decodeFixedData(wire.TSP_NONCE, NONCE_LEN, frame, cur);
  if (nonce === undefined) throw new Error("tsp: missing or malformed nonce");
  return nonce;
}

/** Encode a `-J` VID list — a hop list, a reply path, or a referral group.
 *
 *  §9.2 changed the count to the group's **byte length** in quadlets, where
 *  Rev 2 counted VIDs. An empty list is `-JAA`, which is how an absent reply
 *  path, an absent referral and a non-routed nesting are all spelled. */
export function encodeVidList(vids: string[], out: number[]): void {
  const body: number[] = [];
  for (const vid of vids) wire.encodeVariableData(wire.TSP_VID, utf8.encode(vid), body);
  if (body.length % 3 !== 0) throw new Error("tsp: -J VID list not a multiple of 3 bytes");
  wire.encodeCount(wire.TSP_HOP_LIST, body.length / 3, out);
  for (const b of body) out.push(b);
}

/** Bytes of a `-J` VID list, for a derivation input. */
export function vidListBytes(vids: string[]): Uint8Array {
  const out: number[] = [];
  encodeVidList(vids, out);
  return new Uint8Array(out);
}

/** Decode a `-J` VID list. The declared byte length is authoritative: VIDs are
 *  read until it is exactly consumed, and a list whose fields overrun or
 *  underrun it is rejected rather than truncated. */
export function decodeVidList(stream: Uint8Array, cur: wire.Cursor): string[] {
  const quadlets = wire.decodeCount(wire.TSP_HOP_LIST, stream, cur);
  if (quadlets === undefined) throw new Error("tsp: missing -J VID list");
  const groupLen = quadlets * 3;
  if (groupLen > wire.MAX_FIELD_SIZE) throw new Error("tsp: -J VID list too long");
  const groupEnd = cur.pos + groupLen;
  if (groupEnd > stream.length) throw new Error("tsp: -J VID list overruns message");

  const vids: string[] = [];
  while (cur.pos < groupEnd) {
    if (vids.length >= wire.MAX_HOPS) throw new Error("tsp: too many hops");
    const vid = wire.decodeVariableData(wire.TSP_VID, stream, cur);
    if (vid === undefined) throw new Error("tsp: malformed VID in -J list");
    try {
      vids.push(fromUtf8.decode(vid));
    } catch {
      throw new Error("tsp: VID in -J list is not UTF-8");
    }
  }
  if (cur.pos !== groupEnd) throw new Error("tsp: -J VID list does not fill its declared length");
  return vids;
}

/** A bare `VID_new` field, as the SAID and referral-signature derivations
 *  carry it — without the `-J` group it sits inside on the wire. §9.3 is
 *  explicit that the referral field's "own code and count are not covered". */
export function bareVidBytes(vid: string): Uint8Array {
  const out: number[] = [];
  wire.encodeVariableData(wire.TSP_VID, utf8.encode(vid), out);
  return new Uint8Array(out);
}

/** An empty `-J` group, which is what an absent referral contributes. */
export function emptyVidListBytes(): Uint8Array {
  const out: number[] = [];
  wire.encodeCount(wire.TSP_HOP_LIST, 0, out);
  return new Uint8Array(out);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
