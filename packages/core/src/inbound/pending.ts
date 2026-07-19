// Durable store for inbound messages that have been delivered but not yet
// finished with (R1.6).
//
// The mediator deletes its queued copy the moment we ack, and the transport
// acks as soon as the `onInbound` handler's promise settles. So between "the
// message arrived" and "we durably wrote it down" the mediator's copy is the
// ONLY copy — and in MV3, teardown in that window is normal operation, not a
// crash. A `task-consent/request` lost there is unrecoverable: the challenge
// and payloadDigest it was signed over are gone, the VTA waits for a decision
// that can never arrive, and nothing reports a failure.
//
// So: write the whole message here BEFORE the handler resolves, and delete it
// only once the interaction has actually concluded. Anything still present at
// startup is work that was interrupted — see `listPendingInbound`, which the
// offscreen document drains on boot.
//
// This is deliberately separate from `dedup.ts`. That answers "have I already
// PROMPTED for this?" and is what stops a mediator replay raising a second
// popup. This answers "is this still OUTSTANDING?". A message can be both —
// prompted, then interrupted before the user decided — and in that case it
// must be re-driven rather than skipped, which is why the drain path bypasses
// the dedup check.

import type { KVStore } from "../store/kv-store.js";

const PENDING_KEY = "inbound:pending";

/** Bound on retained pending records. The realistic depth is one or two (a
 *  human is deciding); this only stops an unbounded mediator or a persistent
 *  drain failure growing the store without limit. Oldest evicts first — a
 *  stale record is worth less than a fresh one. */
const MAX_PENDING = 64;

export interface PendingInbound {
  /** DIDComm message id — the key, and what `dedup.ts` also records. */
  id: string;
  /** The full message, so the interaction can be re-driven from scratch. */
  message: Record<string, unknown>;
  /** Which VTA's session this arrived on: a decision is signed to that VTA,
   *  and the drain must not attribute a message to the wrong one. */
  vtaDid: string;
  /** True if it arrived on the approver's biometric-gated inbox, which
   *  changes both the signing identity and the popup's demands. */
  isApprover: boolean;
  /** ms since epoch, for age-based triage on drain. */
  receivedAt: number;
}

/**
 * Durably record an inbound message as outstanding.
 *
 * Call this — and await it — BEFORE the `onInbound` handler resolves, so the
 * ack (and with it the mediator's deletion of its copy) cannot land first.
 *
 * Idempotent by message id: an at-least-once redelivery refreshes the record
 * rather than duplicating it, and never resets `receivedAt`, so a message
 * that keeps being redelivered still ages honestly.
 */
export async function putPendingInbound(
  store: KVStore,
  entry: Omit<PendingInbound, "receivedAt"> & { receivedAt?: number },
): Promise<void> {
  const list = (await store.get<PendingInbound[]>(PENDING_KEY)) ?? [];
  const existing = list.find((p) => p.id === entry.id);
  const record: PendingInbound = {
    id: entry.id,
    message: entry.message,
    vtaDid: entry.vtaDid,
    isApprover: entry.isApprover,
    receivedAt: existing?.receivedAt ?? entry.receivedAt ?? Date.now(),
  };
  const next = list.filter((p) => p.id !== entry.id);
  next.push(record);
  if (next.length > MAX_PENDING) next.splice(0, next.length - MAX_PENDING);
  await store.put(PENDING_KEY, next);
}

/** Every message still outstanding, oldest first. Drain this at startup. */
export async function listPendingInbound(store: KVStore): Promise<PendingInbound[]> {
  return (await store.get<PendingInbound[]>(PENDING_KEY)) ?? [];
}

/**
 * Drop a record once its interaction has genuinely concluded — a decision was
 * sent, or the message was refused/ignored on inspection.
 *
 * Do NOT call this merely because a prompt was raised. The window this store
 * exists to cover is precisely the one where a prompt is open and the worker
 * dies before the user answers.
 */
export async function removePendingInbound(store: KVStore, id: string): Promise<void> {
  const list = (await store.get<PendingInbound[]>(PENDING_KEY)) ?? [];
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return; // nothing to write
  await store.put(PENDING_KEY, next);
}
