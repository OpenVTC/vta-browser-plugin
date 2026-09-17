// Relationship-forming control messages — `XRFI`, `XRFA`, `XRFD` (§7.2, §9.3).
//
// These are what makes TSP's relationship lifecycle explicit where DIDComm's is
// implicit, and Rev 3 made them load-bearing: §7.2.2 says an endpoint SHOULD
// drop an application message from a VID it holds no relationship with. So a
// wallet that cannot send an invite cannot send anything.
//
// On the wire they are not a serialized body inside a generic payload. Each is
// its own CESR payload-frame variant, and like every Rev 3 layout each begins
// with the ESSR sender-VID field and ends with the padding field:
//
//   Invite  XRFI  sndr  Digest  Nonce  Reply_Path  Referral  pad
//   Accept  XRFA  sndr  Digest  Reply_Digest                 pad
//   Cancel  XRFD  sndr  Digest                               pad
//
// ── The digest is the whole point ──
//
// Correlation rides on `TSP_Digest` (§7.2.1), which Rev 3 turned from a
// convention into a wire field. It is *self-addressing*: computed over the
// message's own envelope and payload with its own slot filled by 33 dummy
// `0x23` bytes, carried in the message, and recomputed by the receiver, which
// refuses the message on a mismatch. Rev 2 correlated on a hash of the
// encrypted payload that was never transmitted, so a receiver could not check
// it at all.
//
// The padding field is excluded from the derivation, which is what lets §7.5
// fill it without changing what was signed.
//
// ── Naming, deliberately not the reference's ──
//
// An accept carries two digests and which is which is easy to get backwards.
// The wire order is `Digest` then `Reply_Digest`, and — counter to how those
// names read — the *first* is the invite's digest echoed verbatim and the
// *second* is the accept's own self-addressing digest. affinidi-tsp keeps the
// spec's field names and warns in a comment that they "read backwards against
// the spec"; we name them for what they hold instead: `digest` is always this
// message's own, `inReplyTo` is always the earlier message being named. A
// comment warning about a trap is weaker than a name that cannot spring it.

import { sha256 } from "@noble/hashes/sha2.js";

import * as wire from "../cesr/wire.js";
import {
  bareVidBytes,
  concatBytes,
  decodeDigest,
  decodeNonce,
  decodePadding,
  decodeVidList,
  DIGEST_LEN,
  emptyVidListBytes,
  encodeDigest,
  encodeEmptyPadding,
  encodeNonce,
  encodeSenderField,
  encodeVidList,
  ENCODED_DIGEST_LEN,
  NONCE_LEN,
  senderFieldBytes,
  SIG_LEN,
  vidListBytes,
} from "./fields.js";

/** Which relationship-forming message this is. */
export type ControlType = "invite" | "accept" | "cancel";

/** A VID introduced over an existing relationship (§7.2.5).
 *
 *  We decode one and expose it; we do not compose one. Composing needs the
 *  introduced VID's *signing key* at pack time — the signature covers the
 *  invite's digest, so it cannot be made beforehand — and a wallet holding
 *  another VID's private key is not a shape this package should invite. */
export interface Referral {
  /** The VID being introduced. */
  newVid: string;
  /** `Signature_new`, made by `newVid`'s key.
   *
   *  **Unverified.** Checking it needs `newVid`'s public key, and `newVid` is
   *  precisely the identifier the invite exists to introduce — so it has to be
   *  resolved first, which a key-in-hand codec cannot do. Until a caller
   *  resolves and calls {@link referralSignedData}, this is a claim that the
   *  sender *wishes* to introduce the VID and says nothing about whether
   *  whoever controls it agreed. That is the entire purpose of the signature,
   *  so acting on a referral without checking it has skipped the check. */
  signature: Uint8Array;
}

/** A decoded or to-be-encoded control message. */
export interface ControlMessage {
  controlType: ControlType;
  /** This message's own self-addressing digest — the thread id of the exchange
   *  it opens. Present on an invite and an accept; on a cancel it mirrors
   *  {@link inReplyTo}, since a cancel has no digest of its own to derive.
   *
   *  Set by the packing code, which is the only place that can compute it: the
   *  derivation covers the envelope, which a caller does not yet have. */
  digest?: Uint8Array;
  /** The earlier message this one names: for an accept, the invite it answers;
   *  for a cancel, the relationship-forming message it ends. Echoed verbatim,
   *  never recomputed. */
  inReplyTo?: Uint8Array;
  /** 128-bit nonce. Invite only. */
  nonce?: Uint8Array;
  /** `Reply_Path` (§7.2.4) — a route the invite asks for its accept over.
   *  Empty for a direct reply. Invite only. */
  route: string[];
  /** `Referral_Field` (§7.2.5). Invite only, and decode-only here. */
  referral?: Referral;
}

/** The byte the SAID derivation fills its own slot with. */
const SAID_DUMMY = 0x23;

const MARKERS: Record<ControlType, Uint8Array> = {
  invite: wire.XRFI,
  accept: wire.XRFA,
  cancel: wire.XRFD,
};

/**
 * Derive a self-addressing `TSP_Digest` (§7.2.1).
 *
 * Covers the message's own envelope fields and its payload fields, with the
 * digest's own slot filled by {@link SAID_DUMMY} over its full encoded width.
 * The `-E` and `-Z` framing tags and the padding field are excluded; the
 * payload type code is included.
 *
 * `before` and `after` are the encoded payload fields either side of the digest
 * slot, padding excluded. Verification reverses it: rebuild the same input from
 * the received bytes and compare.
 */
export function deriveSaid(
  envelopeFields: Uint8Array,
  typeCode: Uint8Array,
  before: Uint8Array,
  after: Uint8Array,
): Uint8Array {
  return sha256(
    concatBytes(
      envelopeFields,
      typeCode,
      before,
      new Uint8Array(ENCODED_DIGEST_LEN).fill(SAID_DUMMY),
      after,
    ),
  );
}

/** The derivation input that follows an invite's digest slot.
 *
 *  Rebuilt rather than sliced out of the frame, because the referral
 *  contributes a **bare** `VID_new` here and the `-J` group it occupies on the
 *  wire there — §9.3 excludes the referral field's own code and count. The
 *  bytes are deliberately different in the two places. */
function inviteDigestAfter(nonce: Uint8Array, route: string[], referral?: Referral): Uint8Array {
  const nonceOut: number[] = [];
  encodeNonce(nonce, nonceOut);
  return concatBytes(
    new Uint8Array(nonceOut),
    vidListBytes(route),
    referral ? bareVidBytes(referral.newVid) : emptyVidListBytes(),
  );
}

/**
 * The bytes `Signature_new` is made over (§9.3):
 * `{XRFI, VID_sndr | 4BAA, Digest, Nonce, Reply_Path, VID_new}`.
 *
 * Exported so a caller that has resolved `VID_new` can verify a referral it was
 * sent — see {@link Referral.signature} for why this cannot happen during
 * `unpack`.
 */
export function referralSignedData(
  senderVid: string,
  digest: Uint8Array,
  nonce: Uint8Array,
  route: string[],
  newVid: string,
): Uint8Array {
  const digestOut: number[] = [];
  encodeDigest(digest, digestOut);
  const nonceOut: number[] = [];
  encodeNonce(nonce, nonceOut);
  return concatBytes(
    wire.XRFI,
    senderFieldBytes(senderVid),
    new Uint8Array(digestOut),
    new Uint8Array(nonceOut),
    vidListBytes(route),
    bareVidBytes(newVid),
  );
}

/** Encode a referral field: a `-J` group holding `VID_new` and its signature
 *  attachment, or `-JAA` when the invite introduces nothing. */
function encodeReferral(referral: Referral | undefined, out: number[]): void {
  if (!referral) {
    wire.encodeCount(wire.TSP_HOP_LIST, 0, out);
    return;
  }
  const body: number[] = [];
  wire.encodeVariableData(wire.TSP_VID, new TextEncoder().encode(referral.newVid), body);
  encodeSignatureAttachment(referral.signature, body);
  if (body.length % 3 !== 0) throw new Error("tsp: referral group not a multiple of 3 bytes");
  wire.encodeCount(wire.TSP_HOP_LIST, body.length / 3, out);
  for (const b of body) out.push(b);
}

/** Decode a referral field; `undefined` for the empty `-JAA` form. */
function decodeReferral(frame: Uint8Array, cur: wire.Cursor): Referral | undefined {
  const quadlets = wire.decodeCount(wire.TSP_HOP_LIST, frame, cur);
  if (quadlets === undefined) throw new Error("tsp: missing referral field");
  if (quadlets === 0) return undefined;
  const groupEnd = cur.pos + quadlets * 3;
  if (groupEnd > frame.length) throw new Error("tsp: referral field overruns the payload");

  const vidBytes = wire.decodeVariableData(wire.TSP_VID, frame, cur);
  if (vidBytes === undefined) throw new Error("tsp: malformed VID in referral field");
  let newVid: string;
  try {
    newVid = new TextDecoder("utf-8", { fatal: true }).decode(vidBytes);
  } catch {
    throw new Error("tsp: referral VID is not UTF-8");
  }
  if (newVid.length === 0) throw new Error("tsp: referral field names the NULL VID");

  const signature = decodeSignatureAttachment(frame, cur);
  if (cur.pos !== groupEnd) throw new Error("tsp: referral field does not fill its own count");
  return { newVid, signature };
}

// The referral's signature uses the same attachment encoding as a message
// signature. These mirror `direct.ts`'s pair; they are not shared because
// `direct.ts` imports this module and a cycle is the price of that reuse — and
// because the message signature's is checked against the sender's VID while
// this one is not checked here at all.
const SIG_GROUP_QUADLETS = 22;
const ATTACH_GROUP_QUADLETS = SIG_GROUP_QUADLETS + 1;
const SIG_INDEX = 0;

function encodeSignatureAttachment(signature: Uint8Array, out: number[]): void {
  if (signature.length !== SIG_LEN) throw new Error(`tsp: signature must be ${SIG_LEN} bytes`);
  wire.encodeCount(wire.TSP_ATTACH_GRP, ATTACH_GROUP_QUADLETS, out);
  wire.encodeCount(wire.TSP_INDEX_SIG_GRP, SIG_GROUP_QUADLETS, out);
  wire.encodeIndexedEd25519Signature(SIG_INDEX, signature, out);
}

function decodeSignatureAttachment(data: Uint8Array, cur: wire.Cursor): Uint8Array {
  const attach = wire.decodeCount(wire.TSP_ATTACH_GRP, data, cur);
  const group = wire.decodeCount(wire.TSP_INDEX_SIG_GRP, data, cur);
  if (attach !== ATTACH_GROUP_QUADLETS || group !== SIG_GROUP_QUADLETS) {
    throw new Error("tsp: unexpected referral signature group size");
  }
  if (cur.pos + 2 + SIG_LEN > data.length) throw new Error("tsp: truncated referral signature");
  const word = ((data[cur.pos]! << 16) | (data[cur.pos + 1]! << 8)) >>> 0;
  if (word >>> 18 !== wire.ED25519_SIGNATURE) {
    throw new Error("tsp: referral signature is not the indexed Ed25519 code");
  }
  cur.pos += 2;
  const sig = data.slice(cur.pos, cur.pos + SIG_LEN);
  cur.pos += SIG_LEN;
  return sig;
}

/**
 * Encode a control payload frame body (everything inside the `-Z` count), and
 * return it with the message's thread digest.
 *
 * `envelopeFields` is needed because the SAID covers the envelope — which is
 * why a control message cannot be composed independently of the message that
 * carries it.
 */
export function encodeControlBody(
  control: ControlMessage,
  senderVid: string,
  envelopeFields: Uint8Array,
): { body: number[]; threadDigest: Uint8Array } {
  const senderField = senderFieldBytes(senderVid);
  const marker = MARKERS[control.controlType];
  const out: number[] = [];

  if (control.controlType === "invite") {
    const nonce = control.nonce;
    if (nonce === undefined || nonce.length !== NONCE_LEN) {
      throw new Error("tsp: an invite must carry a 128-bit nonce");
    }
    const digest = deriveSaid(
      envelopeFields,
      marker,
      senderField,
      inviteDigestAfter(nonce, control.route, control.referral),
    );
    for (const b of marker) out.push(b);
    for (const b of senderField) out.push(b);
    encodeDigest(digest, out);
    encodeNonce(nonce, out);
    encodeVidList(control.route, out);
    encodeReferral(control.referral, out);
    encodeEmptyPadding(out);
    return { body: out, threadDigest: digest };
  }

  if (control.controlType === "accept") {
    const echoed = control.inReplyTo;
    if (echoed === undefined || echoed.length !== DIGEST_LEN) {
      throw new Error("tsp: an accept must name the invite it answers");
    }
    // The echoed invite digest sits *before* the slot, so it is derivation
    // input; the accept's own digest is what the slot dummies out.
    const beforeOut: number[] = Array.from(senderField);
    encodeDigest(echoed, beforeOut);
    const before = new Uint8Array(beforeOut);

    const digest = deriveSaid(envelopeFields, marker, before, new Uint8Array(0));
    for (const b of marker) out.push(b);
    for (const b of before) out.push(b);
    encodeDigest(digest, out);
    encodeEmptyPadding(out);
    return { body: out, threadDigest: digest };
  }

  // Cancel. Its digest names the relationship-forming message it ends — a
  // reference, not a digest of this message — so it is echoed, not derived.
  const reference = control.inReplyTo;
  if (reference === undefined || reference.length !== DIGEST_LEN) {
    throw new Error("tsp: a cancel must name the relationship it ends");
  }
  for (const b of marker) out.push(b);
  for (const b of senderField) out.push(b);
  encodeDigest(reference, out);
  encodeEmptyPadding(out);
  return { body: out, threadDigest: reference };
}

/**
 * Decode a control payload frame body, positioned just past the ESSR sender
 * field, and verify the self-addressing digest.
 *
 * A mismatch is a verification failure, not a parse one: the message is not the
 * message its digest claims it is.
 */
export function decodeControlBody(
  controlType: ControlType,
  frame: Uint8Array,
  cur: wire.Cursor,
  senderField: Uint8Array,
  envelopeFields: Uint8Array,
): { control: ControlMessage; threadDigest: Uint8Array } {
  const marker = MARKERS[controlType];

  // The first digest field means different things per type: an invite's is its
  // own, an accept's and a cancel's is a reference to an earlier message.
  const firstDigest = decodeDigest(frame, cur);

  if (controlType === "invite") {
    const nonce = decodeNonce(frame, cur);
    const route = decodeVidList(frame, cur);
    const referral = decodeReferral(frame, cur);
    decodePadding(frame, cur);

    const recomputed = deriveSaid(
      envelopeFields,
      marker,
      senderField,
      inviteDigestAfter(nonce, route, referral),
    );
    requireDigestMatch(recomputed, firstDigest);
    return {
      control: {
        controlType,
        digest: firstDigest,
        nonce,
        route,
        ...(referral ? { referral } : {}),
      },
      threadDigest: firstDigest,
    };
  }

  if (controlType === "accept") {
    // The second digest is the accept's own; the first, already read, is the
    // invite it answers.
    const own = decodeDigest(frame, cur);
    decodePadding(frame, cur);

    const beforeOut: number[] = Array.from(senderField);
    encodeDigest(firstDigest, beforeOut);
    const recomputed = deriveSaid(
      envelopeFields,
      marker,
      new Uint8Array(beforeOut),
      new Uint8Array(0),
    );
    requireDigestMatch(recomputed, own);
    return {
      control: { controlType, digest: own, inReplyTo: firstDigest, route: [] },
      threadDigest: own,
    };
  }

  // A cancel's only digest references another message, so there is nothing
  // self-addressing to recompute.
  decodePadding(frame, cur);
  return {
    control: { controlType, digest: firstDigest, inReplyTo: firstDigest, route: [] },
    threadDigest: firstDigest,
  };
}

function requireDigestMatch(recomputed: Uint8Array, carried: Uint8Array): void {
  if (recomputed.length !== carried.length) {
    throw new Error("tsp: TSP_Digest does not match the message it identifies");
  }
  let diff = 0;
  for (let i = 0; i < recomputed.length; i++) diff |= recomputed[i]! ^ carried[i]!;
  if (diff !== 0) {
    throw new Error("tsp: TSP_Digest does not match the message it identifies");
  }
}
