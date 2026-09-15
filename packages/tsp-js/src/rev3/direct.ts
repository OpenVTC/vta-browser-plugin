// Rev 3 pack and unpack — the revision this package speaks.
//
//   -E<count>                     one frame; the count covers everything below
//     YTSP <version>                `YTSP-AAC`
//     <var-data B> sender-VID
//     <var-data B> receiver-VID     `4BAA` when absent
//     <var-data F> enc ‖ ct       HPKE-Base ciphertext, AEAD tag inside ct
//   -C23 -K22 B0 sig(64)          indexed Ed25519 signature over the above
//
// ── What moved from Rev 2 ──
//
// * **HPKE-Base, not HPKE-Auth.** The sender's KEM key no longer participates,
//   so packing and unpacking each take one fewer key than they did. Sender
//   authenticity comes from the ESSR signature and the AAD instead — which is
//   where Rev 3 puts it, and why `PackKeys` and `UnpackKeys` lost
//   `senderEncryptionKey` rather than keeping it as an ignored field.
// * **The crypto binding moved.** Rev 2 passed the whole envelope frame as HPKE
//   `info` with empty AAD. Rev 3 passes `TSP_Version ‖ VID_sndr ‖ VID_rcvr` as
//   real AAD and the fixed code `YTSP-` as `info`.
// * **`enc` leads the ciphertext field**; Rev 2 put it at the end.
// * **The `-E` count covers the ciphertext**, so the frame is finalized after
//   sealing rather than built before it, and the count is authoritative for
//   where the signable content ends.
// * **The signature is indexed** (`B#`), under length-based counts.

import * as wire from "../cesr/wire.js";
import * as hpke from "../crypto/hpke.js";
import * as sign from "../crypto/sign.js";
import { decodeEnvelope, encodeFields, finalizeFrame } from "./envelope.js";
import { decodePayloadFrame, encodePayloadFrame, type ControlType, type MessageType } from "./payload.js";

const ENC_LEN = 32;
const TAG_LEN = 16;
const SIG_LEN = 64;
/** The `-K` group's content: the 2-byte indexed code plus 64 bytes of
 *  signature, 66 bytes = 22 quadlets. */
const SIG_GROUP_QUADLETS = 22;
/** The `-C` group holds the `-K` header plus its content — §9.5 made these
 *  counts length-based, where Rev 2 repeated the same number twice. */
const ATTACH_GROUP_QUADLETS = SIG_GROUP_QUADLETS + 1;
/** Only index 0 can be verified: a VID names one signing key here. */
const SIG_INDEX = 0;

export type { ControlType, MessageType };

/** Raw key material needed to pack. All keys are raw 32-byte. */
export interface PackKeys {
  /** Sender's Ed25519 private key (signing). */
  senderSigningKey: Uint8Array;
  /** Receiver's X25519 public key (HPKE-Base recipient). */
  receiverEncryptionKey: Uint8Array;
}

/** Raw key material needed to unpack. All keys are raw 32-byte. */
export interface UnpackKeys {
  /** Receiver's X25519 private key (HPKE-Base recipient). */
  receiverDecryptionKey: Uint8Array;
  /** Sender's Ed25519 public key (outer signature verification). */
  senderSigningKey: Uint8Array;
}

export interface PackedMessage {
  bytes: Uint8Array;
  /** SHA-256 of the payload frame — the TSP thread digest. */
  threadDigest: Uint8Array;
}

export interface UnpackedMessage {
  payload: Uint8Array;
  sender: string;
  receiver: string;
  messageType: MessageType;
  /** Set only when `messageType` is `"control"`. */
  controlType?: ControlType;
  hops: string[];
  threadDigest: Uint8Array;
}

/** Encode the signature attachment: `-C23 -K22 B0 sig(64)`. */
function encodeSignatureFrame(signature: Uint8Array, out: number[]): void {
  wire.encodeCount(wire.TSP_ATTACH_GRP, ATTACH_GROUP_QUADLETS, out);
  wire.encodeCount(wire.TSP_INDEX_SIG_GRP, SIG_GROUP_QUADLETS, out);
  wire.encodeIndexedEd25519Signature(SIG_INDEX, signature, out);
}

/** Decode the signature attachment; returns the 64-byte Ed25519 signature.
 *
 *  An attachment that will not parse is a rejection, never "this message is
 *  unsigned" — the two must not be reachable from the same code path. */
function decodeSignatureFrame(data: Uint8Array, cur: wire.Cursor): Uint8Array {
  const attach = wire.decodeCount(wire.TSP_ATTACH_GRP, data, cur);
  const group = wire.decodeCount(wire.TSP_INDEX_SIG_GRP, data, cur);
  if (attach !== ATTACH_GROUP_QUADLETS || group !== SIG_GROUP_QUADLETS) {
    throw new Error("tsp: unexpected signature group size");
  }
  if (cur.pos + 2 + SIG_LEN > data.length) throw new Error("tsp: truncated signature attachment");
  const word = ((data[cur.pos]! << 16) | (data[cur.pos + 1]! << 8)) >>> 0;
  if (word >>> 18 !== wire.ED25519_SIGNATURE) {
    throw new Error("tsp: signature is not the indexed Ed25519 code");
  }
  const index = (word >>> 12) & 0x3f;
  if (index !== SIG_INDEX) {
    throw new Error(`tsp: signature names key index ${index}, but only index ${SIG_INDEX} can be verified`);
  }
  cur.pos += 2;
  const sig = data.slice(cur.pos, cur.pos + SIG_LEN);
  cur.pos += SIG_LEN;
  return sig;
}

/** Pack a Rev 3 message of any kind. */
export async function packWithHops(
  body: Uint8Array,
  kind: "direct" | "nested" | "routed",
  hops: string[],
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  // 1. Envelope fields — these are the HPKE-Base AAD.
  const fields = encodeFields(senderVid, receiverVid);

  // 2. Plaintext payload frame, and the thread digest over it.
  const { frame, threadDigest } = encodePayloadFrame(body, kind, hops, senderVid);

  // 3. Seal. `aad` binds the ciphertext to the version and both VIDs; `info`
  //    is the fixed protocol code.
  const sealed = await hpke.sealBase(frame, fields, keys.receiverEncryptionKey, wire.TSP_INFO);

  // 4. Ciphertext field: `enc ‖ ct`, with the AEAD tag inside `ct`.
  const ciphertext = new Uint8Array(sealed.enc.length + sealed.ciphertext.length);
  ciphertext.set(sealed.enc, 0);
  ciphertext.set(sealed.ciphertext, sealed.enc.length);

  const field: number[] = [];
  wire.encodeVariableData(wire.TSP_HPKE_BASE_CIPHERTEXT, ciphertext, field);

  // 5. Close the `-E` frame over the fields and the body, then sign it.
  const wireBytes = finalizeFrame(fields, new Uint8Array(field));
  const signature = sign.sign(wireBytes, keys.senderSigningKey);
  const out = Array.from(wireBytes);
  encodeSignatureFrame(signature, out);

  return { bytes: new Uint8Array(out), threadDigest };
}

/** Pack a Rev 3 direct message. */
export function pack(
  body: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packWithHops(body, "direct", [], senderVid, receiverVid, keys);
}

/** Unpack a Rev 3 message. */
export async function unpack(
  wireBytes: Uint8Array,
  keys: UnpackKeys,
): Promise<UnpackedMessage> {
  if (wireBytes.length < 48) throw new Error("tsp: message too short");

  // 1. Envelope.
  const decoded = decodeEnvelope(wireBytes);
  const aad = wireBytes.slice(decoded.aad.begin, decoded.aad.end);

  // 2. The body. What follows the VIDs says whether the message is sealed and,
  //    if so, under which scheme: `F` for HPKE-Base, `C` for the libsodium
  //    sealed box. The code is the *only* signal — nothing is negotiated and no
  //    field names it — so a `C` is recognised and refused by name rather than
  //    dying at the `F` selector with "missing ciphertext".
  const cur: wire.Cursor = { pos: decoded.headerLen };
  const ctRange = wire.decodeVariableDataRange(wire.TSP_HPKE_BASE_CIPHERTEXT, wireBytes, cur);
  if (ctRange === undefined) {
    const probe: wire.Cursor = { pos: decoded.headerLen };
    if (wire.decodeVariableDataRange(wire.TSP_SEALED_BOX_CIPHERTEXT, wireBytes, probe)) {
      throw new Error("tsp: message is sealed with the libsodium sealed box (§8.3), which this implementation does not support");
    }
    throw new Error("tsp: missing F ciphertext field");
  }

  const ctLen = ctRange.end - ctRange.begin;
  if (ctLen > wire.MAX_FIELD_SIZE) throw new Error("tsp: ciphertext too large");
  if (ctLen < ENC_LEN + TAG_LEN) throw new Error("tsp: ciphertext truncated");

  // The `-E` count is authoritative for where the signable content ends; the
  // body must fill it exactly.
  if (cur.pos !== decoded.contentEnd) {
    throw new Error("tsp: message body does not fill the -E frame");
  }

  // 3. Signature over the whole `-E` frame.
  const signature = decodeSignatureFrame(wireBytes, cur);
  if (cur.pos !== wireBytes.length) throw new Error("tsp: trailing bytes after signature");
  if (!sign.verify(wireBytes.slice(0, decoded.contentEnd), signature, keys.senderSigningKey)) {
    throw new Error("tsp: signature verification failed");
  }

  // 4. Open.
  const ciphertext = wireBytes.slice(ctRange.begin, ctRange.end);
  const payloadFrame = await hpke.openBase(
    ciphertext.slice(ENC_LEN),
    aad,
    ciphertext.slice(0, ENC_LEN),
    keys.receiverDecryptionKey,
    wire.TSP_INFO,
  );

  const frame = decodePayloadFrame(payloadFrame, decoded.envelope.sender);
  return {
    payload: frame.body,
    sender: decoded.envelope.sender,
    receiver: decoded.envelope.receiver,
    messageType: frame.kind,
    ...(frame.controlType ? { controlType: frame.controlType } : {}),
    hops: frame.hops,
    threadDigest: frame.threadDigest,
  };
}
