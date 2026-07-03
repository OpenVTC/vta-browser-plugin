// TSP direct-mode messaging — seal, sign, and CESR-encode a message.
// TS port of affinidi-tsp `src/message/direct.rs` (Direct-mode scope).
//
// A direct message is HPKE-Auth sealed (encrypt + sender-authenticate) then
// Ed25519-signed. Wire (encrypted-then-signed):
//
//   -E<count> envelope (= HPKE info):  YTSP<ver> · B sender-VID · B receiver-VID · X 00 00
//   <G var-data> ciphertext = ct ‖ tag(16) ‖ enc(32)
//   -C<n> -K<n> <fixed B> sig(64)      Ed25519 over envelope‖ciphertext
//
// The encrypted plaintext is itself a CESR payload frame:
//   -Z<count> XSCS <B var-data> body
//
// HPKE binding: the `-E` envelope frame is the HPKE `info`; AEAD AAD is empty.
//
// Supports Direct (trust-tasks) + Nested / Routed (mediator relay). Control
// (relationship FSM) is a follow-up.

import { sha256 } from "@noble/hashes/sha2.js";

import * as wire from "../cesr/wire.js";
import * as hpke from "../crypto/hpke.js";
import * as sign from "../crypto/sign.js";
import { encodeEnvelope, decodeEnvelope } from "./envelope.js";

const ENC_LEN = 32;
const TAG_LEN = 16;
const SIG_LEN = 64;
const SIG_QUADLETS = Math.ceil(SIG_LEN / 3); // 22
const EMPTY = new Uint8Array(0);

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** TSP message kind, recovered from the encrypted payload frame's marker. */
export type MessageType = "direct" | "nested" | "routed";

/** Raw key material for a TSP identity (all 32-byte). */
export interface PackKeys {
  /** Sender's Ed25519 private key (signing). */
  senderSigningKey: Uint8Array;
  /** Sender's X25519 private key (HPKE-Auth sender authentication). */
  senderEncryptionKey: Uint8Array;
  /** Receiver's X25519 public key (HPKE recipient). */
  receiverEncryptionKey: Uint8Array;
}

export interface UnpackKeys {
  /** Receiver's X25519 private key (HPKE recipient). */
  receiverDecryptionKey: Uint8Array;
  /** Sender's X25519 public key (HPKE-Auth sender verification). */
  senderEncryptionKey: Uint8Array;
  /** Sender's Ed25519 public key (outer signature verification). */
  senderSigningKey: Uint8Array;
}

export interface PackedMessage {
  /** Raw wire bytes. */
  bytes: Uint8Array;
  /** SHA-256 of the plaintext payload frame — the TSP thread digest. */
  threadDigest: Uint8Array;
}

export interface UnpackedMessage {
  /** The decrypted message body. For Direct/Nested it's the message/inner; for
   *  Routed it's the opaque inner message (the route is in `hops`). */
  payload: Uint8Array;
  /** Sender VID (from the cleartext envelope). */
  sender: string;
  /** Receiver VID (from the cleartext envelope). */
  receiver: string;
  /** The message kind recovered from the payload frame. */
  messageType: MessageType;
  /** Remaining route for a Routed message (empty for Direct/Nested). */
  hops: string[];
  /** SHA-256 of the decrypted payload frame — the TSP thread digest. */
  threadDigest: Uint8Array;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface DecodedFrame {
  kind: MessageType;
  hops: string[];
  body: Uint8Array;
}

/** Build the CESR payload frame that gets encrypted:
 *   Direct → `-Z XSCS <B> body`
 *   Nested → `-Z XHOP -J0 <B> body`
 *   Routed → `-Z XHOP -J<n> (B hop)* <B> body`  */
function encodePayloadFrame(body: Uint8Array, kind: MessageType, hops: string[]): Uint8Array {
  const frameBody: number[] = [];
  if (kind === "direct") {
    for (const b of wire.XSCS) frameBody.push(b);
  } else {
    for (const b of wire.XHOP) frameBody.push(b);
    wire.encodeHops(
      hops.map((h) => utf8.encode(h)),
      frameBody,
    );
  }
  wire.encodeVariableData(wire.TSP_PLAINTEXT, body, frameBody);

  const out: number[] = [];
  wire.encodeCount(wire.TSP_PAYLOAD, frameBody.length / 3, out);
  for (const b of frameBody) out.push(b);
  return new Uint8Array(out);
}

/** Decode a payload frame into its kind, remaining route, and body. */
function decodePayloadFrame(frame: Uint8Array): DecodedFrame {
  const cur: wire.Cursor = { pos: 0 };
  if (wire.decodeCount(wire.TSP_PAYLOAD, frame, cur) === undefined) {
    throw new Error("tsp: missing -Z payload frame");
  }
  // Optional ESSR sender-VID: the reference omits it for HPKE-Auth. A non-VID
  // marker won't match a `B` var-data field, so this is a tolerant skip.
  wire.decodeVariableData(wire.TSP_VID, frame, cur);

  const marker = frame.slice(cur.pos, cur.pos + 3);
  if (bytesEqual(marker, wire.XSCS)) {
    cur.pos += 3;
    const body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (body === undefined) throw new Error("tsp: missing payload plaintext");
    return { kind: "direct", hops: [], body };
  }
  if (bytesEqual(marker, wire.XHOP)) {
    cur.pos += 3;
    const hopBytes = wire.decodeHops(frame, cur);
    if (hopBytes === undefined) throw new Error("tsp: malformed hop list");
    let hops: string[];
    try {
      hops = hopBytes.map((h) => fromUtf8.decode(h));
    } catch {
      throw new Error("tsp: hop VID not UTF-8");
    }
    const body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (body === undefined) throw new Error("tsp: missing payload plaintext");
    return { kind: hops.length === 0 ? "nested" : "routed", hops, body };
  }
  throw new Error("tsp: unsupported payload type marker");
}

/** Encode the signature frame: `-C<n> -K<n> <fixed B> sig(64)`. */
function encodeSignatureFrame(signature: Uint8Array, out: number[]): void {
  wire.encodeCount(wire.TSP_ATTACH_GRP, SIG_QUADLETS, out);
  wire.encodeCount(wire.TSP_INDEX_SIG_GRP, SIG_QUADLETS, out);
  wire.encodeFixedData(wire.ED25519_SIGNATURE, signature, out);
}

/** Decode the signature frame; returns the 64-byte Ed25519 signature. */
function decodeSignatureFrame(data: Uint8Array, cur: wire.Cursor): Uint8Array {
  const a = wire.decodeCount(wire.TSP_ATTACH_GRP, data, cur);
  const k = wire.decodeCount(wire.TSP_INDEX_SIG_GRP, data, cur);
  if (a !== SIG_QUADLETS || k !== SIG_QUADLETS) {
    throw new Error("tsp: unexpected signature group size");
  }
  const sig = wire.decodeFixedData(wire.ED25519_SIGNATURE, SIG_LEN, data, cur);
  if (sig === undefined) throw new Error("tsp: missing Ed25519 signature");
  return sig;
}

/**
 * Pack a direct TSP message: build the envelope (= HPKE info), HPKE-Auth seal
 * the payload frame (empty AAD), append `enc`, then Ed25519-sign envelope‖
 * ciphertext.
 */
export async function pack(
  body: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packWithHops(body, "direct", [], senderVid, receiverVid, keys);
}

/**
 * Like {@link pack} but for any message kind, carrying a routing `hops` list in
 * the payload frame (used by `pack_routed` for Routed; `hops` must be empty for
 * Direct/Nested).
 */
export async function packWithHops(
  body: Uint8Array,
  kind: MessageType,
  hops: string[],
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  const envelopeBytes = encodeEnvelope(senderVid, receiverVid);

  const payloadFrame = encodePayloadFrame(body, kind, hops);
  const threadDigest = sha256(payloadFrame);

  const sealed = await hpke.seal(
    payloadFrame,
    EMPTY,
    keys.senderEncryptionKey,
    keys.receiverEncryptionKey,
    envelopeBytes,
  );
  // Reference ciphertext layout: ct ‖ tag(16) ‖ enc(32).
  const gPayload = concat(sealed.ciphertext, sealed.enc);

  const wireBytes: number[] = [];
  for (const b of envelopeBytes) wireBytes.push(b);
  wire.encodeVariableData(wire.TSP_HPKEAUTH_CIPHERTEXT, gPayload, wireBytes);

  const signature = sign.sign(new Uint8Array(wireBytes), keys.senderSigningKey);
  encodeSignatureFrame(signature, wireBytes);

  return { bytes: new Uint8Array(wireBytes), threadDigest };
}

/**
 * Unpack a direct TSP message: parse the envelope (HPKE info), verify the
 * Ed25519 signature over envelope‖ciphertext, split `enc` off the tail, and
 * HPKE-Auth open (empty AAD).
 */
export async function unpack(
  wireBytes: Uint8Array,
  keys: UnpackKeys,
): Promise<UnpackedMessage> {
  if (wireBytes.length < 48) throw new Error("tsp: message too short");

  const { envelope, headerLen } = decodeEnvelope(wireBytes);
  const envelopeBytes = wireBytes.slice(0, headerLen);

  const cur: wire.Cursor = { pos: headerLen };
  const ctRange = wire.decodeVariableDataRange(wire.TSP_HPKEAUTH_CIPHERTEXT, wireBytes, cur);
  if (ctRange === undefined) throw new Error("tsp: missing G ciphertext frame");
  const signedEnd = cur.pos; // signature covers envelope‖ciphertext

  const gLen = ctRange.end - ctRange.begin;
  if (gLen > wire.MAX_FIELD_SIZE) throw new Error("tsp: ciphertext too large");
  if (gLen < ENC_LEN + TAG_LEN) throw new Error("tsp: ciphertext truncated");

  const signature = decodeSignatureFrame(wireBytes, cur);
  if (cur.pos !== wireBytes.length) throw new Error("tsp: trailing bytes after signature");
  if (!sign.verify(wireBytes.slice(0, signedEnd), signature, keys.senderSigningKey)) {
    throw new Error("tsp: signature verification failed");
  }

  const gPayload = wireBytes.slice(ctRange.begin, ctRange.end);
  const encStart = gPayload.length - ENC_LEN;
  const enc = gPayload.slice(encStart);
  const ctAndTag = gPayload.slice(0, encStart);

  const payloadFrame = await hpke.open(
    ctAndTag,
    EMPTY,
    enc,
    keys.receiverDecryptionKey,
    keys.senderEncryptionKey,
    envelopeBytes,
  );
  const threadDigest = sha256(payloadFrame);
  const frame = decodePayloadFrame(payloadFrame);

  return {
    payload: frame.body,
    sender: envelope.sender,
    receiver: envelope.receiver,
    messageType: frame.kind,
    hops: frame.hops,
    threadDigest,
  };
}

/** SHA-256 (the TSP thread-digest hash). */
export { sha256 };
