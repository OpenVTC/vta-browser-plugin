// The webvh surface — `vta/webvh/*`.
//
// These are thin senders, so what is worth testing is the two things a thin
// sender can still get wrong: the envelope it builds (type, payload, expected
// response type, and who it is addressed to) and whether an optional field that
// was not supplied is omitted rather than sent as `undefined`/`null`. A payload
// carrying an explicit null is not the same request as one omitting the key —
// `serverId` absent means *serverless*, which is a different DID.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  webvhDidCreate,
  webvhDidGet,
  webvhDidList,
  webvhDidDelete,
  webvhServerList,
  webvhServerReconcile,
  agentNameSet,
  agentNameCheck,
  agentNameDisable,
} from "../dist/webvh/index.js";

const HOLDER = { did: "did:key:zHolder" };
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

test("create addresses the agent and carries the canonical type", async () => {
  const ch = recorder({ record: { did: "did:webvh:QmNew:host.example" } });
  await webvhDidCreate(ch, { ...CALL, contextId: "personal", serverId: "prod" });

  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/webvh/dids/create/1.0");
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/webvh/dids/create/1.0#response",
  );
  // The agent holds the keys, so it is the recipient — not the hosting server.
  assert.equal(envelope.issuer, HOLDER.did);
  assert.equal(envelope.recipient, SERVICE.did);
  assert.deepEqual(envelope.payload, { contextId: "personal", serverId: "prod" });
});

test("an omitted serverId is absent, not null — absence means serverless", async () => {
  const ch = recorder({ record: {} });
  await webvhDidCreate(ch, { ...CALL, contextId: "personal", url: "https://example.com/alice" });

  const { payload } = ch.sent[0].envelope;
  assert.ok(!("serverId" in payload), `serverId must be omitted, got ${JSON.stringify(payload)}`);
  assert.deepEqual(payload, { contextId: "personal", url: "https://example.com/alice" });
});

test("portable:false is sent, because false is a decision and absent is not", async () => {
  const ch = recorder({ record: {} });
  await webvhDidCreate(ch, { ...CALL, contextId: "c", portable: false });
  assert.equal(ch.sent[0].envelope.payload.portable, false);
});

test("get only asks for the log when told to", async () => {
  const ch = recorder({ record: {} });
  await webvhDidGet(ch, { ...CALL, did: "did:webvh:QmA:h.example" });
  assert.ok(!("includeLog" in ch.sent[0].envelope.payload));

  const ch2 = recorder({ record: {}, log: "…" });
  await webvhDidGet(ch2, { ...CALL, did: "did:webvh:QmA:h.example", includeLog: true });
  assert.equal(ch2.sent[0].envelope.payload.includeLog, true);
});

test("list with no filters sends an empty payload, not nulls", async () => {
  const ch = recorder({ dids: [] });
  await webvhDidList(ch, CALL);
  assert.deepEqual(ch.sent[0].envelope.payload, {});
});

test("list passes both filters through", async () => {
  const ch = recorder({ dids: [] });
  await webvhDidList(ch, { ...CALL, contextId: "personal", serverId: "prod" });
  assert.deepEqual(ch.sent[0].envelope.payload, { contextId: "personal", serverId: "prod" });
});

test("delete names the right task", async () => {
  const ch = recorder({ did: "did:webvh:QmA:h.example", deleted: true });
  await webvhDidDelete(ch, { ...CALL, did: "did:webvh:QmA:h.example" });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vta/webvh/dids/delete/1.0");
});

test("server list sends an empty payload", async () => {
  const ch = recorder({ servers: [] });
  await webvhServerList(ch, CALL);
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/vta/webvh/servers/list/1.0");
  assert.deepEqual(ch.sent[0].envelope.payload, {});
});

test("reconcile is a 0.1 family, not 1.0 — the version is part of the contract", async () => {
  const ch = recorder({ onlyOnServer: [], onlyOnAgent: [] });
  await webvhServerReconcile(ch, { ...CALL, serverId: "prod" });
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/webvh/servers/reconcile/0.1");
  assert.equal(
    opts.expectedResponseType,
    "https://trusttasks.org/spec/vta/webvh/servers/reconcile/0.1#response",
  );
});

test("agent-name set carries the binding to the agent that must sign it", async () => {
  const ch = recorder({ name: "alice", domain: "example.com" });
  await agentNameSet(ch, { ...CALL, did: "did:webvh:QmA:h.example", name: "alice", domain: "example.com" });
  const { envelope } = ch.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/webvh/agent-name/set/1.0");
  // Only the agent can sign the alsoKnownAs claim, so the host is never the
  // recipient here.
  assert.equal(envelope.recipient, SERVICE.did);
  assert.equal(envelope.payload.name, "alice");
});

test("check and disable are distinct tasks, not one with a flag", async () => {
  const a = recorder({ available: true });
  await agentNameCheck(a, { ...CALL, name: "alice", domain: "example.com" });
  assert.equal(a.sent[0].envelope.type, "https://trusttasks.org/spec/vta/webvh/agent-name/check/1.0");

  const b = recorder({ disabled: true });
  await agentNameDisable(b, { ...CALL, name: "alice", domain: "example.com" });
  assert.equal(b.sent[0].envelope.type, "https://trusttasks.org/spec/vta/webvh/agent-name/disable/1.0");
});
