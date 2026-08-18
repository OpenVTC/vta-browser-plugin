// `policy/*` and the session-introspection tasks.
//
// The policy bodies are `deny_unknown_fields`, and two of their fields are
// booleans whose absence means the opposite of what a caller intended — which
// is the specific thing these assertions are for.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  policyList,
  policyGet,
  policyUpsert,
  policyDelete,
  whoAmI,
  sessionsList,
  sessionRevoke,
} from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

const POLICY = {
  id: "approvals-default",
  name: "Default approvals",
  module: "package vta.approvals\n",
  enabled: true,
  version: 3,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-18T00:00:00Z",
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

// ── policy ──────────────────────────────────────────────────────────────────

test("upsert always sends enabled, including when it is false", async () => {
  // `enabled` is required and non-optional on the Rust side. Omitting it on a
  // falsy value would leave the agent to default — turning "disable this rule"
  // into "leave it running", which is the wrong direction for a policy engine.
  const channel = recorder({ policy: POLICY, created: false });
  await policyUpsert(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: "approvals-default",
    name: "Default approvals",
    module: "package vta.approvals\n",
    enabled: false,
  });
  assert.equal(channel.sent[0].envelope.payload.enabled, false);
});

test("upsert carries expectedVersion so a racing edit loses instead of wins", async () => {
  const channel = recorder({ policy: POLICY, created: false });
  await policyUpsert(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: "approvals-default",
    name: "Default approvals",
    module: "package vta.approvals\n",
    enabled: true,
    expectedVersion: 3,
  });
  assert.equal(channel.sent[0].envelope.payload.expectedVersion, 3);
});

test("expectedVersion 0 is a version, not an absence", async () => {
  const channel = recorder({ policy: POLICY, created: true });
  await policyUpsert(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "New",
    module: "package p\n",
    enabled: true,
    expectedVersion: 0,
  });
  assert.equal(channel.sent[0].envelope.payload.expectedVersion, 0);
});

test("upsert without an id lets the agent allocate one", async () => {
  const channel = recorder({ policy: POLICY, created: true });
  const result = await policyUpsert(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "New",
    module: "package p\n",
    enabled: true,
  });
  assert.ok(!("id" in channel.sent[0].envelope.payload));
  assert.equal(result.created, true);
});

test("upsert hands back both members of the response", async () => {
  // `{policy, created}` are both required by the schema, and both matter to a
  // caller — so the response is returned whole rather than unwrapped, and
  // `created` is passed through rather than defaulted. Defaulting it would
  // paper over a non-conformant agent.
  const channel = recorder({ policy: POLICY, created: false });
  const result = await policyUpsert(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "x",
    module: "package p\n",
    enabled: true,
  });
  assert.deepEqual(result, { policy: POLICY, created: false });
});

test("ext is forwarded whole — the agent cross-checks it against the module", async () => {
  const ext = { rules: [{ when: "always", require: "approval" }] };
  const channel = recorder({ policy: POLICY, created: false });
  await policyUpsert(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "x",
    module: "package p\n",
    enabled: true,
    ext,
  });
  assert.deepEqual(channel.sent[0].envelope.payload.ext, ext);
});

test("enabledOnly:false is sent rather than dropped", async () => {
  const channel = recorder({ policies: [POLICY], truncated: false });
  await policyList(channel, { holder: HOLDER, service: SERVICE, enabledOnly: false });
  assert.deepEqual(channel.sent[0].envelope.payload, { enabledOnly: false });
});

test("list defaults what the agent may omit", async () => {
  const channel = recorder({});
  const result = await policyList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(result, { policies: [], truncated: false });
});

test("get unwraps the row and names the canonical type", async () => {
  const channel = recorder({ policy: POLICY });
  const result = await policyGet(channel, { holder: HOLDER, service: SERVICE, id: POLICY.id });
  assert.equal(channel.sent[0].envelope.type, "https://trusttasks.org/spec/policy/get/0.1");
  // Single-member envelope, so the row itself comes back.
  assert.deepEqual(result, POLICY);
});

test("delete forwards the concurrency guard and the reason", async () => {
  const channel = recorder({ id: POLICY.id, deletedAt: "2026-08-18T00:03:00Z" });
  await policyDelete(channel, {
    holder: HOLDER,
    service: SERVICE,
    id: POLICY.id,
    expectedVersion: 3,
    reason: "superseded",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    id: POLICY.id,
    expectedVersion: 3,
    reason: "superseded",
  });
});

// ── sessions ────────────────────────────────────────────────────────────────

test("whoami sends an empty payload and returns freshly-resolved authority", async () => {
  const session = {
    id: "sess-1",
    subject: HOLDER.did,
    issuedAt: "2026-08-18T00:00:00Z",
    expiresAt: "2026-08-18T00:15:00Z",
    amr: ["did"],
  };
  const channel = recorder({ session, roles: ["admin"], scopes: ["ctx:demo"] });
  const result = await whoAmI(channel, { holder: HOLDER, service: SERVICE });

  assert.deepEqual(channel.sent[0].envelope.payload, {});
  assert.deepEqual(result, { session, roles: ["admin"], scopes: ["ctx:demo"] });
});

test("whoami tolerates a session with no acr rather than inventing one", async () => {
  // `acr` is optional in the spec and the agent omits it when the session has
  // none — absent, never empty-string.
  const session = {
    id: "sess-1",
    subject: HOLDER.did,
    issuedAt: "2026-08-18T00:00:00Z",
    expiresAt: "2026-08-18T00:15:00Z",
    amr: ["did"],
  };
  const channel = recorder({ session });
  const result = await whoAmI(channel, { holder: HOLDER, service: SERVICE });
  assert.equal(result.session.acr, undefined);
  // `roles`/`scopes` are schema-optional, so they default rather than arriving
  // undefined at every call site.
  assert.deepEqual(result.roles, []);
  assert.deepEqual(result.scopes, []);
});

test("sessionsList returns [] rather than undefined when there are none", async () => {
  const channel = recorder({});
  assert.deepEqual(await sessionsList(channel, { holder: HOLDER, service: SERVICE }), []);
});

test("revoking an already-gone session is a no-op, not an error", async () => {
  const channel = recorder({ revokedCount: 0 });
  const result = await sessionRevoke(channel, {
    holder: HOLDER,
    service: SERVICE,
    sessionId: "sess-gone",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { sessionId: "sess-gone" });
  assert.equal(result.revokedCount, 0);
});
