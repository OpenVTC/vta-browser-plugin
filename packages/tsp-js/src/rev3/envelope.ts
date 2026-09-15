// The Rev 3 `-E` envelope frame (spec Rev 3 §9.1).
//
// The envelope is the cleartext outer frame: TSP version, sender VID, receiver
// VID. Two things changed from Rev 2 and both reach right through the packing
// code:
//
// 1. **One frame for everything.** The `-E` count now covers *all* signable
//    content — version, VIDs and the ciphertext — where Rev 2's covered only
//    the header fields. It therefore cannot be written until the ciphertext
//    size is known, which is why encoding splits into `encodeFields` (what
//    exists before sealing) and `finalizeFrame` (what exists after).
//
// 2. **The trailing `X 00 00` marker is deleted.** The receiver-VID field is
//    always present instead, with the NULL VID `4BAA` meaning "absent".
//
// The encoded *fields* — version ‖ VID_sndr ‖ VID_rcvr, without the `-E` count
// code — are the HPKE-Base associated data (§8:
// `aad = CONCAT(TSP_Version, VID_sndr, VID_rcvr)`). That is exactly why the
// split falls where it does: the count code is not part of the AAD.

import * as wire from "../cesr/wire.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

export interface Envelope {
  sender: string;
  /** Empty string is the NULL VID `4BAA` — "no receiver named". Not a valid
   *  VID, so the empty string is unambiguous as its representation. */
  receiver: string;
}

export interface DecodedEnvelope {
  envelope: Envelope;
  /** Byte range of the encoded envelope fields — the HPKE-Base AAD. */
  aad: { begin: number; end: number };
  /** Offset just past the envelope fields: where the ciphertext field begins. */
  headerLen: number;
  /** Offset just past the signable content the `-E` count declares, i.e. where
   *  the signature attachment begins. */
  contentEnd: number;
  /** MINOR as carried. Never gates processing. */
  minor: number;
}

/** Encode the envelope *fields* — version, sender VID, receiver VID — without
 *  the enclosing `-E` count code. These bytes are the HPKE-Base AAD. */
export function encodeFields(sender: string, receiver: string): Uint8Array {
  const body: number[] = [];
  wire.encodeVersion(body);
  wire.encodeVariableData(wire.TSP_VID, utf8.encode(sender), body);
  wire.encodeVariableData(wire.TSP_VID, utf8.encode(receiver), body);

  if (body.length % 3 !== 0) {
    throw new Error("tsp: envelope fields not a multiple of 3 bytes");
  }
  return new Uint8Array(body);
}

/** Prepend the `-E` count code to `fields ‖ body`, producing the complete
 *  envelope frame. The count covers both and excludes the signature
 *  attachment the caller appends afterwards. */
export function finalizeFrame(fields: Uint8Array, body: Uint8Array): Uint8Array {
  const contentLen = fields.length + body.length;
  if (contentLen % 3 !== 0) {
    throw new Error("tsp: envelope content not a multiple of 3 bytes");
  }
  const out: number[] = [];
  wire.encodeCount(wire.TSP_ETS_WRAPPER, contentLen / 3, out);
  for (const b of fields) out.push(b);
  for (const b of body) out.push(b);
  return new Uint8Array(out);
}

/** Decode a Rev 3 envelope and report the offsets needed to open and verify
 *  the message. Throws on a malformed frame. */
export function decodeEnvelope(data: Uint8Array): DecodedEnvelope {
  const cur: wire.Cursor = { pos: 0 };

  // The `-E` count is validated against the message length: §9.1 requires the
  // declared signable length to be checked on receive, so a frame claiming more
  // content than the message holds is rejected here rather than surfacing later
  // as something that reads like a crypto failure.
  const quadlets = wire.decodeCount(wire.TSP_ETS_WRAPPER, data, cur);
  if (quadlets === undefined) throw new Error("tsp: missing -E envelope frame");
  const contentBegin = cur.pos;
  const contentEnd = contentBegin + quadlets * 3;
  if (contentEnd > data.length) {
    throw new Error("tsp: -E frame declares more content than the message");
  }

  const version = wire.readVersion(data, cur);
  if (version === undefined) throw new Error("tsp: missing or malformed version marker");

  const senderBytes = wire.decodeVariableData(wire.TSP_VID, data, cur);
  if (senderBytes === undefined) throw new Error("tsp: missing sender VID");
  const receiverBytes = wire.decodeVariableData(wire.TSP_VID, data, cur);
  if (receiverBytes === undefined) throw new Error("tsp: missing receiver VID field");

  let sender: string;
  let receiver: string;
  try {
    sender = fromUtf8.decode(senderBytes);
    receiver = fromUtf8.decode(receiverBytes);
  } catch {
    throw new Error("tsp: invalid VID encoding");
  }
  if (sender.length === 0) {
    throw new Error("tsp: sender VID is the NULL VID; every TSP message names its sender");
  }

  if (cur.pos > contentEnd) {
    throw new Error("tsp: envelope fields overrun the -E frame count");
  }

  return {
    envelope: { sender, receiver },
    aad: { begin: contentBegin, end: cur.pos },
    headerLen: cur.pos,
    contentEnd,
    minor: version.minor,
  };
}
