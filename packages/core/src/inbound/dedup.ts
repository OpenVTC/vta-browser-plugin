// Durable de-duplication for inbound DIDComm messages.
//
// A message-pickup mediator keeps every un-acked message queued and replays
// it on each (re)connection. An MV3 service worker is ephemeral, so the
// offscreen mediator session reconnects often — without de-dup, the same
// RP-initiated `confirm` request fires a fresh consent popup every time the
// worker respawns. The mediator-side `messages-received` ack is the upstream
// fix, but its effect depends on the mediator's queue-id semantics; this
// client-side guard is the durable backstop and works regardless.
//
// State is persisted (KVStore → IndexedDB) so it survives worker respawns,
// which is exactly when the replays arrive. Bounded to the most recent N ids.

import type { KVStore } from "../store/kv-store.js";

const HANDLED_IDS_KEY = "inbound:handled-ids";
const MAX_HANDLED_IDS = 256;

/**
 * Atomically record that an inbound message id has been handled.
 *
 * @returns `true` if the id was newly recorded (caller should process the
 *   message); `false` if it had already been handled (a replay — skip it).
 */
export async function markInboundHandled(store: KVStore, id: string): Promise<boolean> {
  const ids = (await store.get<string[]>(HANDLED_IDS_KEY)) ?? [];
  if (ids.includes(id)) return false;
  ids.push(id);
  if (ids.length > MAX_HANDLED_IDS) ids.splice(0, ids.length - MAX_HANDLED_IDS);
  await store.put(HANDLED_IDS_KEY, ids);
  return true;
}
