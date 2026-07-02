import { test } from "node:test";
import assert from "node:assert/strict";

import {
  vaultList,
  vaultDelete,
  vaultSignTrustTask,
  vtaListDids,
  setDeviceWake,
  contextsList,
  contextsCreate,
  VtaSession,
} from "../dist/index.js";

/** A TrustTaskChannel that records the envelope + opts and returns a canned
 *  payload — lets us assert an op builds the right Trust-Task and routes it
 *  over whatever channel it's handed, with no transport at all. */
function captureChannel(payload) {
  const sent = [];
  return {
    kind: "didcomm",
    sent,
    async send(envelope, opts) {
      sent.push({ envelope, opts });
      return payload;
    },
  };
}

const holder = { did: "did:example:holder" };
const service = { did: "did:example:vta", keyAgreementKid: "did:example:vta#ka", keyAgreementPublicJwk: {} };

test("vaultList builds vault/list/0.2 with issuer+recipient and maps the reply", async () => {
  const ch = captureChannel({ entries: [{ id: "e1" }], truncated: true, cursor: "c2" });
  const res = await vaultList(ch, { holder, service, filter: { contextId: "work" } });

  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vault/list/0.2");
  assert.equal(envelope.issuer, "did:example:holder");
  assert.equal(envelope.recipient, "did:example:vta");
  assert.deepEqual(envelope.payload, { contextId: "work" });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vault/list/0.2#response");
  assert.ok(typeof envelope.id === "string" && envelope.id.length > 0);
  assert.ok(typeof envelope.issuedAt === "string");

  assert.deepEqual(res, { entries: [{ id: "e1" }], truncated: true, cursor: "c2" });
});

test("vaultList defaults filter to {} and truncated to false", async () => {
  const ch = captureChannel({ entries: [] });
  const res = await vaultList(ch, { holder, service });
  assert.deepEqual(ch.sent[0].envelope.payload, {});
  assert.deepEqual(res, { entries: [], truncated: false });
});

test("vaultDelete carries id + optimistic-concurrency token", async () => {
  const ch = captureChannel({ id: "x", deletedAt: "t", graceUntil: "t" });
  await vaultDelete(ch, { holder, service, id: "x", expectedVersion: 4, reason: "rotated" });
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vault/delete/0.1");
  assert.deepEqual(envelope.payload, { id: "x", expectedVersion: 4, reason: "rotated" });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vault/delete/0.1#response");
});

test("vaultSignTrustTask forwards the unsigned envelope and returns signedEnvelope", async () => {
  const unsignedEnvelope = { id: "u", type: "t", issuer: "did:example:persona", payload: {} };
  const signedEnvelope = { ...unsignedEnvelope, proof: { cryptosuite: "eddsa-jcs-2022" } };
  const ch = captureChannel({ signedEnvelope });
  const res = await vaultSignTrustTask(ch, { holder, service, entryId: "e9", unsignedEnvelope });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vault/sign-trust-task/0.2");
  assert.deepEqual(ch.sent[0].envelope.payload, { entryId: "e9", unsignedEnvelope });
  assert.deepEqual(res, { signedEnvelope });
});

test("vtaListDids scopes by context and unwraps dids[]", async () => {
  const ch = captureChannel({ dids: [{ did: "did:webvh:a", context_id: "work" }] });
  const res = await vtaListDids(ch, { holder, service, contextId: "work" });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vta/webvh/dids/list/1.0");
  assert.deepEqual(ch.sent[0].envelope.payload, { context_id: "work" });
  assert.deepEqual(res, [{ did: "did:webvh:a", context_id: "work" }]);
});

test("contextsList sends contexts/list/1.0 with empty payload and unwraps contexts[]", async () => {
  const ch = captureChannel({ contexts: [{ id: "work", name: "Work" }] });
  const res = await contextsList(ch, { holder, service });
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/contexts/list/1.0");
  assert.deepEqual(envelope.payload, {});
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vta/contexts/list/1.0#response");
  assert.deepEqual(res, [{ id: "work", name: "Work" }]);
});

test("contextsCreate defaults name to id and forwards description/parent", async () => {
  const record = { id: "team", name: "Team", did: null, description: "d", base_path: "/team", created_at: "t", updated_at: "t" };
  const ch = captureChannel(record);
  const res = await contextsCreate(ch, { holder, service, id: "team", description: "d", parent: "org" });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vta/contexts/create/1.0");
  assert.deepEqual(ch.sent[0].envelope.payload, { id: "team", name: "team", description: "d", parent: "org" });
  assert.deepEqual(res, record);
});

test("ops accept a VtaSession (not just a raw channel) and route through it", async () => {
  // The whole point of TrustTaskSender: hand an op a multi-channel session and
  // it works. Here the primary (didcomm) channel routes the vault/list.
  const didcomm = captureChannel({ entries: [{ id: "via-session" }] });
  const session = new VtaSession([didcomm]);
  const res = await vaultList(session, { holder, service });
  assert.equal(didcomm.sent[0].envelope.type, "https://trusttasks.org/spec/vault/list/0.2");
  assert.deepEqual(res.entries, [{ id: "via-session" }]);
});

test("setDeviceWake sets the handle; omitting it clears", async () => {
  const ch = captureChannel({ pushCapable: true });
  await setDeviceWake(ch, { holder, service, wakeHandle: { gateway: "g", handle: "h" } });
  assert.deepEqual(ch.sent[0].envelope.payload, { wakeHandle: { gateway: "g", handle: "h" } });

  const ch2 = captureChannel({ pushCapable: false });
  await setDeviceWake(ch2, { holder, service });
  assert.deepEqual(ch2.sent[0].envelope.payload, {}); // clear
});
