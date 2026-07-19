// R1.6 — the durable record that makes acking safe.
//
// The transport acks once the onInbound handler resolves, and the ack makes
// the mediator delete its only copy. These cover the store that has to be
// written first, and the recovery it enables.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  putPendingInbound,
  listPendingInbound,
  removePendingInbound,
} from "../dist/inbound/pending.js";
import { markInboundHandled } from "../dist/inbound/dedup.js";

/** In-memory KVStore matching the interface IndexedDBKVStore implements. */
function memStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      // Round-trip through JSON so the test can't pass by sharing a live
      // object reference — IndexedDB gives back a structured clone.
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const CONSENT = {
  id: "urn:uuid:consent-1",
  type: "https://trusttasks.org/spec/task-consent/request/0.1",
  body: { payloadDigest: "z6Mkdigest", challenge: "c-1" },
};

test("a persisted message survives to be re-driven", async () => {
  const store = memStore();
  await putPendingInbound(store, {
    id: CONSENT.id,
    message: CONSENT,
    vtaDid: "did:webvh:example:vta",
    isApprover: false,
  });

  const [entry] = await listPendingInbound(store);
  assert.equal(entry.id, CONSENT.id);
  assert.equal(entry.vtaDid, "did:webvh:example:vta");
  assert.equal(entry.isApprover, false);
  assert.ok(entry.receivedAt > 0);
  // The WHOLE message, not just its id — the challenge and digest it was
  // signed over cannot be reconstructed from anywhere else once the mediator
  // has dropped its copy.
  assert.deepEqual(entry.message, CONSENT);
});

test("the record is only released when the interaction concludes", async () => {
  const store = memStore();
  await putPendingInbound(store, {
    id: CONSENT.id,
    message: CONSENT,
    vtaDid: "v",
    isApprover: false,
  });
  assert.equal((await listPendingInbound(store)).length, 1);

  await removePendingInbound(store, CONSENT.id);
  assert.deepEqual(await listPendingInbound(store), []);
});

test("an at-least-once redelivery refreshes rather than duplicating", async () => {
  // Delivery is at-least-once from 0.6.2 onward, so the same message WILL
  // arrive again after a reconnect whose ack was lost.
  const store = memStore();
  const entry = { id: CONSENT.id, message: CONSENT, vtaDid: "v", isApprover: false };
  await putPendingInbound(store, { ...entry, receivedAt: 1000 });
  await putPendingInbound(store, { ...entry, receivedAt: 9999 });

  const list = await listPendingInbound(store);
  assert.equal(list.length, 1, "one record, not two");
  assert.equal(list[0].receivedAt, 1000, "age must not be reset by a redelivery");
});

test("removing an unknown id is a no-op, not a throw", async () => {
  const store = memStore();
  await removePendingInbound(store, "urn:uuid:never-seen");
  assert.deepEqual(await listPendingInbound(store), []);
});

test("the store is bounded, evicting oldest first", async () => {
  const store = memStore();
  for (let i = 0; i < 70; i++) {
    await putPendingInbound(store, {
      id: `urn:uuid:m${i}`,
      message: { id: `urn:uuid:m${i}` },
      vtaDid: "v",
      isApprover: false,
    });
  }
  const list = await listPendingInbound(store);
  assert.equal(list.length, 64);
  assert.equal(list[0].id, "urn:uuid:m6", "oldest evicted");
  assert.equal(list.at(-1).id, "urn:uuid:m69", "newest retained");
});

test("records keep their own vtaDid and approver flag", async () => {
  // A decision is signed to a specific VTA and, for the approver inbox, with
  // a different identity. Draining under the wrong one would sign the wrong
  // thing to the wrong party.
  const store = memStore();
  await putPendingInbound(store, { id: "a", message: {}, vtaDid: "vta-1", isApprover: false });
  await putPendingInbound(store, { id: "b", message: {}, vtaDid: "vta-2", isApprover: true });

  const list = await listPendingInbound(store);
  const a = list.find((p) => p.id === "a");
  const b = list.find((p) => p.id === "b");
  assert.equal(a.vtaDid, "vta-1");
  assert.equal(a.isApprover, false);
  assert.equal(b.vtaDid, "vta-2");
  assert.equal(b.isApprover, true);
});

test("pending and dedup answer different questions", async () => {
  // The trap this guards: `dedup` marks a message handled BEFORE the user
  // decides, so an interrupted interaction is simultaneously "already
  // handled" and "still outstanding". A drain that consulted dedup would skip
  // precisely the consent request it exists to recover — which is why the
  // drain path bypasses it.
  const store = memStore();

  // Arrives, is persisted, and a prompt is raised (marking it handled).
  await putPendingInbound(store, {
    id: CONSENT.id,
    message: CONSENT,
    vtaDid: "v",
    isApprover: false,
  });
  assert.equal(await markInboundHandled(store, CONSENT.id), true);

  // ...worker dies here, before the user answers.

  // On restart: dedup says "seen it", pending says "not finished".
  assert.equal(await markInboundHandled(store, CONSENT.id), false, "dedup: already prompted");
  const outstanding = await listPendingInbound(store);
  assert.equal(outstanding.length, 1, "pending: still outstanding — must be re-driven");
  assert.equal(outstanding[0].id, CONSENT.id);
});
