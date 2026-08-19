// `vta/contexts/{get,update,update-did}`.
//
// Two things here are easy to get wrong and expensive when wrong.
//
// `get` exists because `list` cannot answer "does this exist?" — list filters
// to what the caller may reach, so an empty result and a non-existent id look
// identical. Only `get` distinguishes them, by answering notFound.
//
// `update` sends the policy WHOLE. The agent stores what it is given rather
// than merging, so a partial policy silently drops the constraints it omits —
// which for a policy object means quietly widening what a context may do.

import { test } from "node:test";
import assert from "node:assert/strict";

import { contextsGet, contextsUpdate, contextsUpdateDid } from "../dist/vta/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };
const CALL = { holder: HOLDER, service: SERVICE };

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(reply);
    },
  };
}

test("get asks for one id and expects the get response type", async () => {
  const ch = recorder({ id: "personal", name: "Personal" });
  const rec = await contextsGet(ch, { ...CALL, id: "personal" });

  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/contexts/get/1.0");
  assert.deepEqual(envelope.payload, { id: "personal" });
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/contexts/get/1.0#response",
  );
  assert.equal(rec.id, "personal");
});

test("get folds a legacy snake_case record, as list does", async () => {
  // An agent that predates the camelCase fold still answers snake_case; the
  // extension reads `contextId` at runtime, so the fold has to happen here.
  const ch = recorder({ id: "personal", name: "Personal", context_policy: { signable_keys: [] } });
  const rec = await contextsGet(ch, { ...CALL, id: "personal" });
  assert.ok(rec, "a legacy record must still decode");
  assert.equal(rec.id, "personal");
});

test("update omits fields the caller did not set", async () => {
  const ch = recorder({ id: "personal", name: "Renamed" });
  await contextsUpdate(ch, { ...CALL, id: "personal", name: "Renamed" });

  const { payload } = ch.sent[0].envelope;
  assert.deepEqual(payload, { id: "personal", name: "Renamed" });
  assert.ok(!("description" in payload), "an unset description must not be sent");
  assert.ok(!("policy" in payload), "an unset policy must not be sent — it would replace, not merge");
});

test("update sends an explicitly empty description, which is a real change", async () => {
  const ch = recorder({ id: "personal" });
  await contextsUpdate(ch, { ...CALL, id: "personal", description: "" });
  assert.equal(ch.sent[0].envelope.payload.description, "");
});

test("update sends the policy object through untouched", async () => {
  const policy = { trustedVerifiers: ["did:web:verifier.example"], signableKeys: ["k1"] };
  const ch = recorder({ id: "personal" });
  await contextsUpdate(ch, { ...CALL, id: "personal", policy });
  assert.deepEqual(ch.sent[0].envelope.payload.policy, policy);
});

test("update-did is its own task, not update with a did field", async () => {
  const ch = recorder({ id: "personal", did: "did:webvh:QmA:h.example" });
  await contextsUpdateDid(ch, { ...CALL, id: "personal", did: "did:webvh:QmA:h.example" });

  const { envelope } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/contexts/update-did/1.0");
  assert.deepEqual(envelope.payload, { id: "personal", did: "did:webvh:QmA:h.example" });
});
