// TSP routed mode (§5.3) and nested mode (§5.5). TS port of affinidi-tsp
// `src/message/routed.rs`.
//
// Routed mode carries a message through intermediaries. The remaining hop list
// travels inside the HPKE-sealed payload of each routing layer, so only the
// addressed intermediary reads it. Nested mode is the degenerate wrapper: an
// inner packed message carried opaquely to a single intermediary.
//
// Wallet → mediator → VTA is a routed send: pack the trust-task as a Direct
// message to the VTA (sealed end-to-end), then `packRouted` it to the mediator
// with `route = [vtaVid]`. The mediator opens the routing layer, sees the VTA
// as the next (and last) hop, and forwards the opaque inner to it.

import { packWithHops, type PackKeys, type PackedMessage } from "./direct.js";

/** Max hops in a route — bounds memory + forwarding loops. */
export const MAX_HOPS = 16;

/**
 * Pack a routed message addressed to `firstHopVid`, carrying `remainingRoute`
 * (hops to visit after the first, in order) and the opaque `inner` message
 * (already sealed end-to-end to the exit/recipient). Full path is
 * `[firstHop, ...remainingRoute]`.
 */
export async function packRouted(
  inner: Uint8Array,
  remainingRoute: string[],
  senderVid: string,
  firstHopVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  if (remainingRoute.length === 0) {
    throw new Error("tsp: a routed message requires at least one onward hop");
  }
  if (remainingRoute.length > MAX_HOPS) {
    throw new Error(`tsp: route has ${remainingRoute.length} hops, exceeds max ${MAX_HOPS}`);
  }
  return packWithHops(inner, "routed", remainingRoute, senderVid, firstHopVid, keys);
}

/**
 * Pack a nested message: an inner packed TSP message carried opaquely to
 * `intermediaryVid` (metadata-privacy wrapper).
 */
export function packNested(
  innerBytes: Uint8Array,
  senderVid: string,
  intermediaryVid: string,
  keys: PackKeys,
): Promise<PackedMessage> {
  return packWithHops(innerBytes, "nested", [], senderVid, intermediaryVid, keys);
}

/** What an intermediary does after opening a routed layer. */
export type RouteStep =
  | {
      kind: "forward";
      /** The next hop's VID (the new envelope receiver). */
      next: string;
      /** The route to carry onward (hops after `next`). */
      remaining: string[];
      /** The opaque inner message, unchanged. */
      inner: Uint8Array;
    }
  | {
      kind: "deliver";
      /** The opaque inner message for this hop to deliver / process. */
      inner: Uint8Array;
    };

/** Determine the next routing step from a Routed message's remaining route +
 *  opaque inner (an unpacked message's `hops` + `payload`). */
export function nextHop(hops: string[], inner: Uint8Array): RouteStep {
  if (hops.length === 0) return { kind: "deliver", inner };
  const [next, ...remaining] = hops;
  return { kind: "forward", next: next!, remaining, inner };
}
