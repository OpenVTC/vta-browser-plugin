// `consent/*` — messaging consent, and the approver bindings behind it.
//
// The distinction these tests protect is between a *recorded deny* and a
// *refused recording*. Both are non-approvals; only one means the counterparty
// is blocked. A console that renders them the same tells its user the opposite
// of what happened in one of the two cases.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consentList,
  consentDecision,
  consentRevoke,
  consentRequest,
  consentApproverList,
  consentApproverSet,
  agentPing,
} from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

const SUBJECT = {
  platform: "matrix",
  conversationRef: "!room:example.org",
  kind: "dm",
  agent: "did:key:zCounterparty",
};

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

test("list sends only the filters given, under the 1.0 type", async () => {
  const channel = recorder({ grants: [] });
  await consentList(channel, { holder: HOLDER, service: SERVICE, platform: "matrix" });
  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/consent/list/1.0");
  assert.deepEqual(envelope.payload, { platform: "matrix" });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/consent/list/1.0#response");
});

test("a subject filter travels whole — all four members identify it", async () => {
  const channel = recorder({ grants: [] });
  await consentList(channel, { holder: HOLDER, service: SERVICE, subject: SUBJECT });
  assert.deepEqual(channel.sent[0].envelope.payload.subject, SUBJECT);
});

test("list surfaces deny grants rather than treating them as absences", async () => {
  // A recorded deny is a decision. Dropping it would make a blocked
  // counterparty indistinguishable from one nobody has ruled on.
  const grants = [
    { subject: SUBJECT, effect: "deny", grantedBy: HOLDER.did, grantedAt: "2026-08-18T00:00:00Z" },
  ];
  const channel = recorder({ grants });
  const result = await consentList(channel, { holder: HOLDER, service: SERVICE });
  assert.equal(result.grants[0].effect, "deny");
});

test("decision sends the challenge that binds it to a request", async () => {
  const channel = recorder({ status: "recorded", grantId: "g1" });
  await consentDecision(channel, {
    holder: HOLDER,
    service: SERVICE,
    subject: SUBJECT,
    effect: "allow",
    scope: "converse",
    challenge: "chal-1",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    subject: SUBJECT,
    effect: "allow",
    scope: "converse",
    challenge: "chal-1",
  });
});

test("a rejected decision is not a recorded deny", async () => {
  // `status: "rejected"` means the agent would not record the decision at all
  // — a stale challenge, say. Reporting it as "blocked" would be wrong in the
  // most consequential direction.
  const channel = recorder({ status: "rejected", reason: "challenge expired" });
  const result = await consentDecision(channel, {
    holder: HOLDER,
    service: SERVICE,
    subject: SUBJECT,
    effect: "deny",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "challenge expired");
});

test("revoke reports notFound for a subject with no grant", async () => {
  const channel = recorder({ status: "notFound" });
  const result = await consentRevoke(channel, {
    holder: HOLDER,
    service: SERVICE,
    subject: SUBJECT,
  });
  assert.equal(result.status, "notFound");
  assert.deepEqual(channel.sent[0].envelope.payload, { subject: SUBJECT });
});

test("request carries the challenge and the scope it is asking for", async () => {
  const channel = recorder({ status: "accepted", requestId: "r1" });
  await consentRequest(channel, {
    holder: HOLDER,
    service: SERVICE,
    subject: SUBJECT,
    scope: "receive",
    challenge: "chal-2",
    displayHint: "Alice from Example Corp",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    subject: SUBJECT,
    scope: "receive",
    challenge: "chal-2",
    displayHint: "Alice from Example Corp",
  });
});

test("approver list and set carry the platform/context pair", async () => {
  const binding = {
    platform: "matrix",
    context: "personal",
    approver: "did:key:zApprover",
    route: "wake",
  };
  const list = recorder({ approvers: [binding] });
  assert.deepEqual(
    await consentApproverList(list, { holder: HOLDER, service: SERVICE, platform: "matrix" }),
    [binding],
  );

  const set = recorder({ ok: true });
  await consentApproverSet(set, {
    holder: HOLDER,
    service: SERVICE,
    platform: "matrix",
    context: "personal",
    approver: "did:key:zApprover",
    route: "wake",
  });
  assert.deepEqual(set.sent[0].envelope.payload, {
    platform: "matrix",
    context: "personal",
    approver: "did:key:zApprover",
    route: "wake",
  });
});

test("approver list returns [] rather than undefined when none are bound", async () => {
  const channel = recorder({});
  assert.deepEqual(await consentApproverList(channel, { holder: HOLDER, service: SERVICE }), []);
});

test("ping reports degraded rather than flattening it into a yes", async () => {
  // An agent that answers is not necessarily an agent that is working.
  const channel = recorder({ serverTime: "2026-08-18T00:00:00Z", status: "degraded" });
  const result = await agentPing(channel, { holder: HOLDER, service: SERVICE, nonce: "n1" });
  assert.deepEqual(channel.sent[0].envelope.payload, { nonce: "n1" });
  assert.equal(result.status, "degraded");
});
