// SPEC §7.2 item 11 — duplicate execution, and the conflict that is not a retry.
//
// The rule has two halves and they fail in opposite directions. Absorbing too
// much means a *different* document under a used id is dropped in silence: no
// prompt, no refusal, and a requester waiting forever on a decision this device
// decided not to make and never said so. Absorbing too little means an ordinary
// mediator redelivery raises a second consent prompt for something the human
// already answered — which is how a consent surface gets trained into a
// reflex.
//
// Both halves were unreachable while the record held bare ids: with nothing to
// compare, "seen this id" is the only question that can be asked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryKVStore } from "../dist/store/kv-store.js";
import { claimInboundDocument } from "../dist/inbound/dedup.js";

const DOC = {
  id: "urn:uuid:consent-1",
  type: "https://trusttasks.org/spec/task-consent/request/0.1",
  issuedAt: "2026-08-27T00:00:00Z",
  payload: { payloadDigest: "z6Mkdigest", challenge: "c-1" },
};

test("a first sighting is fresh", async () => {
  const store = new InMemoryKVStore();
  assert.equal(await claimInboundDocument(store, DOC), "fresh");
});

test("the identical document again is a duplicate, not a conflict", async () => {
  const store = new InMemoryKVStore();
  await claimInboundDocument(store, DOC);
  assert.equal(await claimInboundDocument(store, DOC), "duplicate");
});

test("member order is not identity — a reordered retry is still a retry", async () => {
  // The reason the digest is over the RFC 8785 canonicalization and not over
  // the octets as received. An intermediary that re-serializes the body has
  // not produced a new document, and calling it one would refuse the retry
  // §8.4 explicitly invites.
  const store = new InMemoryKVStore();
  await claimInboundDocument(store, DOC);
  const reordered = {
    payload: { challenge: "c-1", payloadDigest: "z6Mkdigest" },
    issuedAt: DOC.issuedAt,
    type: DOC.type,
    id: DOC.id,
  };
  assert.equal(await claimInboundDocument(store, reordered), "duplicate");
});

test("a DIFFERENT document under the same id is a conflict", async () => {
  // The half that did not exist. `payloadDigest` is what the human is shown a
  // match code for, so this is the substitution that matters: same id, and the
  // effects being approved are not the ones already recorded against it.
  const store = new InMemoryKVStore();
  await claimInboundDocument(store, DOC);
  const swapped = { ...DOC, payload: { ...DOC.payload, payloadDigest: "z6Mkother" } };
  assert.equal(await claimInboundDocument(store, swapped), "conflict");
});

test("distinct ids do not interfere", async () => {
  const store = new InMemoryKVStore();
  await claimInboundDocument(store, DOC);
  assert.equal(
    await claimInboundDocument(store, { ...DOC, id: "urn:uuid:consent-2" }),
    "fresh",
  );
});

test("a document with no usable id is handled rather than swallowed", async () => {
  // There is nothing to key on. Refusing would drop a real request on the
  // floor for a defect the parse step reports properly.
  const store = new InMemoryKVStore();
  assert.equal(await claimInboundDocument(store, { type: DOC.type }), "fresh");
  assert.equal(await claimInboundDocument(store, { id: "", type: DOC.type }), "fresh");
  assert.equal(await claimInboundDocument(store, { id: 7 }), "fresh");
  assert.equal(await claimInboundDocument(store, null), "fresh");
});

test("the record survives the store round-trip that a worker respawn is", async () => {
  // The whole reason this is in a KVStore and not a Map: MV3 tears the worker
  // down between the message arriving and the human answering.
  const store = new InMemoryKVStore();
  await claimInboundDocument(store, DOC);
  const revived = new InMemoryKVStore();
  for (const key of await store.keys()) await revived.put(key, await store.get(key));
  assert.equal(await claimInboundDocument(revived, DOC), "duplicate");
});
