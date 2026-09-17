// Rev 2 — read only.
//
// This module decodes messages framed under spec Rev 2 and **cannot pack one**.
// That asymmetry is the whole design: a Rev 2 peer cannot read anything we
// send, so emitting Rev 2 would buy nothing and would leave a legacy encoder
// alive to rot. Reading one costs this file and ends a class of unreadable
// failure — a Rev 2 frame handed to the Rev 3 codec dies at the ciphertext
// selector with "missing F ciphertext field", which points at the crypto layer
// for a problem that is nothing of the sort.
//
// It is deliberately frozen. Nothing here should ever need to change, because
// Rev 2 is finished: when the last Rev 2 peer is gone this file and its arm of
// the dispatcher are deleted together, and nothing else moves.
//
//   -E<count> envelope (= HPKE info):  YTSP<ver> · B sender · B receiver · X 00 00
//   <G var-data> ciphertext = ct ‖ tag(16) ‖ enc(32)
//   -C22 -K22 <fixed B> sig(64)        Ed25519 over envelope ‖ ciphertext
//
// The encrypted plaintext is itself a CESR payload frame:
//   -Z<count> [B sender-VID] XSCS <B var-data> body
//
// Differences from Rev 3, each of which is why this cannot be a flag on the
// Rev 3 codec: HPKE-**Auth** (so the sender's X25519 *public* key is needed to
// open at all), the envelope frame as HPKE `info` with empty AAD, `enc` at the
// tail rather than the head, the `G` ciphertext code, the `X 00 00` marker, an
// `-E` count that covers only the header, a non-indexed signature code, a `-J`
// count that counts VIDs rather than bytes, an inner message wrapped in a `B`
// field, and the long count code spelled `-0X`.

import { sha256 } from "@noble/hashes/sha2.js";

import * as wire from "../cesr/wire.js";
import * as hpke from "../crypto/hpke.js";
import * as sign from "../crypto/sign.js";

const ENC_LEN = 32;
const TAG_LEN = 16;
const SIG_LEN = 64;
const SIG_QUADLETS = 22;
const EMPTY = new Uint8Array(0);

const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Rev 2's long count code spelling, from a superseded draft of the CESR v2
 *  tables. Every `decodeCount` in this file passes it. */
const LONG = wire.LONG_COUNT_REV2;

/** Keys needed to open a Rev 2 message. Note the third: HPKE-Auth puts the
 *  sender's static key in the KEM, so without the sender's X25519 **public**
 *  key a Rev 2 message cannot be opened at all — not merely left unverified. */
export interface Rev2UnpackKeys {
  receiverDecryptionKey: Uint8Array;
  senderEncryptionKey: Uint8Array;
  senderSigningKey: Uint8Array;
}

export interface Rev2UnpackedMessage {
  payload: Uint8Array;
  sender: string;
  receiver: string;
  messageType: "direct" | "nested" | "routed";
  hops: string[];
  threadDigest: Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Decode the Rev 2 envelope, reporting the frame length — which is the HPKE
 *  `info` byte length, because Rev 2 bound the ciphertext by passing the whole
 *  envelope frame as `info`. */
export function decodeRev2Envelope(
  data: Uint8Array,
): { sender: string; receiver: string; headerLen: number } {
  const cur: wire.Cursor = { pos: 0 };

  if (wire.decodeCount(wire.TSP_ETS_WRAPPER, data, cur, LONG) === undefined) {
    throw new Error("tsp(rev2): missing -E envelope wrapper");
  }
  const version = wire.readVersion(data, cur);
  if (version === undefined) throw new Error("tsp(rev2): missing or malformed version marker");

  const senderBytes = wire.decodeVariableData(wire.TSP_VID, data, cur);
  if (senderBytes === undefined) throw new Error("tsp(rev2): missing sender VID");
  const receiverBytes = wire.decodeVariableData(wire.TSP_VID, data, cur);
  if (receiverBytes === undefined) throw new Error("tsp(rev2): missing receiver VID");

  let sender: string;
  let receiver: string;
  try {
    sender = fromUtf8.decode(senderBytes);
    receiver = fromUtf8.decode(receiverBytes);
  } catch {
    throw new Error("tsp(rev2): invalid VID encoding");
  }

  // The 2-byte TMP marker, emitted unconditionally for encrypted messages.
  wire.decodeFixedData(wire.TSP_TMP, 2, data, cur);

  return { sender, receiver, headerLen: cur.pos };
}

/** Decode a Rev 2 hop list: a `-J` group whose count is the number of VIDs. */
function decodeHops(stream: Uint8Array, cur: wire.Cursor): Uint8Array[] {
  const count = wire.decodeCount(wire.TSP_HOP_LIST, stream, cur, LONG);
  if (count === undefined) throw new Error("tsp(rev2): malformed hop list");
  if (count > wire.MAX_HOPS) throw new Error("tsp(rev2): too many hops");
  const hops: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const hop = wire.decodeVariableData(wire.TSP_VID, stream, cur);
    if (hop === undefined) throw new Error("tsp(rev2): malformed hop VID");
    hops.push(hop);
  }
  return hops;
}

function decodePayloadFrame(frame: Uint8Array): {
  kind: "direct" | "nested" | "routed";
  hops: string[];
  body: Uint8Array;
} {
  const cur: wire.Cursor = { pos: 0 };
  if (wire.decodeCount(wire.TSP_PAYLOAD, frame, cur, LONG) === undefined) {
    throw new Error("tsp(rev2): missing -Z payload frame");
  }
  // Optional ESSR sender-VID: the reference omits it for HPKE-Auth, where the
  // KEM already authenticates the sender. A non-VID marker will not match a `B`
  // var-data field, so this is a tolerant skip — which is exactly what Rev 3
  // replaced with a required field and a mandatory cross-check.
  wire.decodeVariableData(wire.TSP_VID, frame, cur);

  const marker = frame.slice(cur.pos, cur.pos + 3);
  if (bytesEqual(marker, wire.XSCS)) {
    cur.pos += 3;
    const body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (body === undefined) throw new Error("tsp(rev2): missing payload plaintext");
    return { kind: "direct", hops: [], body };
  }
  if (bytesEqual(marker, wire.XHOP)) {
    cur.pos += 3;
    const hopBytes = decodeHops(frame, cur);
    let hops: string[];
    try {
      hops = hopBytes.map((h) => fromUtf8.decode(h));
    } catch {
      throw new Error("tsp(rev2): hop VID not UTF-8");
    }
    const body = wire.decodeVariableData(wire.TSP_PLAINTEXT, frame, cur);
    if (body === undefined) throw new Error("tsp(rev2): missing payload plaintext");
    return { kind: hops.length === 0 ? "nested" : "routed", hops, body };
  }
  throw new Error("tsp(rev2): unsupported payload type marker");
}

/** Unpack a Rev 2 message: verify the Ed25519 signature over
 *  envelope ‖ ciphertext, split `enc` off the **tail**, and HPKE-Auth open with
 *  the envelope as `info` and empty AAD. */
export async function unpack(
  wireBytes: Uint8Array,
  keys: Rev2UnpackKeys,
): Promise<Rev2UnpackedMessage> {
  if (wireBytes.length < 48) throw new Error("tsp(rev2): message too short");

  const { sender, receiver, headerLen } = decodeRev2Envelope(wireBytes);
  const envelopeBytes = wireBytes.slice(0, headerLen);

  const cur: wire.Cursor = { pos: headerLen };
  const ctRange = wire.decodeVariableDataRange(wire.TSP_HPKEAUTH_CIPHERTEXT, wireBytes, cur);
  if (ctRange === undefined) throw new Error("tsp(rev2): missing G ciphertext frame");
  const signedEnd = cur.pos; // the signature covers envelope ‖ ciphertext

  const gLen = ctRange.end - ctRange.begin;
  if (gLen > wire.MAX_FIELD_SIZE) throw new Error("tsp(rev2): ciphertext too large");
  if (gLen < ENC_LEN + TAG_LEN) throw new Error("tsp(rev2): ciphertext truncated");

  const attach = wire.decodeCount(wire.TSP_ATTACH_GRP, wireBytes, cur, LONG);
  const group = wire.decodeCount(wire.TSP_INDEX_SIG_GRP, wireBytes, cur, LONG);
  if (attach !== SIG_QUADLETS || group !== SIG_QUADLETS) {
    throw new Error("tsp(rev2): unexpected signature group size");
  }
  const signature = wire.decodeFixedData(wire.ED25519_SIGNATURE, SIG_LEN, wireBytes, cur);
  if (signature === undefined) throw new Error("tsp(rev2): missing Ed25519 signature");
  if (cur.pos !== wireBytes.length) throw new Error("tsp(rev2): trailing bytes after signature");
  if (!sign.verify(wireBytes.slice(0, signedEnd), signature, keys.senderSigningKey)) {
    throw new Error("tsp(rev2): signature verification failed");
  }

  const gPayload = wireBytes.slice(ctRange.begin, ctRange.end);
  const encStart = gPayload.length - ENC_LEN;
  const payloadFrame = await hpke.open(
    gPayload.slice(0, encStart),
    EMPTY,
    gPayload.slice(encStart),
    keys.receiverDecryptionKey,
    keys.senderEncryptionKey,
    envelopeBytes,
  );

  const threadDigest = sha256(payloadFrame);
  const frame = decodePayloadFrame(payloadFrame);
  return {
    payload: frame.body,
    sender,
    receiver,
    messageType: frame.kind,
    hops: frame.hops,
    threadDigest,
  };
}
