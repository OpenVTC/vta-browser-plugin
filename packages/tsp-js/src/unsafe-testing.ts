// @openvtc/vti-tsp-js/unsafe-testing — deterministic packing, for reproducing
// published test vectors. **NOT FOR PRODUCTION USE.**
//
// Every function here packs exactly what its namesake in the main entry point
// packs, except that the HPKE-Base ephemeral key is derived from a caller-fixed
// `ikmE` (RFC 9180 §7.1.3 DeriveKeyPair) instead of drawn at random, and the
// ESSR sender field may be written as the NULL VID. Ed25519 signatures are
// already deterministic, so with those two fixed — and the invite nonce, which
// `packInvite` already takes — the whole message is reproducible byte for byte.
//
// ── Why this is unsafe ──
//
// A fixed ephemeral key repeats the HPKE (key, base_nonce) pair for every
// message sealed with it to the same recipient. Under ChaCha20Poly1305 that
// leaks the XOR of the plaintexts and the Poly1305 one-time key, so both
// confidentiality and integrity are gone. Anyone who learns `ikmE` can also
// derive the ephemeral secret and open the message outright. The only safe
// `ikmE` is one already published next to a test vector.
//
// It is a separate subpath, absent from the main entry point and from the
// documented API, so that it cannot be reached by accident: importing it is a
// statement that the caller is a test. Every export carries the `__unsafe`
// prefix the package already uses for its fixed-ephemeral HPKE hook.

import { MAX_HOPS } from "./cesr/wire.js";
import {
  pack,
  packAccept,
  packCancel,
  packInvite,
  packWithHops,
  type PackKeys,
  type PackedMessage,
  type UnsafeDeterministicPack,
} from "./rev3/direct.js";

export type { PackKeys, PackedMessage, UnsafeDeterministicPack };

/** `pack` (direct, `XSCS`) with a fixed ephemeral. Test vectors only. */
export async function __unsafeDeterministicPack(
  body: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
  unsafe: UnsafeDeterministicPack,
): Promise<PackedMessage> {
  return pack(body, senderVid, receiverVid, keys, requireIkm(unsafe));
}

/** `packInvite` (`XRFI`) with a fixed ephemeral and a caller nonce. Test vectors
 *  only. The nonce is required here: a random one would defeat the point. */
export async function __unsafeDeterministicPackInvite(
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
  opts: { route?: string[]; nonce: Uint8Array },
  unsafe: UnsafeDeterministicPack,
): Promise<PackedMessage> {
  return packInvite(senderVid, receiverVid, keys, opts, requireIkm(unsafe));
}

/** `packAccept` (`XRFA`) with a fixed ephemeral. Test vectors only. */
export async function __unsafeDeterministicPackAccept(
  inviteDigest: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
  unsafe: UnsafeDeterministicPack,
): Promise<PackedMessage> {
  return packAccept(inviteDigest, senderVid, receiverVid, keys, requireIkm(unsafe));
}

/** `packCancel` (`XRFD`) with a fixed ephemeral. Test vectors only. */
export async function __unsafeDeterministicPackCancel(
  relationshipDigest: Uint8Array,
  senderVid: string,
  receiverVid: string,
  keys: PackKeys,
  unsafe: UnsafeDeterministicPack,
): Promise<PackedMessage> {
  return packCancel(relationshipDigest, senderVid, receiverVid, keys, requireIkm(unsafe));
}

/** `packNested` (`XHOP`, empty hop list) with a fixed ephemeral. Test vectors
 *  only. */
export async function __unsafeDeterministicPackNested(
  innerBytes: Uint8Array,
  senderVid: string,
  intermediaryVid: string,
  keys: PackKeys,
  unsafe: UnsafeDeterministicPack,
): Promise<PackedMessage> {
  return packWithHops(innerBytes, "nested", [], senderVid, intermediaryVid, keys, requireIkm(unsafe));
}

/** `packRouted` (`XHOP`) with a fixed ephemeral. Test vectors only. Same route
 *  bounds as `packRouted`. */
export async function __unsafeDeterministicPackRouted(
  inner: Uint8Array,
  remainingRoute: string[],
  senderVid: string,
  firstHopVid: string,
  keys: PackKeys,
  unsafe: UnsafeDeterministicPack,
): Promise<PackedMessage> {
  if (remainingRoute.length === 0) {
    throw new Error("tsp: a routed message requires at least one onward hop");
  }
  if (remainingRoute.length > MAX_HOPS) {
    throw new Error(`tsp: route has ${remainingRoute.length} hops, exceeds max ${MAX_HOPS}`);
  }
  return packWithHops(inner, "routed", remainingRoute, senderVid, firstHopVid, keys, requireIkm(unsafe));
}

/** An absent `ikmE` would silently fall back to a random ephemeral and produce
 *  bytes that match nothing — refuse it by name instead. */
function requireIkm(unsafe: UnsafeDeterministicPack): UnsafeDeterministicPack {
  if (!(unsafe?.__unsafeIkmE instanceof Uint8Array)) {
    throw new Error("tsp: unsafe-testing packers need __unsafeIkmE (a Uint8Array)");
  }
  return unsafe;
}
