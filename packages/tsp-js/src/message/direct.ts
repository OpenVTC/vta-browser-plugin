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
  packAccept as packAcceptRev3,
  packCancel as packCancelRev3,
  packInvite as packInviteRev3,
  packWithHops as packWithHopsRev3,
  unpack as unpackRev3,
  type PackKeys,
  type PackedMessage,
} from "../rev3/direct.js";
import type { ApplicationKind, ControlMessage, ControlType } from "../rev3/payload.js";
import type { MessageType } from "../rev3/payload.js";
import { describeRevision, peekRevision, TspRevisionError, type Revision } from "../revision.js";

export type { ApplicationKind, ControlMessage, ControlType, MessageType, PackKeys, PackedMessage };

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
  /** The recovered relationship-forming message, when there is one (§7.2).
   *
   *  Rev 3 only: Rev 2 messages never decode to one here. Its self-addressing
   *  digest has already been verified against the frame, so a `control` that is
   *  present identified itself correctly — but *what to do about it* is the
   *  caller's, via `relationship.ts`. */
  control?: ControlMessage;
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
  kind: ApplicationKind,
  hops: string[],
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packWithHopsRev3(body, kind, hops, senderVid, receiverVid, keys);
}

/**
 * Pack a relationship-forming invite (`XRFI`, §7.2).
 *
 * `PackedMessage.threadDigest` is the invite's self-addressing digest, and the
 * caller must keep it: it is what the accept echoes back, and what a later
 * cancellation names. It cannot be known before packing — the derivation covers
 * the envelope this call builds.
 */
export function packInvite(
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
  opts: { route?: string[]; nonce?: Uint8Array } = {},
): Promise<PackedMessage> {
  return packInviteRev3(senderVid, receiverVid, keys, opts);
}

/** Pack a relationship-forming accept (`XRFA`) answering `inviteDigest`. */
export function packAccept(
  inviteDigest: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packAcceptRev3(inviteDigest, senderVid, receiverVid, keys);
}

/** Pack a relationship cancellation (`XRFD`) naming either half of the
 *  relationship it ends (§7.2.1, §7.3). */
export function packCancel(
  relationshipDigest: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packCancelRev3(relationshipDigest, senderVid, receiverVid, keys);
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
