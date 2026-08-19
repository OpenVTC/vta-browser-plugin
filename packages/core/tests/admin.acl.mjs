// The `acl/*` request bodies, checked against the shapes the agent will accept.
//
// These bodies are `deny_unknown_fields` on the Rust side, so a field this
// library invents or misspells is a rejected request, not a tolerated one — and
// the failure surfaces at an operator's console, mid-grant. The tests capture
// the envelope a call would send and assert its exact shape.
//
// The `allowedKeys` cases are the ones that matter most: absent and `[]` are
// opposite grants (every key the entry's scopes reach, versus no keys at all),
// so a helpful-looking "drop the empty array" would turn the narrowest grant
// into the widest.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aclGrant,
  aclList,
  aclShow,
  aclRevoke,
  aclChangeRole,
} from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

/** Captures the envelope instead of sending it, and replies with `reply`. */
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

test("grant sends the entry nested, under the canonical type", async () => {
  const entry = { subject: "did:key:zSubject", role: "admin", scopes: ["demo"] };
  const channel = recorder({ entry });

  const result = await aclGrant(channel, { holder: HOLDER, service: SERVICE, entry });

  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/acl/grant/0.1");
  assert.equal(envelope.issuer, HOLDER.did);
  assert.equal(envelope.recipient, SERVICE.did);
  assert.deepEqual(envelope.payload, { entry });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/acl/grant/0.1#response");
  assert.deepEqual(result, entry);
});

test("grant omits reason entirely when there isn't one", async () => {
  // Not `reason: undefined` — `deny_unknown_fields` tolerates an absent key,
  // and a null would be a type error against `Option<String>`.
  const channel = recorder({ entry: {} });
  await aclGrant(channel, {
    holder: HOLDER,
    service: SERVICE,
    entry: { subject: "did:key:zS", role: "admin" },
  });
  assert.ok(!("reason" in channel.sent[0].envelope.payload));
});

test("an empty allowedKeys survives as [] — the narrowest grant, not the widest", async () => {
  const entry = { subject: "did:key:zS", role: "signer", allowedKeys: [] };
  const channel = recorder({ entry });
  await aclGrant(channel, { holder: HOLDER, service: SERVICE, entry });
  assert.deepEqual(channel.sent[0].envelope.payload.entry.allowedKeys, []);
});

test("an absent allowedKeys stays absent — it means every key in scope", async () => {
  const entry = { subject: "did:key:zS", role: "signer" };
  const channel = recorder({ entry });
  await aclGrant(channel, { holder: HOLDER, service: SERVICE, entry });
  assert.ok(!("allowedKeys" in channel.sent[0].envelope.payload.entry));
});

test("list sends only the filters that were set, in camelCase", async () => {
  const channel = recorder({ entries: [], truncated: false });
  await aclList(channel, {
    holder: HOLDER,
    service: SERVICE,
    role: "admin",
    subjectPrefix: "did:key:",
    pageSize: 50,
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    role: "admin",
    subjectPrefix: "did:key:",
    pageSize: 50,
  });
});

test("list with no filters sends an empty payload, not a bag of undefineds", async () => {
  const channel = recorder({ entries: [], truncated: false });
  await aclList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
});

test("pageSize 0 is a filter, not an absence", async () => {
  // `if (params.pageSize)` would drop it; the guard is on `!== undefined`.
  const channel = recorder({ entries: [], truncated: false });
  await aclList(channel, { holder: HOLDER, service: SERVICE, pageSize: 0 });
  assert.deepEqual(channel.sent[0].envelope.payload, { pageSize: 0 });
});

test("list defaults the response fields the agent may omit", async () => {
  const channel = recorder({});
  const result = await aclList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(result, { entries: [], truncated: false, redactedFields: [] });
});

test("list carries a cursor back when the agent paged", async () => {
  const channel = recorder({ entries: [{ subject: "a", role: "admin" }], truncated: true, cursor: "c1" });
  const result = await aclList(channel, { holder: HOLDER, service: SERVICE });
  assert.equal(result.truncated, true);
  assert.equal(result.cursor, "c1");
});

test("show reports null for a subject that is not in the ACL", async () => {
  // The specification is explicit that `entry` is nullable here — "not in the
  // ACL" is a successful answer. The hand-written version typed it as always
  // present, which the generated type caught.
  const channel = recorder({ entry: null });
  const result = await aclShow(channel, { holder: HOLDER, service: SERVICE, subject: "did:key:zNope" });
  assert.equal(result.entry, null);
  assert.deepEqual(result.redactedFields, []);
});

test("show reports redacted fields rather than hiding them", async () => {
  const channel = recorder({ entry: { subject: "did:key:zS", role: "admin" }, redactedFields: ["label"] });
  const result = await aclShow(channel, { holder: HOLDER, service: SERVICE, subject: "did:key:zS" });
  assert.deepEqual(result.redactedFields, ["label"]);
  assert.deepEqual(channel.sent[0].envelope.payload, { subject: "did:key:zS" });
});

test("show defaults redactedFields to empty when the agent withheld nothing", async () => {
  const channel = recorder({ entry: { subject: "did:key:zS", role: "admin" } });
  const result = await aclShow(channel, { holder: HOLDER, service: SERVICE, subject: "did:key:zS" });
  assert.deepEqual(result.redactedFields, []);
});

test("revoke without scopes removes the entry; with scopes it narrows", async () => {
  const whole = recorder({ entry: {} });
  await aclRevoke(whole, { holder: HOLDER, service: SERVICE, subject: "did:key:zS" });
  assert.deepEqual(whole.sent[0].envelope.payload, { subject: "did:key:zS" });

  const narrow = recorder({ entry: {} });
  await aclRevoke(narrow, {
    holder: HOLDER,
    service: SERVICE,
    subject: "did:key:zS",
    scopes: ["demo"],
    reason: "sweep",
  });
  assert.deepEqual(narrow.sent[0].envelope.payload, {
    subject: "did:key:zS",
    scopes: ["demo"],
    reason: "sweep",
  });
});

test("revoke narrows with the scopes given, and they are sent verbatim", async () => {
  // An *empty* scopes list is not expressible: the schema says `minItems: 1`,
  // and the parameter type is a non-empty tuple, so "revoke nothing" cannot be
  // confused with "revoke everything" (which is what omitting scopes means).
  // The hand-written version of this module accepted `[]`, and an earlier
  // version of this test asserted it was sent.
  const channel = recorder({ entry: {} });
  await aclRevoke(channel, {
    holder: HOLDER,
    service: SERVICE,
    subject: "did:key:zS",
    scopes: ["demo", "staging"],
  });
  assert.deepEqual(channel.sent[0].envelope.payload.scopes, ["demo", "staging"]);
});

test("change-role sends both roles, so the agent can compare-and-swap", async () => {
  const channel = recorder({ entry: {} });
  await aclChangeRole(channel, {
    holder: HOLDER,
    service: SERVICE,
    subject: "did:key:zS",
    fromRole: "admin",
    toRole: "auditor",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    subject: "did:key:zS",
    fromRole: "admin",
    toRole: "auditor",
  });
});

test("a channel error propagates — these calls do not swallow refusals", async () => {
  const failing = {
    send() {
      return Promise.reject(new Error("e.acl.forbidden: caller cannot manage ACL entries"));
    },
  };
  await assert.rejects(
    () => aclGrant(failing, { holder: HOLDER, service: SERVICE, entry: { subject: "x", role: "admin" } }),
    /e\.acl\.forbidden/,
  );
});
