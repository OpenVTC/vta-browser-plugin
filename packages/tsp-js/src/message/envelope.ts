// TSP message envelope — the binary-CESR `-E` (encrypted-then-signed) header.
// TS port of affinidi-tsp `src/message/envelope.rs`.
//
// The envelope is the cleartext outer frame: TSP version + sender VID +
// receiver VID + a 2-byte TMP marker. Its encoded bytes are used verbatim as
// the HPKE **`info`** (see `direct.ts`), binding sender/receiver to the
// ciphertext. Byte-compatible with tsp-sdk.
//
//   -E<count>  ·  YTSP<ver>  ·  B sender-VID  ·  B receiver-VID  ·  X 00 00

import * as wire from "../cesr/wire.js";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

export interface Envelope {
  sender: string;
  receiver: string;
}

export interface DecodedEnvelope {
  envelope: Envelope;
  /** Bytes consumed by the `-E` frame — i.e. the HPKE `info` length. */
  headerLen: number;
}

/** Encode an envelope to its binary-CESR `-E` frame. The returned bytes are the
 *  HPKE `info` for the message. */
export function encodeEnvelope(sender: string, receiver: string): Uint8Array {
  const body: number[] = [];
  wire.encodeVersion(body);
  wire.encodeVariableData(wire.TSP_VID, utf8.encode(sender), body);
  wire.encodeVariableData(wire.TSP_VID, utf8.encode(receiver), body);
  wire.encodeFixedData(wire.TSP_TMP, new Uint8Array([0, 0]), body);

  if (body.length % 3 !== 0) {
    throw new Error("tsp: envelope body not a multiple of 3 bytes");
  }

  const out: number[] = [];
  wire.encodeCount(wire.TSP_ETS_WRAPPER, body.length / 3, out);
  for (const b of body) out.push(b);
  return new Uint8Array(out);
}

/** Decode an envelope from the start of `data`, reporting the `-E` frame length
 *  (the HPKE `info` byte length). Throws on a malformed frame. */
export function decodeEnvelope(data: Uint8Array): DecodedEnvelope {
  const cur: wire.Cursor = { pos: 0 };

  if (wire.decodeCount(wire.TSP_ETS_WRAPPER, data, cur) === undefined) {
    throw new Error("tsp: missing -E envelope wrapper");
  }
  if (!wire.decodeVersion(data, cur)) {
    throw new Error("tsp: missing or malformed version marker");
  }

  const senderBytes = wire.decodeVariableData(wire.TSP_VID, data, cur);
  if (senderBytes === undefined) throw new Error("tsp: missing sender VID");
  const receiverBytes = wire.decodeVariableData(wire.TSP_VID, data, cur);
  if (receiverBytes === undefined) throw new Error("tsp: missing receiver VID");

  let sender: string;
  let receiver: string;
  try {
    sender = fromUtf8.decode(senderBytes);
    receiver = fromUtf8.decode(receiverBytes);
  } catch {
    throw new Error("tsp: invalid VID encoding");
  }

  // Consume the 2-byte TMP marker if present (the reference emits it
  // unconditionally for encrypted messages).
  wire.decodeFixedData(wire.TSP_TMP, 2, data, cur);

  return { envelope: { sender, receiver }, headerLen: cur.pos };
}
