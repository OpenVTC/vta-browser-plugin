// Duplicate-execution protection for inbound Trust-Task documents — SPEC §7.2
// item 11.
//
// A message-pickup mediator keeps every un-acked message queued and replays it
// on each (re)connection. An MV3 service worker is ephemeral, so the offscreen
// mediator session reconnects often — without this, the same RP-initiated
// `confirm` request fires a fresh consent popup every time the worker respawns,
// training the user to dismiss prompts, which is precisely how a consent
// surface is defeated.
//
// ## What §7.2 item 11 actually requires, and what this used to do instead
//
// Item 11 is normative and unconditional for a *consequential* Trust Task, and
// it has two halves:
//
//   - the **same** document arriving again MUST NOT cause the effect twice;
//   - a **different** document arriving under the same `id` MUST be rejected
//     as `idConflict`, and MUST NOT be treated as a retry.
//
// This module used to record bare ids in a list and answer "seen / not seen".
// That satisfies the first half by accident and cannot express the second at
// all: a different document under a used id read as "already handled" and was
// dropped in silence. Every transport binding delegates replay defence to the
// consumer — the HTTPS, DIDComm and TSP bindings all say "Freshness / replay:
// None" — so where this is not done, nobody does it.
//
// Two changes make the rule expressible. The key is now the **Trust-Task
// document's own `id`**, not the DIDComm message id: §7.2 is explicit that
// "transport request identifiers, transport message identifiers, and execution
// handles MUST NOT substitute", and a transport id is exactly what a mediator
// is free to change on redelivery. And the record now carries a digest of the
// document, because — in the spec's words — "an `id` alone cannot distinguish
// the retry it must absorb from the conflict it must reject".
//
// ## The digest is local, and deliberately not multibase
//
// `documentDigest` is SHA-256 over the RFC 8785 canonicalization of the whole
// document, `proof` included, as hex. It is consumer-local: it goes in this
// record and never on the wire. That is what separates it from the §4.9.3
// *task* digest, which is computed over `document ∖ proof`, is published, and
// IS a multibase-encoded multihash (see `../trust-tasks/digest.ts`). Encoding
// this one as multibase would imply it is interoperable, and it is not — it is
// only ever compared against itself.
//
// Canonicalizing rather than hashing the octets as received is what keeps a
// legitimate §8.4 retry from looking like a conflict: an intermediary that
// re-indents the body or reorders members has not produced a new document.
//
// State is persisted (KVStore → IndexedDB) so it survives worker respawns,
// which is exactly when the replays arrive. Bounded to the most recent N ids.

import { documentDigest } from "@openvtc/trust-tasks/_runtime/replay";

import type { KVStore } from "../store/kv-store.js";

/** Records written by this module: `[id, digest]` pairs, oldest first. */
const CLAIMS_KEY = "inbound:claims/v2";

const MAX_CLAIMS = 256;

/** What a claim says about a document offered for handling. */
export type InboundClaim =
  /** Not seen before. Handle it. */
  | "fresh"
  /** Same id, same document — a §8.4 retry or a mediator replay. Absorb it
   *  silently; the effect has already happened or is happening. */
  | "duplicate"
  /** Same id, **different** document. §7.2 item 11 forbids treating this as a
   *  retry: it is `idConflict`, and the caller must refuse rather than drop. */
  | "conflict";

/** `[id, digest]` pairs, oldest first. An array rather than an object so the
 *  LRU order survives the JSON round-trip through the store. */
type ClaimRecord = [string, string];

/**
 * Claim a Trust-Task document for handling, per SPEC §7.2 item 11.
 *
 * `doc` is the **Trust-Task document** — the DIDComm envelope's `body`, not
 * the DIDComm message. Passing the transport message means keying on a
 * transport id and digesting transport metadata, both of which §7.2 rules out.
 *
 * A document with no usable `id` is `"fresh"` every time: there is nothing to
 * key on, and refusing to handle it would drop a real request on the floor.
 * Validating that the envelope carries an `id` belongs to the parse step,
 * which reports it, rather than here, which would only be able to swallow it.
 */
export async function claimInboundDocument(
  store: KVStore,
  doc: unknown,
): Promise<InboundClaim> {
  const id = documentIdOf(doc);
  if (id === undefined) return "fresh";

  const digest = documentDigest(doc as Parameters<typeof documentDigest>[0]);

  const claims = (await store.get<ClaimRecord[]>(CLAIMS_KEY)) ?? [];
  const seen = claims.find(([claimedId]) => claimedId === id);
  if (seen) return seen[1] === digest ? "duplicate" : "conflict";

  claims.push([id, digest]);
  if (claims.length > MAX_CLAIMS) claims.splice(0, claims.length - MAX_CLAIMS);
  await store.put(CLAIMS_KEY, claims);
  return "fresh";
}

/**
 * The document `id`, when the value is an object carrying a non-empty string
 * one.
 *
 * Deliberately narrow. `id` is the whole key: coercing a number or accepting
 * `""` would let two unrelated documents collide on one record, and a
 * collision here is either a prompt that never appears or an effect that
 * happens twice.
 */
function documentIdOf(doc: unknown): string | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const id = (doc as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
