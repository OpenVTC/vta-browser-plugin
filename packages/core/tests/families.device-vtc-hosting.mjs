// The families added in the final sweep: device enrolment, the auth tasks,
// push wake, VTC membership, and DID hosting.
//
// Each test here pins something a caller could reasonably get wrong and would
// only discover in production: a status that means "stop retrying", a
// queue that must be drained or a wipe never lands, a consent whose absence is
// not a refusal, and a one-way report that must not be awaited.

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerDevice, deviceHeartbeat, pushWake } from "../dist/device/index.js";
import { requestAuthChallenge, refreshAuthSession } from "../dist/vta/index.js";
import { submitJoinRequest, joinRequestStatus, selfRemoveFromCommunity } from "../dist/vtc/index.js";
import {
  registerHostedDid,
  listHostedDids,
  rollbackHostedDid,
  reportHostedDidProblem,
  purgeDomain,
} from "../dist/did-hosting/index.js";

const HOLDER = { did: "did:key:zHolder" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(reply);
    },
    notify(envelope, opts) {
      sent.push({ envelope, opts, oneWay: true });
      return Promise.resolve();
    },
  };
}

// ── device ──────────────────────────────────────────────────────────────────

test("register targets 0.2 and returns the binding the agent now holds", async () => {
  const binding = { deviceId: "d1", consumerDid: HOLDER.did, consumerKind: { kind: "companion", formFactor: "browser" }, displayName: "Glenn's laptop", registeredAt: "2026-08-18T00:00:00Z" };
  const channel = recorder({ binding });
  const result = await registerDevice(channel, {
    holder: HOLDER,
    service: SERVICE,
    consumerKind: { kind: "companion", formFactor: "browser" },
    displayName: "Glenn's laptop",
  });
  assert.equal(channel.sent[0].envelope.type, "https://trusttasks.org/spec/device/register/0.2");
  assert.deepEqual(result, binding);
});

test("a heartbeat carries queued work — including a pending wipe", async () => {
  // This is how a remote wipe actually reaches a device. A client that treats a
  // heartbeat as a liveness ping and drops the array is a client that cannot be
  // wiped.
  const channel = recorder({
    serverTime: "2026-08-18T00:00:00Z",
    queuedOperations: [{ kind: "wipe", task: { scope: "full" } }],
    syncHint: "syncDue",
  });
  const result = await deviceHeartbeat(channel, { holder: HOLDER, service: SERVICE, vaultSeq: 0 });
  assert.deepEqual(channel.sent[0].envelope.payload, { vaultSeq: 0 });
  assert.equal(result.queuedOperations[0].kind, "wipe");
  assert.equal(result.syncHint, "syncDue");
});

test("a heartbeat with nothing queued still yields an array", async () => {
  const channel = recorder({ serverTime: "2026-08-18T00:00:00Z" });
  const result = await deviceHeartbeat(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(result.queuedOperations, []);
});

test("push wake reports a dead handle distinctly from a failure", async () => {
  // `tokenUnregistered` means the subscription is gone: re-register, do not
  // retry, or you retry forever against a device that can never answer.
  const channel = recorder({ status: "tokenUnregistered" });
  const result = await pushWake(channel, {
    holder: HOLDER,
    service: SERVICE,
    handle: "wh_123",
    urgency: "background",
  });
  assert.equal(channel.sent[0].envelope.payload.v, 1);
  assert.equal(result.status, "tokenUnregistered");
});

// ── auth tasks ──────────────────────────────────────────────────────────────

test("a challenge request sends an empty payload when nothing is narrowed", async () => {
  const channel = recorder({ challenge: "c", sessionId: "s", expiresAt: "2099-01-01T00:00:00Z" });
  await requestAuthChallenge(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
});

test("refresh carries the token, and the response may rotate it", async () => {
  // A rotated refresh token spends the old one. A caller that keeps the old is
  // logged out at the next refresh, which is the worst time to find out.
  const channel = recorder({
    tokens: { accessToken: "a2", refreshToken: "r2", tokenType: "Bearer", expiresIn: 900 },
  });
  const result = await refreshAuthSession(channel, {
    holder: HOLDER,
    service: SERVICE,
    refreshToken: "r1",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { refreshToken: "r1" });
  assert.equal(result.tokens.refreshToken, "r2");
});

// ── VTC membership ──────────────────────────────────────────────────────────

test("registryConsent:false is sent — absence is not a refusal", async () => {
  // This decides whether a membership is published. Dropping an explicit false
  // would leave the community to decide by default.
  const channel = recorder({ requestId: "jr1", status: "pending" });
  await submitJoinRequest(channel, {
    holder: HOLDER,
    service: SERVICE,
    vp: {},
    registryConsent: false,
  });
  assert.equal(channel.sent[0].envelope.payload.registryConsent, false);
});

test("a deferred application carries what it still needs", async () => {
  // The community is asking, not refusing. Reporting a bare "pending" leaves an
  // applicant waiting on a decision that is waiting on them.
  const channel = recorder({
    requestId: "jr1",
    status: "deferred",
    needs: ["proof of personhood"],
    presentationDefinition: {},
  });
  const result = await joinRequestStatus(channel, {
    holder: HOLDER,
    service: SERVICE,
    requestId: "jr1",
  });
  assert.deepEqual(result.needs, ["proof of personhood"]);
});

test("leaving states its disposition rather than accepting a default", async () => {
  const channel = recorder({ did: HOLDER.did, disposition: "tombstone", removed: true });
  await selfRemoveFromCommunity(channel, {
    holder: HOLDER,
    service: SERVICE,
    disposition: "tombstone",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { disposition: "tombstone" });
});

// ── DID hosting ─────────────────────────────────────────────────────────────

test("registering a hosted DID does not force by default", async () => {
  // `force` overwrites a registration at that path, and the path is somebody's
  // identity — so it is absent unless asked for.
  const record = { mnemonic: "m1", owner: HOLDER.did, createdAt: "", updatedAt: "", versionCount: 1 };
  const channel = recorder({ record });
  await registerHostedDid(channel, {
    holder: HOLDER,
    service: SERVICE,
    path: "alice",
    method: "webvh",
    didData: {},
  });
  assert.ok(!("force" in channel.sent[0].envelope.payload));
  assert.deepEqual(channel.sent[0].envelope.payload, { path: "alice", method: "webvh", didData: {} });
});

test("list reports the total, not just the page", async () => {
  const channel = recorder({ records: [], total: 42 });
  const result = await listHostedDids(channel, { holder: HOLDER, service: SERVICE, limit: 10 });
  assert.equal(result.total, 42);
  assert.deepEqual(result.records, []);
});

test("a rollback says how many versions it destroyed", async () => {
  // Anyone who already resolved a later version has seen a document that no
  // longer exists — this is a fork, not an undo.
  const channel = recorder({ record: {}, removedVersions: 3 });
  const result = await rollbackHostedDid(channel, {
    holder: HOLDER,
    service: SERVICE,
    mnemonic: "m1",
    targetVersion: 2,
  });
  assert.equal(result.removedVersions, 3);
});

test("a problem report is one-way — delivered, never answered", async () => {
  const channel = recorder(undefined);
  await reportHostedDidProblem(channel, {
    holder: HOLDER,
    service: SERVICE,
    mnemonic: "m1",
    code: "e.resolve.failed",
    message: "log served a bad entry",
  });
  const sent = channel.sent[0];
  assert.equal(sent.oneWay, true, "must go via notify, not send");
  assert.equal(sent.envelope.type, "https://trusttasks.org/spec/did-management/did/problem-report/0.1");
});

test("purging a domain surfaces the per-instance fanout", async () => {
  // A partial fanout means some server is still serving what was just erased.
  const channel = recorder({
    name: "example.com",
    purgedAt: "2026-08-18T00:00:00Z",
    fanout: [{ instanceId: "i1", ok: true }],
  });
  const result = await purgeDomain(channel, {
    holder: HOLDER,
    service: SERVICE,
    name: "example.com",
    purgeServers: true,
  });
  assert.equal(channel.sent[0].envelope.payload.purgeServers, true);
  assert.equal(result.fanout.length, 1);
});
