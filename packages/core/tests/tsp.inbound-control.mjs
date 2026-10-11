// A relationship control message that arrives with no request waiting for it.
//
// `ensureRelationship` claims the accept it waits for; anything else reaches
// the inbox. The inbox used to read it as a Trust-Task document, fail, and
// refuse it unacknowledged, so the mediator redelivered it on every reconnect
// (seen against glenn-vta, 2026-10-11). `applyInboundControl` applies it
// instead, by the specification's own rules.

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyInboundControl, MemoryRelationshipStore } from "../dist/index.js";

const US = "did:key:z6Mkholder";
const VTA = "did:webvh:Qm:host:vta";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const OUR_INVITE = new Uint8Array(32).fill(1);
const THEIR_ACCEPT = new Uint8Array(32).fill(2);
const SOMEONE_ELSES = new Uint8Array(32).fill(9);

const accept = (inReplyTo, digest = THEIR_ACCEPT) => ({ controlType: "accept", inReplyTo, digest, route: [] });
const cancel = (inReplyTo) => ({ controlType: "cancel", inReplyTo, digest: inReplyTo, route: [] });

test("an accept that came after the handshake stopped waiting completes the relationship", async () => {
  const store = new MemoryRelationshipStore();
  // What `ensureRelationship` leaves when the accept is late: still pending.
  await store.set(US, VTA, { state: "pending", ourDigest: hex(OUR_INVITE) });

  assert.deepEqual(await applyInboundControl(store, US, VTA, accept(OUR_INVITE)), { kind: "adopted" });
  assert.deepEqual(await store.get(US, VTA), {
    state: "bidirectional",
    ourDigest: hex(OUR_INVITE),
    theirDigest: hex(THEIR_ACCEPT),
  });
});

test("an accept to an invite we did not send changes nothing", async () => {
  const store = new MemoryRelationshipStore();
  await store.set(US, VTA, { state: "pending", ourDigest: hex(OUR_INVITE) });

  const out = await applyInboundControl(store, US, VTA, accept(SOMEONE_ELSES));
  assert.equal(out.kind, "ignored");
  assert.equal((await store.get(US, VTA)).state, "pending");
});

test("an accept with nothing outstanding changes nothing", async () => {
  const store = new MemoryRelationshipStore();
  const out = await applyInboundControl(store, US, VTA, accept(OUR_INVITE));
  assert.equal(out.kind, "ignored");
  assert.equal(await store.get(US, VTA), undefined);
});

test("a cancellation of a relationship held both ways removes it, and says an answer is owed", async () => {
  const store = new MemoryRelationshipStore();
  await store.set(US, VTA, { state: "bidirectional", ourDigest: hex(OUR_INVITE), theirDigest: hex(THEIR_ACCEPT) });

  // §7.2.1 lets a cancellation name either half.
  assert.deepEqual(await applyInboundControl(store, US, VTA, cancel(THEIR_ACCEPT)), {
    kind: "removed",
    reply: true,
  });
  assert.equal(await store.get(US, VTA), undefined);
});

test("a cancellation naming a relationship we do not hold is ignored, not answered", async () => {
  // Answering would let anyone probe which relationships we hold.
  const store = new MemoryRelationshipStore();
  await store.set(US, VTA, { state: "bidirectional", ourDigest: hex(OUR_INVITE) });

  const out = await applyInboundControl(store, US, VTA, cancel(SOMEONE_ELSES));
  assert.equal(out.kind, "ignored");
  assert.equal((await store.get(US, VTA)).state, "bidirectional");
});

test("an invite is ignored: this wallet does not take inbound relationships", async () => {
  const store = new MemoryRelationshipStore();
  const out = await applyInboundControl(store, US, VTA, {
    controlType: "invite",
    digest: SOMEONE_ELSES,
    nonce: new Uint8Array(16),
    route: [],
  });
  assert.equal(out.kind, "ignored");
  assert.equal(await store.get(US, VTA), undefined);
});
