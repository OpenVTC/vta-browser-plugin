// The mediator's own `messaging/*` surface, as a client sees it.
//
// These tasks go to a *mediator*, not a VTA, over the session a holder already
// has open with it. What is pinned here is what a mistake would silently get
// wrong: who the document names as its audience, which account the mediator is
// asked about, what "admin" is read from, and the purge that must never remove
// a different count from the one a human confirmed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  accountBook,
  accountHash,
  mediatorAccountGet,
  mediatorQueueStatus,
  mediatorStats,
  meetsMediatorFloor,
  monitorBatchOf,
  MonitorSequencer,
  MEDIATOR_TASK_TYPES,
  MONITOR_EVENT_TYPE,
  parseMediatorVersion,
  purgePreview,
  purgeWithPlan,
  PurgePlanStaleError,
  saturationOf,
  standingOf,
} from "../dist/mediator/index.js";
import { problemReportError } from "../dist/vta/didcomm.js";

const HOLDER = { did: "did:key:z6MkHolder" };
const MEDIATOR = { did: "did:webvh:QmMed:relay.example" };
const CALLER = { holder: HOLDER, mediator: MEDIATOR };

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send(envelope, opts) {
      sent.push({ envelope, opts });
      return Promise.resolve(typeof reply === "function" ? reply(envelope) : reply);
    },
  };
}

// ── addressing ──────────────────────────────────────────────────────────────

test("every task is addressed to the mediator, not to an agent", async () => {
  const ch = recorder({ version: "0.29.1", uptimeSeconds: 1, connections: {}, totals: {}, forwarding: {} });
  await mediatorStats(ch, CALLER);
  const { envelope, opts } = ch.sent[0];
  assert.equal(envelope.recipient, MEDIATOR.did, "the audience the proof binds is the mediator");
  assert.equal(envelope.issuer, HOLDER.did);
  assert.equal(envelope.type, "https://trusttasks.org/spec/messaging/stats/show/0.1");
  assert.equal(opts.expectedResponseType, `${envelope.type}#response`);
});

test("an account the caller does not name is its own — by hash, never by DID", async () => {
  const ch = recorder({ account: { did: "x", accountType: "standard", acl: {} } });
  await mediatorAccountGet(ch, CALLER, { includeStats: true });
  const { payload } = ch.sent[0].envelope;
  assert.equal(payload.did, createHash("sha256").update(HOLDER.did).digest("hex"));
  assert.equal(payload.includeStats, true);
  assert.ok(!("includeActivity" in payload), "an unset request member is absent, not false");
});

test("queue/status for oneself sends no `did` — the mediator reads it as self", async () => {
  const ch = recorder({ queues: {} });
  await mediatorQueueStatus(ch, CALLER, { includePeers: 5 });
  assert.deepEqual(ch.sent[0].envelope.payload, { includePeers: 5 });
});

// ── names ───────────────────────────────────────────────────────────────────

test("accountHash is the mediator's own sha256::digest — lowercase hex of the UTF-8 DID", async () => {
  const did = "did:peer:2.Vz6Mkü";
  assert.equal(await accountHash(did), createHash("sha256").update(did, "utf8").digest("hex"));
});

test("an account book maps hashes back only for DIDs the client holds", async () => {
  const book = await accountBook([HOLDER.did, MEDIATOR.did]);
  assert.equal(book.get(await accountHash(HOLDER.did)), HOLDER.did);
  assert.equal(book.size, 2);
  assert.equal(book.get("00".repeat(32)), undefined);
});

// ── standing ────────────────────────────────────────────────────────────────

test("standing is read from the mediator's record: standard is self, admin and rootAdmin are mediator-wide", () => {
  assert.deepEqual(
    [standingOf({ accountType: "standard", acl: { local: true } })].map((s) => [s.role, s.mediatorWide, s.local]),
    [["self", false, true]],
  );
  assert.equal(standingOf({ accountType: "admin", acl: {} }).mediatorWide, true);
  assert.equal(standingOf({ accountType: "rootAdmin", acl: {} }).role, "rootAdmin");
  // Absent ACL flags are false, not assumed.
  assert.equal(standingOf({ accountType: "standard", acl: {} }).selfManageList, false);
});

// ── version floor ───────────────────────────────────────────────────────────

test("one version floor: 0.28.36, pre-release suffix ignored, unreadable fails closed", () => {
  assert.deepEqual(parseMediatorVersion("0.28.36-rc.1"), [0, 28, 36]);
  assert.equal(meetsMediatorFloor("0.28.36"), true);
  assert.equal(meetsMediatorFloor("0.29.1"), true);
  assert.equal(meetsMediatorFloor("1.0.0"), true);
  assert.equal(meetsMediatorFloor("0.28.35"), false);
  assert.equal(meetsMediatorFloor("0.27.99"), false);
  assert.equal(meetsMediatorFloor("nonsense"), false);
  assert.equal(meetsMediatorFloor(undefined), false);
});

// ── purge ───────────────────────────────────────────────────────────────────

test("a purge whose queue moved since the preview removes nothing", async () => {
  let matched = 3;
  const ch = recorder((env) => ({ matched, purged: env.payload.dryRun ? 0 : matched, dryRun: env.payload.dryRun }));
  const plan = await purgePreview(ch, CALLER, { queue: "send", peer: "ab" });
  assert.equal(plan.matched, 3);
  matched = 4; // something arrived
  await assert.rejects(() => purgeWithPlan(ch, CALLER, plan), PurgePlanStaleError);
  assert.ok(
    ch.sent.every((s) => s.envelope.payload.dryRun === true),
    "only dry runs were sent",
  );
});

test("a purge whose queue did not move is carried out, dry run first", async () => {
  const ch = recorder((env) => ({ matched: 2, purged: env.payload.dryRun ? 0 : 2, dryRun: env.payload.dryRun }));
  const plan = await purgePreview(ch, CALLER, { queue: "receive" });
  const done = await purgeWithPlan(ch, CALLER, plan);
  assert.equal(done.purged, 2);
  assert.deepEqual(ch.sent.map((s) => s.envelope.payload.dryRun), [true, true, false]);
});

// ── monitor ─────────────────────────────────────────────────────────────────

const batch = (seq, events = 0, dropped = 0) => ({
  subscriptionId: "urn:uuid:s",
  seq,
  events: Array.from({ length: events }, () => ({
    at: "2026-09-23T00:00:00Z", direction: "inbound", stage: "received", channel: "websocket", protocol: "didcomm",
  })),
  dropped,
  expiresAt: "2026-09-23T01:00:00Z",
});

test("in-order batches yield events, and an empty one is a heartbeat", () => {
  const s = new MonitorSequencer();
  assert.deepEqual(s.push(batch(1, 2)).map((u) => u.kind), ["events"]);
  assert.deepEqual(s.push(batch(2)).map((u) => u.kind), ["heartbeat"]);
});

test("a skipped seq is a gap reported before the batch that revealed it; dropped is its own fact", () => {
  const s = new MonitorSequencer();
  s.push(batch(3, 1));
  const out = s.push(batch(6, 1, 4));
  assert.deepEqual(out[0], { kind: "gap", missing: 2 });
  assert.equal(out[1].dropped, 4);
});

test("a batch with events dropped but none delivered is not a heartbeat", () => {
  const s = new MonitorSequencer();
  assert.equal(s.push(batch(1, 0, 7))[0].kind, "events");
});

test("monitorBatchOf recognises a monitor document and nothing else", () => {
  assert.ok(monitorBatchOf({ type: MONITOR_EVENT_TYPE, payload: batch(1) }));
  assert.equal(monitorBatchOf({ type: `${MONITOR_EVENT_TYPE}#response`, payload: batch(1) }), undefined);
  assert.equal(monitorBatchOf({ type: MONITOR_EVENT_TYPE, payload: { seq: "1" } }), undefined);
  assert.equal(monitorBatchOf(null), undefined);
});

// ── reading a queue ─────────────────────────────────────────────────────────

test("an unlimited queue has no saturation — not zero", () => {
  assert.equal(saturationOf({ count: 5 }), undefined);
  assert.equal(saturationOf({ count: 50, limit: 200 }), 0.25);
  assert.equal(saturationOf({ count: 50, limit: 200, saturation: 0.3 }), 0.3);
});

test("the task list the bundle guard reads is the mediator's operations surface", () => {
  assert.ok(MEDIATOR_TASK_TYPES.every((t) => t.startsWith("https://trusttasks.org/spec/messaging/")));
  assert.ok(MEDIATOR_TASK_TYPES.includes("https://trusttasks.org/spec/messaging/queue/purge/0.1"));
});

// ── refusals ────────────────────────────────────────────────────────────────

test("a mediator's problem report becomes a coded refusal — the descriptor is the code (R3.7)", () => {
  const e = problemReportError({
    body: { code: "e.p.permissionDenied", comment: "only an administrator may monitor another account's traffic" },
  });
  assert.equal(e.code, "e.p.msg.forbidden");
  assert.equal(e.details.code, "permissionDenied");
  assert.equal(e.details.details.problemCode, "e.p.permissionDenied");
  assert.match(e.message, /only an administrator/);
});

test("a dotted descriptor survives whole", () => {
  const e = problemReportError({ body: { code: "e.p.message.trust_task.proof_required", comment: "" } });
  assert.equal(e.details.code, "message.trust_task.proof_required");
});
