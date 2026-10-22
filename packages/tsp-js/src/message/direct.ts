// The public message API: pack and unpack TSP 1.0.
//
// `unpack` gates on the version marker a message carries and refuses any MAJOR
// but 1 — including the Rev 2 and Rev 3 drafts this package used to read — as
// a `TspRevisionError`, before a key is touched. `pack` has nothing to decide:
// it writes 1.0.

import { sha256 } from "@noble/hashes/sha2.js";

import {
  pack as packV1,
  packAccept as packAcceptV1,
  packCancel as packCancelV1,
  packInvite as packInviteV1,
  packWithHops as packWithHopsV1,
  unpack as unpackV1,
  type PackKeys,
  type PackedMessage,
  type UnpackKeys,
  type UnpackedMessage,
} from "../v1/direct.js";
import type { ApplicationKind, ControlMessage, ControlType } from "../v1/payload.js";
import type { MessageType } from "../v1/payload.js";
import { describeRevision, describeVersion, peekRevision, TspRevisionError } from "../revision.js";
import { TSP_VERSION } from "../cesr/wire.js";

export type {
  ApplicationKind,
  ControlMessage,
  ControlType,
  MessageType,
  PackKeys,
  PackedMessage,
  UnpackKeys,
  UnpackedMessage,
};

/** Pack a direct TSP message. */
export function pack(
  body: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packV1(body, senderVid, receiverVid, keys);
}

/** Pack a message of any kind, carrying a routing `hops` list in the
 *  payload frame. `hops` must be empty for Direct/Nested. */
export function packWithHops(
  body: Uint8Array,
  kind: ApplicationKind,
  hops: string[],
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packWithHopsV1(body, kind, hops, senderVid, receiverVid, keys);
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
  return packInviteV1(senderVid, receiverVid, keys, opts);
}

/** Pack a relationship-forming accept (`XRFA`) answering `inviteDigest`. */
export function packAccept(
  inviteDigest: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packAcceptV1(inviteDigest, senderVid, receiverVid, keys);
}

/** Pack a relationship cancellation (`XRFD`) naming either half of the
 *  relationship it ends (§7.2.1, §7.3). */
export function packCancel(
  relationshipDigest: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packCancelV1(relationshipDigest, senderVid, receiverVid, keys);
}

/**
 * Unpack a TSP 1.0 message.
 *
 * A frame at any other MAJOR is refused as a {@link TspRevisionError} naming
 * both versions. A parse failure against a 1.0 frame whose MINOR we do not
 * recognise is re-reported the same way, carrying the underlying error:
 * otherwise a frame from a version we have never seen dies wherever its layout
 * first disagrees with ours — which is almost never where the actual problem
 * is.
 */
export async function unpack(
  wireBytes: Uint8Array,
  keys: UnpackKeys,
): Promise<UnpackedMessage> {
  const peeked = peekRevision(wireBytes);

  try {
    return await unpackV1(wireBytes, keys);
  } catch (err) {
    if (!peeked.recognised) {
      throw new TspRevisionError(
        `tsp: could not parse a message declaring ${describeRevision(peeked)}; this implementation speaks ${describeVersion(TSP_VERSION.major, TSP_VERSION.minor)}. Underlying error: ${
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
