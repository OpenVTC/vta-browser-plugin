// The Rev 3 CESR payload frame — the plaintext that gets sealed (§9.2/§9.3).
//
// Every Rev 3 layout has the same shape: type code, ESSR sender VID,
// type-specific fields, padding. Rev 2 had none of the first two and none of
// the last.
//
//   Direct  -Z<n> XSCS  sndr  pad  -A<n> <B body>
//   Nested  -Z<n> XHOP  sndr  -JAA        pad  <raw inner message>
//   Routed  -Z<n> XHOP  sndr  -J<n> hops  pad  <raw inner message>
//   Invite  -Z<n> XRFI  sndr  Digest  Nonce  Reply_Path  Referral  pad
//   Accept  -Z<n> XRFA  sndr  Digest  Reply_Digest                 pad
//   Cancel  -Z<n> XRFD  sndr  Digest                               pad
//
// Three of those we compose and read in full; the control layouts we
// *recognise* and no more — see `ControlType`. That is a deliberate stopping
// point, not an oversight: the relationship state machine (§7.2.2's gating,
// §7.2.3's invite race, §7.3's cancellations) is protocol behaviour that
// belongs above a codec, and half of one would be worse than none.
//
// ── The ESSR sender field ──
//
// Rev 3 moved sender authenticity out of the KEM: HPKE-Base does not
// authenticate a sender, so the binding is the AAD plus this field plus the
// outer signature. Under HPKE-Base the field MAY be the NULL VID; when it is
// not, it MUST equal the envelope sender, and §3.7 step 7 has the receiver
// check exactly that. We always write it and always check it — the spec's own
// security considerations note the two bindings are then independent, which is
// the argument for not resting sender authenticity on one mechanism.
//
// ── Padding ──
//
// Every layout ends its fixed part with a padding field, and an absent padding
// is the empty field `4BAA` — present, not omitted. §7.5 makes it fillable and
// excludes it from the digest derivation so that filling it cannot change what
// was signed; we always write it empty, which is conformant and leaves the
// traffic-analysis defence unimplemented rather than half-implemented.

import { sha256 } from "@noble/hashes/sha2.js";

import * as wire from "../cesr/wire.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** What kind of message a payload frame carries. */
export type MessageType = "direct" | "nested" | "routed" | "control" | "padding";

/** Which control message, when `messageType` is `"control"`. */
export type ControlType = "invite" | "accept" | "cancel" | "generic";

export interface DecodedFrame {
  kind: MessageType;
  /** Set only when `kind` is `"control"`. */
  controlType?: ControlType;
  /** Remaining route (Routed only). */
  hops: string[];
  /** The plaintext body: the upper-layer payload for Direct, the raw inner
   *  message for Nested/Routed, empty for a control or padding frame. */
  body: Uint8Array;
  /** The ESSR sender VID as carried, or `""` for the NULL VID. */
  senderVid: string;
  /** SHA-256 over the whole `-Z` frame — the thread digest. */
  threadDigest: Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Encode a `-J` VID list. The count is the group's **byte length** in
 *  quadlets, not the number of VIDs — Rev 2 counted VIDs. An empty list is
 *  `-JAA`, which is how an absent reply path, an absent referral and a
 *  non-routed nesting are all spelled. */
function encodeHops(hops: string[], out: number[]): void {
  const body: number[] = [];
  for (const hop of hops) wire.encodeVariableData(wire.TSP_VID, utf8.encode(hop), body);
  if (body.length % 3 !== 0) throw new Error("tsp: -J VID list not a multiple of 3 bytes");
  wire.encodeCount(wire.TSP_HOP_LIST, body.length / 3, out);
  for (const b of body) out.push(b);
}

/** Decode a `-J` VID list. The group's declared byte length is authoritative:
 *  VIDs are read until it is exactly consumed, and a list whose fields overrun
 *  or underrun it is rejected rather than truncated. */
function decodeHops(stream: Uint8Array, cur: wire.Cursor): Uint8Array[] {
  const quadlets = wire.decodeCount(wire.TSP_HOP_LIST, stream, cur);
  if (quadlets === undefined) throw new Error("tsp: missing -J VID list");
  const groupLen = quadlets * 3;
  if (groupLen > wire.MAX_FIELD_SIZE) throw new Error("tsp: -J VID list too long");
  const groupEnd = cur.pos + groupLen;
  if (groupEnd > stream.length) throw new Error("tsp: -J VID list overruns message");

  const hops: Uint8Array[] = [];
  while (cur.pos < groupEnd) {
    if (hops.length >= wire.MAX_HOPS) throw new Error("tsp: too many hops");
    const hop = wire.decodeVariableData(wire.TSP_VID, stream, cur);
    if (hop === undefined) throw new Error("tsp: malformed hop VID");
    hops.push(hop);
  }
  if (cur.pos !== groupEnd) throw new Error("tsp: -J VID list does not fill its declared length");
  return hops;
}

/** Write the padding field — always empty. @see the module note. */
function encodeEmptyPadding(out: number[]): void {
  wire.encodeVariableData(wire.TSP_PLAINTEXT, new Uint8Array(0), out);
}

/**
 * Build the payload frame that gets sealed, and the thread digest over it.
 *
 * `kind` must be `"direct"`, `"nested"` or `"routed"` — we do not compose
 * control messages.
 */
export function encodePayloadFrame(
  body: Uint8Array,
  kind: "direct" | "nested" | "routed",
  hops: string[],
  senderVid: string,
): { frame: Uint8Array; threadDigest: Uint8Array } {
  const frameBody: number[] = [];

  if (kind === "direct") {
    for (const b of wire.XSCS) frameBody.push(b);
    wire.encodeVariableData(wire.TSP_VID, utf8.encode(senderVid), frameBody);
    encodeEmptyPadding(frameBody);
    // §9.2.3: the upper-layer payload is a generic CESR stream holding a Bytes
    // primitive. We carry the caller's bytes opaquely and deliberately do NOT
    // wrap them in the non-native message group `-H##`: that group is required
    // for a JSON, CBOR or MsgPak serialization, and that requirement binds the
    // upper layer. A caller handing us opaque bytes has not told us it is
    // sending JSON, and guessing would be wrong in both directions.
    const stream: number[] = [];
    wire.encodeVariableData(wire.TSP_PLAINTEXT, body, stream);
    wire.encodeCount(wire.TSP_GENERIC_STREAM, stream.length / 3, frameBody);
    for (const b of stream) frameBody.push(b);
  } else {
    for (const b of wire.XHOP) frameBody.push(b);
    wire.encodeVariableData(wire.TSP_VID, utf8.encode(senderVid), frameBody);
    encodeHops(kind === "nested" ? [] : hops, frameBody);
    encodeEmptyPadding(frameBody);
    // The inner message is self-framing and carried raw — Rev 3 drops Rev 2's
    // enclosing `B` var-data field. Every TSP message is quadlet-aligned, so
    // this keeps the frame aligned; a body that is not is a caller error worth
    // naming here rather than a frame the far side rejects.
    if (body.length % 3 !== 0) {
      throw new Error("tsp: nested inner message is not quadlet-aligned");
    }
    for (const b of body) frameBody.push(b);
  }

  if (frameBody.length % 3 !== 0) {
    throw new Error("tsp: payload frame not a multiple of 3 bytes");
  }
  const out: number[] = [];
  wire.encodeCount(wire.TSP_PAYLOAD, frameBody.length / 3, out);
  for (const b of frameBody) out.push(b);

  const frame = new Uint8Array(out);
  return { frame, threadDigest: sha256(frame) };
}

/**
 * Decode a payload frame.
 *
 * `envelopeSender` is checked against the ESSR sender field: a non-NULL field
 * that disagrees with the envelope is a message claiming two senders, which is
 * a verification failure and not a parse one.
 */
export function decodePayloadFrame(frame: Uint8Array, envelopeSender: string): DecodedFrame {
  const cur: wire.Cursor = { pos: 0 };
  const quadlets = wire.decodeCount(wire.TSP_PAYLOAD, frame, cur);
  if (quadlets === undefined) throw new Error("tsp: missing -Z payload frame");
  const frameEnd = cur.pos + quadlets * 3;
  if (frameEnd > frame.length) {
    throw new Error("tsp: -Z frame declares more content than the payload");
  }
  const threadDigest = sha256(frame.slice(0, frameEnd));

  if (cur.pos + 3 > frame.length) throw new Error("tsp: truncated payload type code");
  const typeCode = frame.slice(cur.pos, cur.pos + 3);
  cur.pos += 3;

  // Every Rev 3 layout carries the ESSR sender field next.
  const senderBytes = wire.decodeVariableData(wire.TSP_VID, frame, cur);
  if (senderBytes === undefined) throw new Error("tsp: missing ESSR sender VID field");
  let senderVid: string;
  try {
    senderVid = fromUtf8.decode(senderBytes);
  } catch {
    throw new Error("tsp: ESSR sender VID is not UTF-8");
  }
  if (senderVid.length > 0 && senderVid !== envelopeSender) {
    throw new Error("tsp: ESSR sender VID does not match the envelope sender");
  }

  const control = (controlType: ControlType): DecodedFrame => ({
    kind: "control",
    controlType,
    hops: [],
    body: new Uint8Array(0),
    senderVid,
    threadDigest,
  });

  if (bytesEqual(typeCode, wire.XSCS) || bytesEqual(typeCode, wire.XCTL)) {
    const pad = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (pad === undefined) throw new Error("tsp: missing padding field");
    const streamQuadlets = wire.decodeCount(wire.TSP_GENERIC_STREAM, frame, cur);
    if (streamQuadlets === undefined) throw new Error("tsp: missing -A payload stream");
    const streamEnd = cur.pos + streamQuadlets * 3;
    if (streamEnd > frameEnd) throw new Error("tsp: -A stream overruns the payload frame");
    const body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (body === undefined) throw new Error("tsp: missing payload body");
    if (cur.pos > streamEnd) throw new Error("tsp: payload body overruns the -A stream");
    return bytesEqual(typeCode, wire.XSCS)
      ? { kind: "direct", hops: [], body, senderVid, threadDigest }
      : { ...control("generic"), body };
  }

  if (bytesEqual(typeCode, wire.XHOP)) {
    const hopBytes = decodeHops(frame, cur);
    const pad = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (pad === undefined) throw new Error("tsp: missing padding field");
    let hops: string[];
    try {
      hops = hopBytes.map((h) => fromUtf8.decode(h));
    } catch {
      throw new Error("tsp: hop VID not UTF-8");
    }
    // The inner message runs raw to the end of the declared frame.
    const body = frame.slice(cur.pos, frameEnd);
    return { kind: hops.length === 0 ? "nested" : "routed", hops, body, senderVid, threadDigest };
  }

  if (bytesEqual(typeCode, wire.XRFI)) return control("invite");
  if (bytesEqual(typeCode, wire.XRFA)) return control("accept");
  if (bytesEqual(typeCode, wire.XRFD)) return control("cancel");
  if (bytesEqual(typeCode, wire.XPAD)) {
    return { kind: "padding", hops: [], body: new Uint8Array(0), senderVid, threadDigest };
  }

  throw new Error("tsp: unsupported payload type marker");
}
