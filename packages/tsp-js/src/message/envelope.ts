// The public envelope decode.
//
// A relay routes on the cleartext envelope and never opens the message, so this
// works with no keys at all. It reads the version marker first
// (`../revision.ts`), refuses a MAJOR we do not speak, and hands the frame to
// the codec.
//
// There is no public envelope *encode* here: the codec's
// `encodeFields`/`finalizeFrame` pair is the only way to build one, and it is
// deliberately not reachable through a name that suggests a standalone
// envelope exists.

import { decodeEnvelope as decodeV1 } from "../v1/envelope.js";
import { peekRevision } from "../revision.js";

export interface Envelope {
  sender: string;
  /** Empty string is the NULL VID (`4BAA`) — "no receiver named". */
  receiver: string;
}

export interface DecodedEnvelope {
  envelope: Envelope;
  /** Offset at which the ciphertext field begins. The AAD is the bytes before
   *  it, minus the `-E` count code; code that needs it should use the codec. */
  headerLen: number;
  /** MINOR as carried, unjudged. */
  minor: number;
}

/** Decode the cleartext envelope of a TSP 1.0 message. Throws
 *  `TspRevisionError` for any other MAJOR. */
export function decodeEnvelope(data: Uint8Array): DecodedEnvelope {
  peekRevision(data);
  const decoded = decodeV1(data);
  return {
    envelope: decoded.envelope,
    headerLen: decoded.headerLen,
    minor: decoded.minor,
  };
}
