// The `acl/*` request bodies, checked against the shapes the agent will accept.
//
// These bodies are `deny_unknown_fields` on the Rust side, so a field this
// library invents or misspells is a rejected request, not a tolerated one — and
// the failure surfaces at an operator's console, mid-grant. The tests capture
// the envelope a call would send and assert its exact shape.
//
// AclEntry 0.2 states every authority axis explicitly — `act`, `keys` and
// `capabilities` have no default — so the cases that matter most are the ones
// where a helpful-looking rebuild would drop or rewrite a stated scope.

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

/** A minimal well-formed 0.2 entry: the three required scopes, stated. */
const ENTRY = (over = {}) => ({
  subject: "did:key:zSubject",
  role: "admin",
  act: { scope: "contexts", contexts: ["demo"] },
  keys: { scope: "all" },
  capabilities: { scope: "ceiling" },
  ...over,
});

test("grant sends the entry nested, under the canonical type", async () => {
  const entry = ENTRY();
  const channel = recorder({ entry });

  const result = await aclGrant(channel, { holder: HOLDER, service: SERVICE, entry });

  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/acl/grant/0.2");
  assert.equal(envelope.issuer, HOLDER.did);
  assert.equal(envelope.recipient, SERVICE.did);
  assert.deepEqual(envelope.payload, { entry });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/acl/grant/0.2#response");
  assert.deepEqual(result, entry);
});

test("grant omits reason entirely when there isn't one", async () => {
  // Not `reason: undefined` — `deny_unknown_fields` tolerates an absent key,
  // and a null would be a type error against `Option<String>`.
  const channel = recorder({ entry: {} });
  await aclGrant(channel, { holder: HOLDER, service: SERVICE, entry: ENTRY() });
  assert.ok(!("reason" in channel.sent[0].envelope.payload));
});

test("a key scope of none survives as stated — the narrowest grant, not the widest", async () => {
  const entry = ENTRY({ keys: { scope: "none" } });
  const channel = recorder({ entry });
  await aclGrant(channel, { holder: HOLDER, service: SERVICE, entry });
  assert.deepEqual(channel.sent[0].envelope.payload.entry.keys, { scope: "none" });
});

test("list sends only the filters that were set, in camelCase", async () => {
  const channel = recorder({ entries: [] });
  await aclList(channel, {
    holder: HOLDER,
    service: SERVICE,
    role: "admin",
    subjectPrefix: "did:key:",
    limit: 50,
  });
  assert.equal(channel.sent[0].envelope.type, "https://trusttasks.org/spec/acl/list/0.3");
  assert.deepEqual(channel.sent[0].envelope.payload, {
    role: "admin",
    subjectPrefix: "did:key:",
    limit: 50,
  });
});

test("a context filter carries its direction — there is no default", async () => {
  const channel = recorder({ entries: [] });
  await aclList(channel, {
    holder: HOLDER,
    service: SERVICE,
    context: "demo",
    direction: "actingIn",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { context: "demo", direction: "actingIn" });
});

test("list with no filters sends an empty payload, not a bag of undefineds", async () => {
  const channel = recorder({ entries: [] });
  await aclList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
});

test("list defaults the response fields the agent may omit", async () => {
  const channel = recorder({});
  const result = await aclList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(result, { entries: [], redactedFields: [] });
});

test("list follows nextCursor to the end, keeping the filters on every page", async () => {
  // Only an absent `nextCursor` means the last page; a list that stopped at
  // the first would show an access pane a partial ACL that reads as complete.
  const pages = [
    { entries: [ENTRY({ subject: "a" })], nextCursor: "c1", redactedFields: ["label"] },
    { entries: [ENTRY({ subject: "b" })] },
  ];
  const sent = [];
  const channel = {
    send(envelope) {
      sent.push(envelope);
      return Promise.resolve(pages[sent.length - 1]);
    },
  };
  const result = await aclList(channel, { holder: HOLDER, service: SERVICE, role: "admin" });
  assert.deepEqual(result.entries.map((e) => e.subject), ["a", "b"]);
  assert.deepEqual(result.redactedFields, ["label"]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].payload, { role: "admin", cursor: "c1" });
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
  const channel = recorder({ entry: ENTRY({ subject: "did:key:zS" }), redactedFields: ["label"] });
  const result = await aclShow(channel, { holder: HOLDER, service: SERVICE, subject: "did:key:zS" });
  assert.deepEqual(result.redactedFields, ["label"]);
  assert.deepEqual(channel.sent[0].envelope.payload, { subject: "did:key:zS" });
});

test("show defaults redactedFields to empty when the agent withheld nothing", async () => {
  const channel = recorder({ entry: ENTRY({ subject: "did:key:zS" }) });
  const result = await aclShow(channel, { holder: HOLDER, service: SERVICE, subject: "did:key:zS" });
  assert.deepEqual(result.redactedFields, []);
});

test("revoke states what it takes away — the whole entry, or the act scope", async () => {
  const whole = recorder({ entry: null });
  await aclRevoke(whole, {
    holder: HOLDER,
    service: SERVICE,
    subject: "did:key:zS",
    revocation: { kind: "entry" },
  });
  assert.equal(whole.sent[0].envelope.type, "https://trusttasks.org/spec/acl/revoke/0.2");
  assert.deepEqual(whole.sent[0].envelope.payload, {
    subject: "did:key:zS",
    revocation: { kind: "entry" },
  });

  const narrow = recorder({ entry: {} });
  await aclRevoke(narrow, {
    holder: HOLDER,
    service: SERVICE,
    subject: "did:key:zS",
    revocation: { kind: "act", act: { scope: "contexts", contexts: ["demo"] } },
    reason: "sweep",
  });
  assert.deepEqual(narrow.sent[0].envelope.payload, {
    subject: "did:key:zS",
    revocation: { kind: "act", act: { scope: "contexts", contexts: ["demo"] } },
    reason: "sweep",
  });
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
  assert.equal(channel.sent[0].envelope.type, "https://trusttasks.org/spec/acl/change-role/0.2");
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
    () => aclGrant(failing, { holder: HOLDER, service: SERVICE, entry: ENTRY({ subject: "x" }) }),
    /e\.acl\.forbidden/,
  );
});
