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
// This module owns the type-code dispatch and the three application layouts;
// `control.ts` owns the three relationship-forming ones, because their digest
// derivation is a body of protocol in its own right.
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
import {
  decodeControlBody,
  encodeControlBody,
  type ControlMessage,
  type ControlType,
} from "./control.js";
import {
  decodePadding,
  decodeVidList,
  encodeEmptyPadding,
  encodeSenderField,
  encodeVidList,
  senderFieldBytes,
} from "./fields.js";

const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** What kind of message a payload frame carries. */
export type MessageType = "direct" | "nested" | "routed" | "control" | "padding";

export type { ControlMessage, ControlType };

/** The application layouts this module composes. A control frame is built from
 *  a {@link ControlMessage} instead, which is why it is not in this union. */
export type ApplicationKind = "direct" | "nested" | "routed";

export interface DecodedFrame {
  kind: MessageType;
  /** The recovered control message, when `kind` is `"control"`. Its digest has
   *  already been verified against the frame. */
  control?: ControlMessage;
  /** Remaining route (Routed only). */
  hops: string[];
  /** The plaintext body: the upper-layer payload for Direct, the raw inner
   *  message for Nested/Routed, empty for a control or padding frame. */
  body: Uint8Array;
  /** The ESSR sender VID as carried, or `""` for the NULL VID. */
  senderVid: string;
  /** The thread digest: SHA-256 over the whole `-Z` frame for an application
   *  message, and the carried `TSP_Digest` for a control one. */
  threadDigest: Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Wrap a frame body in its `-Z` count code. */
function frameFromBody(frameBody: number[]): Uint8Array {
  if (frameBody.length % 3 !== 0) {
    throw new Error("tsp: payload frame not a multiple of 3 bytes");
  }
  const out: number[] = [];
  wire.encodeCount(wire.TSP_PAYLOAD, frameBody.length / 3, out);
  for (const b of frameBody) out.push(b);
  return new Uint8Array(out);
}

/** Build an application payload frame, and the thread digest over it. */
export function encodePayloadFrame(
  body: Uint8Array,
  kind: ApplicationKind,
  hops: string[],
  senderVid: string,
): { frame: Uint8Array; threadDigest: Uint8Array } {
  const frameBody: number[] = [];

  if (kind === "direct") {
    for (const b of wire.XSCS) frameBody.push(b);
    encodeSenderField(senderVid, frameBody);
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
    encodeSenderField(senderVid, frameBody);
    encodeVidList(kind === "nested" ? [] : hops, frameBody);
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

  const frame = frameFromBody(frameBody);
  return { frame, threadDigest: sha256(frame) };
}

/** Build a control payload frame, and the `TSP_Digest` it carries.
 *
 *  `envelopeFields` is part of the digest derivation, which is why a control
 *  message cannot be composed independently of the message carrying it. */
export function encodeControlFrame(
  control: ControlMessage,
  senderVid: string,
  envelopeFields: Uint8Array,
): { frame: Uint8Array; threadDigest: Uint8Array } {
  const { body, threadDigest } = encodeControlBody(control, senderVid, envelopeFields);
  return { frame: frameFromBody(body), threadDigest };
}

/**
 * Decode a payload frame.
 *
 * `envelopeSender` is checked against the ESSR sender field: a non-NULL field
 * that disagrees with the envelope is a message claiming two senders, which is
 * a verification failure and not a parse one. `envelopeFields` is needed to
 * recompute a control message's self-addressing digest.
 */
export function decodePayloadFrame(
  frame: Uint8Array,
  envelopeSender: string,
  envelopeFields: Uint8Array,
): DecodedFrame {
  const cur: wire.Cursor = { pos: 0 };
  const quadlets = wire.decodeCount(wire.TSP_PAYLOAD, frame, cur);
  if (quadlets === undefined) throw new Error("tsp: missing -Z payload frame");
  const frameEnd = cur.pos + quadlets * 3;
  if (frameEnd > frame.length) {
    throw new Error("tsp: -Z frame declares more content than the payload");
  }
  const frameDigest = sha256(frame.slice(0, frameEnd));

  if (cur.pos + 3 > frame.length) throw new Error("tsp: truncated payload type code");
  const typeCode = frame.slice(cur.pos, cur.pos + 3);
  cur.pos += 3;

  // Every Rev 3 layout carries the ESSR sender field next.
  const senderFieldBegin = cur.pos;
  const senderBytes = wire.decodeVariableData(wire.TSP_VID, frame, cur);
  if (senderBytes === undefined) throw new Error("tsp: missing ESSR sender VID field");
  const senderField = frame.slice(senderFieldBegin, cur.pos);
  let senderVid: string;
  try {
    senderVid = fromUtf8.decode(senderBytes);
  } catch {
    throw new Error("tsp: ESSR sender VID is not UTF-8");
  }
  if (senderVid.length > 0 && senderVid !== envelopeSender) {
    throw new Error("tsp: ESSR sender VID does not match the envelope sender");
  }

  if (bytesEqual(typeCode, wire.XSCS) || bytesEqual(typeCode, wire.XCTL)) {
    decodePadding(frame, cur);
    const streamQuadlets = wire.decodeCount(wire.TSP_GENERIC_STREAM, frame, cur);
    if (streamQuadlets === undefined) throw new Error("tsp: missing -A payload stream");
    const streamEnd = cur.pos + streamQuadlets * 3;
    if (streamEnd > frameEnd) throw new Error("tsp: -A stream overruns the payload frame");
    const body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (body === undefined) throw new Error("tsp: missing payload body");
    if (cur.pos > streamEnd) throw new Error("tsp: payload body overruns the -A stream");
    // `XCTL` carries an upper-layer control payload — opaque to TSP, exactly
    // like `XSCS`. It is not a relationship-forming message and shares nothing
    // with one but the word "control".
    return {
      kind: bytesEqual(typeCode, wire.XSCS) ? "direct" : "control",
      hops: [],
      body,
      senderVid,
      threadDigest: frameDigest,
    };
  }

  if (bytesEqual(typeCode, wire.XHOP)) {
    const hops = decodeVidList(frame, cur);
    decodePadding(frame, cur);
    // The inner message runs raw to the end of the declared frame.
    const body = frame.slice(cur.pos, frameEnd);
    return {
      kind: hops.length === 0 ? "nested" : "routed",
      hops,
      body,
      senderVid,
      threadDigest: frameDigest,
    };
  }

  const controlType = relationshipType(typeCode);
  if (controlType) {
    const { control, threadDigest } = decodeControlBody(
      controlType,
      frame,
      cur,
      senderField,
      envelopeFields,
    );
    return { kind: "control", control, hops: [], body: new Uint8Array(0), senderVid, threadDigest };
  }

  if (bytesEqual(typeCode, wire.XPAD)) {
    // A padding-only message carries a nonce so two of them between the same
    // pair are not identical on the wire — which would make them recognisable
    // as padding, the opposite of the point.
    return {
      kind: "padding",
      hops: [],
      body: new Uint8Array(0),
      senderVid,
      threadDigest: frameDigest,
    };
  }

  throw new Error("tsp: unsupported payload type marker");
}

function relationshipType(typeCode: Uint8Array): ControlType | undefined {
  if (bytesEqual(typeCode, wire.XRFI)) return "invite";
  if (bytesEqual(typeCode, wire.XRFA)) return "accept";
  if (bytesEqual(typeCode, wire.XRFD)) return "cancel";
  return undefined;
}

export { senderFieldBytes };
