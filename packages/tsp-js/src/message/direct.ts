// The public message API: pack Rev 3, unpack either.
//
// ── The asymmetry is the design ──
//
// `unpack` dispatches on the version marker a message carries; `pack` does not
// dispatch on anything, because there is nothing to dispatch on. An inbound
// message *says* what revision it is. An outbound one has to be decided before
// a byte exists, and the wire carries no field that would tell us what a peer
// can read — so a dual *packer* could only ever be a guess dressed as a
// protocol. We pack Rev 3.
//
// What that costs is exact and worth stating plainly: a Rev 2 peer cannot read
// what we send. Nothing here softens that, retries, or falls back. What it buys
// is that the Rev 3 path has no revision branch in it anywhere — the word
// "rev2" appears in this file and in `../rev2/`, and nowhere else.
//
// `revision` on the result is how a caller learns what a peer actually speaks.
// Persisting that per peer belongs above this package: a codec has no business
// holding state about who it has talked to.

import { sha256 } from "@noble/hashes/sha2.js";

import { unpack as unpackRev2, type Rev2UnpackKeys } from "../rev2/reader.js";
import {
  pack as packRev3,
  packWithHops as packWithHopsRev3,
  unpack as unpackRev3,
  type PackKeys,
  type PackedMessage,
} from "../rev3/direct.js";
import type { ControlType, MessageType } from "../rev3/payload.js";
import { describeRevision, peekRevision, TspRevisionError, type Revision } from "../revision.js";

export type { ControlType, MessageType, PackKeys, PackedMessage };

/** Keys needed to unpack a message of either revision.
 *
 *  `senderEncryptionKey` is Rev 2's alone: HPKE-Auth puts the sender's static
 *  key in the KEM, so a Rev 2 message cannot be *opened* without it, let alone
 *  verified. It is optional because the Rev 3 path has no use for it at all,
 *  and a required field that one whole revision ignores teaches the wrong thing
 *  about what authenticates a Rev 3 sender. Omit it and a Rev 2 message is
 *  refused by name rather than by a decryption failure. */
export interface UnpackKeys {
  /** Receiver's X25519 private key. */
  receiverDecryptionKey: Uint8Array;
  /** Sender's Ed25519 public key (outer signature verification). */
  senderSigningKey: Uint8Array;
  /** Sender's X25519 public key. **Rev 2 only** — HPKE-Auth sender
   *  authentication. */
  senderEncryptionKey?: Uint8Array;
}

export interface UnpackedMessage {
  /** The decrypted message body. For Direct it is the upper-layer payload; for
   *  Nested/Routed the opaque inner message (the route is in `hops`). */
  payload: Uint8Array;
  /** Sender VID, from the cleartext envelope. */
  sender: string;
  /** Receiver VID, from the cleartext envelope. */
  receiver: string;
  /** The message kind recovered from the payload frame. */
  messageType: MessageType;
  /** Which control message, when `messageType` is `"control"`. Rev 3 only —
   *  Rev 2 messages never decode to a control frame here. */
  controlType?: ControlType;
  /** Remaining route for a Routed message (empty otherwise). */
  hops: string[];
  /** SHA-256 of the payload frame — the TSP thread digest. */
  threadDigest: Uint8Array;
  /** Which revision framed this message. A caller that tracks what a peer
   *  speaks reads it here. */
  revision: Revision;
}

/** Pack a direct TSP message (Rev 3). */
export function pack(
  body: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packRev3(body, senderVid, receiverVid, keys);
}

/** Pack a message of any kind (Rev 3), carrying a routing `hops` list in the
 *  payload frame. `hops` must be empty for Direct/Nested. */
export function packWithHops(
  body: Uint8Array,
  kind: "direct" | "nested" | "routed",
  hops: string[],
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packWithHopsRev3(body, kind, hops, senderVid, receiverVid, keys);
}

/**
 * Unpack a TSP message of either revision, dispatching on its version marker.
 *
 * A parse failure against a frame whose MINOR we do not recognise is re-reported
 * as a {@link TspRevisionError} naming both revisions and carrying the
 * underlying error. Without that, a frame from a revision we have never seen
 * dies wherever its layout first disagrees with ours — which is almost never
 * where the actual problem is.
 */
export async function unpack(
  wireBytes: Uint8Array,
  keys: UnpackKeys,
): Promise<UnpackedMessage> {
  const peeked = peekRevision(wireBytes);

  try {
    if (peeked.revision === "rev2") {
      if (keys.senderEncryptionKey === undefined) {
        throw new TspRevisionError(
          "tsp: message is Rev 2 (YTSP-AAB), which needs the sender's X25519 public key to open (HPKE-Auth); pass senderEncryptionKey",
          peeked.major,
          peeked.minor,
        );
      }
      const rev2Keys: Rev2UnpackKeys = {
        receiverDecryptionKey: keys.receiverDecryptionKey,
        senderEncryptionKey: keys.senderEncryptionKey,
        senderSigningKey: keys.senderSigningKey,
      };
      const out = await unpackRev2(wireBytes, rev2Keys);
      return { ...out, revision: "rev2" };
    }

    const out = await unpackRev3(wireBytes, {
      receiverDecryptionKey: keys.receiverDecryptionKey,
      senderSigningKey: keys.senderSigningKey,
    });
    return { ...out, revision: "rev3" };
  } catch (err) {
    // A revision error is already about the revision; re-wrapping would bury it.
    if (err instanceof TspRevisionError) throw err;
    if (!peeked.recognised) {
      throw new TspRevisionError(
        `tsp: could not parse a message declaring ${describeRevision(peeked)}; this implementation packs Rev 3 (YTSP-AAC) and reads Rev 2 (YTSP-AAB). Underlying error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        peeked.major,
        peeked.minor,
      );
    }
    throw err;
  }
}

/** SHA-256 (the TSP thread-digest hash). */
export { sha256 };
