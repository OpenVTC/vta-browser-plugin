// The public, revision-dispatching envelope decode.
//
// A relay routes on the cleartext envelope and never opens the message, so this
// has to work for both revisions with no keys at all. It reads the version
// marker first (`../revision.ts`) and hands the frame to the matching codec.
//
// There is no public envelope *encode* here: we pack Rev 3 and nothing else, so
// the Rev 3 codec's `encodeFields`/`finalizeFrame` pair is the only way to
// build one, and it is deliberately not reachable through a name that suggests
// a revision-neutral envelope exists.

import { decodeEnvelope as decodeRev3 } from "../rev3/envelope.js";
import { decodeRev2Envelope } from "../rev2/reader.js";
import { peekRevision, type Revision } from "../revision.js";

export interface Envelope {
  sender: string;
  /** Empty string is Rev 3's NULL VID (`4BAA`) — "no receiver named". Rev 2
   *  had no such spelling and always names one. */
  receiver: string;
}

export interface DecodedEnvelope {
  envelope: Envelope;
  /** Bytes consumed by the envelope fields.
   *
   *  The number means different things per revision and is reported for
   *  diagnostics, not for arithmetic across them: in Rev 2 it is the whole `-E`
   *  frame, which is also the HPKE `info`; in Rev 3 it is the offset at which
   *  the ciphertext field begins, and the AAD is those bytes minus the count
   *  code. Code that needs either should use the revision's own codec. */
  headerLen: number;
  /** Which revision framed this message. */
  revision: Revision;
  /** MINOR as carried, unjudged. */
  minor: number;
}

/** Decode the cleartext envelope of a TSP message of either revision. */
export function decodeEnvelope(data: Uint8Array): DecodedEnvelope {
  const peeked = peekRevision(data);
  if (peeked.revision === "rev2") {
    const rev2 = decodeRev2Envelope(data);
    return {
      envelope: { sender: rev2.sender, receiver: rev2.receiver },
      headerLen: rev2.headerLen,
      revision: "rev2",
      minor: peeked.minor,
    };
  }
  const rev3 = decodeRev3(data);
  return {
    envelope: rev3.envelope,
    headerLen: rev3.headerLen,
    revision: "rev3",
    minor: rev3.minor,
  };
}
