// `device/*` (the operator half), `audit/list` and `config/*`.
//
// The recurring hazard in this group is a boolean or a list whose *absence*
// means something different from its falsy value: `includeDisabled: false`
// hides devices that were deliberately taken away, and an empty `keys` list on
// `config/show` is a request for nothing rather than for everything.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deviceList,
  deviceDisable,
  deviceWipe,
  auditList,
  configShow,
  configPatch,
} from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

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

// ── devices ─────────────────────────────────────────────────────────────────

test("list sends only the filters given, under the 0.2 type", async () => {
  const channel = recorder({ devices: [], truncated: false });
  await deviceList(channel, {
    holder: HOLDER,
    service: SERVICE,
    consumerKindFilter: "companion",
    pageSize: 25,
  });
  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/device/list/0.2");
  assert.deepEqual(envelope.payload, { consumerKindFilter: "companion", pageSize: 25 });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/device/list/0.2#response");
});

test("includeDisabled:false is sent — it is a narrower request, not an absent one", async () => {
  // The default already omits disabled devices, so `false` reads as the same
  // thing — but it is the caller stating it, and a device that was taken away
  // still existing is exactly what this filter decides the visibility of.
  const channel = recorder({ devices: [], truncated: false });
  await deviceList(channel, { holder: HOLDER, service: SERVICE, includeDisabled: false });
  assert.deepEqual(channel.sent[0].envelope.payload, { includeDisabled: false });
});

test("list defaults the response fields the agent may omit", async () => {
  const channel = recorder({});
  assert.deepEqual(await deviceList(channel, { holder: HOLDER, service: SERVICE }), {
    devices: [],
    truncated: false,
  });
});

test("disable keeps the record — reason travels with it", async () => {
  const channel = recorder({ deviceId: "dev-1", disabledAt: "2026-08-18T00:00:00Z" });
  await deviceDisable(channel, {
    holder: HOLDER,
    service: SERVICE,
    deviceId: "dev-1",
    reason: "lost",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { deviceId: "dev-1", reason: "lost" });
});

test("wipe carries scope and reason, both required by the schema", async () => {
  // A wipe with no recorded reason is an audit gap, and the specification
  // refuses one — so neither parameter is optional here and neither is
  // defaulted.
  const channel = recorder({ deviceId: "dev-1", accepted: true });
  await deviceWipe(channel, {
    holder: HOLDER,
    service: SERVICE,
    deviceId: "dev-1",
    scope: "cacheAndKeys",
    reason: "stolen at conference",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    deviceId: "dev-1",
    scope: "cacheAndKeys",
    reason: "stolen at conference",
  });
});

// ── audit ───────────────────────────────────────────────────────────────────

test("audit list forwards the window and the filters", async () => {
  const channel = recorder({ entries: [], truncated: false });
  await auditList(channel, {
    holder: HOLDER,
    service: SERVICE,
    from: "2026-08-01T00:00:00Z",
    action: "acl.grant",
    actor: HOLDER.did,
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    from: "2026-08-01T00:00:00Z",
    action: "acl.grant",
    actor: HOLDER.did,
  });
});

test("audit list reports truncation rather than hiding it", async () => {
  // A partial audit page read as a complete account is the failure an audit
  // trail exists to prevent, so `truncated` is surfaced, never smoothed away.
  const channel = recorder({ entries: [{ id: "a1" }], truncated: true, cursor: "c1" });
  const result = await auditList(channel, { holder: HOLDER, service: SERVICE });
  assert.equal(result.truncated, true);
  assert.equal(result.cursor, "c1");
});

// ── config ──────────────────────────────────────────────────────────────────

test("config show with no keys asks for everything", async () => {
  const channel = recorder({ fields: [{ key: "server.port", value: 8100 }] });
  const fields = await configShow(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
  assert.equal(fields.length, 1);
});

test("config show forwards a key filter verbatim", async () => {
  const channel = recorder({ fields: [] });
  await configShow(channel, {
    holder: HOLDER,
    service: SERVICE,
    keys: ["server.port", "log.level"],
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { keys: ["server.port", "log.level"] });
});

test("config patch hands back all three outcome lists", async () => {
  // `applied`, `pendingRestart` and `rejected` each mean something different,
  // and a caller that reads only the status code will tell an operator a
  // setting is live when it is queued — or when the agent refused it.
  const reply = {
    applied: ["log.level"],
    pendingRestart: ["server.port"],
    rejected: [{ key: "server.host", reason: "immutable" }],
  };
  const channel = recorder(reply);
  const result = await configPatch(channel, {
    holder: HOLDER,
    service: SERVICE,
    overrides: { "log.level": "debug", "server.port": 9000, "server.host": "0.0.0.0" },
  });
  assert.deepEqual(result, reply);
  assert.deepEqual(channel.sent[0].envelope.payload, {
    overrides: { "log.level": "debug", "server.port": 9000, "server.host": "0.0.0.0" },
  });
});
