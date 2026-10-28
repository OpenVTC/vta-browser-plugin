// The families added once the specced-but-unimplemented gap was closed.
//
// Each test pins something the type cannot say and a caller would otherwise
// discover in production: a bound that belongs to the specification rather than
// to us, two wire shapes that mean the same thing, a falsy value that is a real
// instruction, and a notice that must not be believed from a stranger.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  discoverSupportedTypes,
  supportsType,
  MAX_DISCOVERY_PATTERNS,
  startPasskeyLogin,
  finishPasskeyLogin,
} from "../dist/vta/index.js";
import { appStatePut, appStateDelete, appStateList } from "../dist/app-state/index.js";
import { serviceDisable, aclUpdate } from "../dist/admin/index.js";
import { parseRemovalNotice } from "../dist/vtc/index.js";

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

// ── trust-task-discovery ────────────────────────────────────────────────────

test("no patterns sends no patterns — the responder's ['*'] default", async () => {
  // Not `patterns: []`. The spec makes omitted and empty equivalent, but
  // sending the empty array asserts a filter where none was asked for.
  const channel = recorder({ supportedTypes: [] });
  await discoverSupportedTypes(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(channel.sent[0].envelope.payload, {});
});

test("both wire forms of an entry normalize to one shape", async () => {
  // A bare string and an object are the same claim; a consumer that handles
  // only the string form drops every `requiredExt`, and those are exactly the
  // responders whose tasks fail unless the producer acts on them.
  const channel = recorder({
    supportedTypes: [
      "https://trusttasks.org/spec/vault/list/0.4",
      {
        type: "https://trusttasks.org/spec/vault/upsert/0.4",
        requiredExt: ["org.example.tenancy"],
      },
    ],
    frameworkVersion: "0.6.0",
  });
  const res = await discoverSupportedTypes(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(res.supportedTypes, [
    { type: "https://trusttasks.org/spec/vault/list/0.4", requiredExt: [] },
    {
      type: "https://trusttasks.org/spec/vault/upsert/0.4",
      requiredExt: ["org.example.tenancy"],
    },
  ]);
  assert.equal(res.frameworkVersion, "0.6.0");
});

test("supportsType compares the bare URI, so either variant answers", async () => {
  const channel = recorder({
    supportedTypes: ["https://trusttasks.org/spec/vault/list/0.4"],
  });
  const res = await discoverSupportedTypes(channel, { holder: HOLDER, service: SERVICE });
  assert.equal(supportsType(res, "https://trusttasks.org/spec/vault/list/0.4"), true);
  assert.equal(
    supportsType(res, "https://trusttasks.org/spec/vault/list/0.4#response"),
    true,
    "a responder listing a bare URI supports both variants",
  );
  assert.equal(supportsType(res, "https://trusttasks.org/spec/vault/get/0.3"), false);
});

test("an entry's acceptance window wins over the response's, and absence stays absence", async () => {
  // trust-task-discovery/0.3: a response-level window applies to every entry
  // that carries none of its own. With neither, nothing was learnt — the entry
  // must not come back with a window this wallet made up.
  const own = { maxAgeSeconds: 60, clockSkewSeconds: 5 };
  const all = { maxAgeSeconds: 300, clockSkewSeconds: 30 };
  const withDefault = await discoverSupportedTypes(
    recorder({
      supportedTypes: [
        "https://trusttasks.org/spec/vault/list/0.4",
        { type: "https://trusttasks.org/spec/vault/upsert/0.4", acceptanceWindow: own },
      ],
      acceptanceWindow: all,
    }),
    { holder: HOLDER, service: SERVICE },
  );
  assert.deepEqual(withDefault.supportedTypes, [
    { type: "https://trusttasks.org/spec/vault/list/0.4", requiredExt: [], acceptanceWindow: all },
    { type: "https://trusttasks.org/spec/vault/upsert/0.4", requiredExt: [], acceptanceWindow: own },
  ]);

  const silent = await discoverSupportedTypes(
    recorder({ supportedTypes: ["https://trusttasks.org/spec/vault/list/0.4"] }),
    { holder: HOLDER, service: SERVICE },
  );
  assert.equal("acceptanceWindow" in silent.supportedTypes[0], false);
});

test("the §10.2 pattern bound is refused here, not at the responder", async () => {
  // The responder's own rejection is a `malformedRequest` that names no limit.
  const channel = recorder({ supportedTypes: [] });
  await assert.rejects(
    () =>
      discoverSupportedTypes(channel, {
        holder: HOLDER,
        service: SERVICE,
        patterns: Array.from({ length: MAX_DISCOVERY_PATTERNS + 1 }, (_, i) => `p${i}/*`),
      }),
    (e) => /at most 16 patterns/.test(e.message) && e.code === "e.client.parse",
  );
  assert.equal(channel.sent.length, 0, "nothing was sent");
});

// ── app-state ───────────────────────────────────────────────────────────────

test("a null value is written, and expectedVersion 0 survives as create-only", async () => {
  // Both are falsy. A truthiness guard drops the JSON literal null (which is a
  // real stored value, unlike an omitted `value`) and turns create-only into a
  // last-writer-wins upsert — which silently overwrites the record it was
  // supposed to refuse to touch.
  const channel = recorder({ contextId: "c", namespace: "n", key: "k", version: 1, wasCreated: true, updatedAt: "t" });
  await appStatePut(channel, {
    holder: HOLDER, service: SERVICE, contextId: "c",
    namespace: "n", key: "k", value: null, expectedVersion: 0,
  });
  const payload = channel.sent[0].envelope.payload;
  assert.equal(payload.value, null);
  assert.equal(payload.expectedVersion, 0);
});

test("an omitted value is absent, not null — the two are different writes", async () => {
  const channel = recorder({ contextId: "c", namespace: "n", key: "k", version: 2, wasCreated: false, updatedAt: "t" });
  await appStatePut(channel, {
    holder: HOLDER, service: SERVICE, contextId: "c",
    namespace: "n", key: "k", mergePatch: { a: 1 },
  });
  const payload = channel.sent[0].envelope.payload;
  assert.equal("value" in payload, false);
  assert.deepEqual(payload.mergePatch, { a: 1 });
});

test("list sends only the filters it was given", async () => {
  const channel = recorder({ records: [] });
  await appStateList(channel, {
    holder: HOLDER, service: SERVICE, contextId: "c", sinceVersion: 0,
  });
  // `sinceVersion: 0` is a real floor, not an absence — it is the first call of
  // an incremental sync.
  assert.deepEqual(channel.sent[0].envelope.payload, { contextId: "c", sinceVersion: 0 });
});

// 1.1 pages by the registry convention: `limit`, not 1.0's `pageSize`.
test("list carries limit and cursor at 1.1", async () => {
  const channel = recorder({ records: [], nextCursor: "c2" });
  await appStateList(channel, {
    holder: HOLDER, service: SERVICE, contextId: "c", limit: 50, cursor: "c1",
  });
  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/vta/app-state/list/1.1");
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/vta/app-state/list/1.1#response");
  assert.deepEqual(envelope.payload, { contextId: "c", limit: 50, cursor: "c1" });
});

test("delete addresses the record and carries the task version", async () => {
  const channel = recorder({ contextId: "c", namespace: "n", key: "k", existed: true });
  await appStateDelete(channel, {
    holder: HOLDER, service: SERVICE, contextId: "c", namespace: "n", key: "k",
  });
  assert.equal(
    channel.sent[0].envelope.type,
    "https://trusttasks.org/spec/vta/app-state/delete/1.0",
  );
});

// ── services ────────────────────────────────────────────────────────────────

test("drainTtlSeconds 0 is sent — it means drop in-flight work, not 'unspecified'", async () => {
  const channel = recorder({ result: {} });
  await serviceDisable(channel, {
    holder: HOLDER, service: SERVICE, kind: "didcomm", drainTtlSeconds: 0,
  });
  assert.equal(channel.sent[0].envelope.payload.drainTtlSeconds, 0);
});

test("omitting drainTtlSeconds leaves the agent's default, which is not zero", async () => {
  const channel = recorder({ result: {} });
  await serviceDisable(channel, { holder: HOLDER, service: SERVICE, kind: "rest" });
  assert.equal("drainTtlSeconds" in channel.sent[0].envelope.payload, false);
});

// ── acl/update ──────────────────────────────────────────────────────────────

test("acl/update sends a key scope only when one is stated", async () => {
  // 0.2 replaced 0.1's absent / null / [] `allowedKeys` with an explicit
  // `keys` scope. What survives is the partial-update rule: an omitted member
  // is left alone, and must not be sent as anything — least of all `all`.
  const entry = { subject: "did:key:zSub", role: "reader" };
  for (const [keys, expected] of [
    [undefined, undefined],
    [{ scope: "all" }, { scope: "all" }],
    [{ scope: "none" }, { scope: "none" }],
  ]) {
    const channel = recorder({ entry });
    await aclUpdate(channel, {
      holder: HOLDER, service: SERVICE, subject: "did:key:zSub",
      ...(keys !== undefined ? { keys } : {}),
    });
    const { type, payload } = channel.sent[0].envelope;
    assert.equal(type, "https://trusttasks.org/spec/acl/update/0.2");
    if (expected === undefined) assert.equal("keys" in payload, false);
    else assert.deepEqual(payload.keys, expected);
  }
});

// ── passkey login ───────────────────────────────────────────────────────────

test("passkey login targets 0.2, the version that can say stepUp", async () => {
  const channel = recorder({ authId: "a1", options: {} });
  await startPasskeyLogin(channel, {
    holder: HOLDER, service: SERVICE, purpose: "stepUp",
  });
  assert.equal(
    channel.sent[0].envelope.type,
    "https://trusttasks.org/spec/auth/passkey/login/start/0.2",
  );
  assert.equal(channel.sent[0].envelope.payload.purpose, "stepUp");
});

test("a stepUp finish with no tokens is a success, not a failure", async () => {
  // A step-up raises the session already in hand rather than minting a bundle,
  // so absent `tokens` is the normal case and a caller that treats it as an
  // error rejects every step-up it performs.
  const channel = recorder({ session: { id: "s1" }, purpose: "stepUp" });
  const res = await finishPasskeyLogin(channel, {
    holder: HOLDER, service: SERVICE, authId: "a1", credential: {},
  });
  assert.equal(res.purpose, "stepUp");
  assert.equal(res.tokens, undefined);
});

// ── vtc removal notice ──────────────────────────────────────────────────────

const NOTICE = {
  type: "https://trusttasks.org/spec/vtc/members/removal-notice/0.1",
  issuer: "did:webvh:QmCommunity:vtc.example",
  payload: {
    did: HOLDER.did,
    code: "adminRemoved",
    disposition: "tombstone",
    decidedAt: "2026-08-20T09:00:00Z",
    decidedBy: "did:key:zAdmin",
    reason: "inactive for 12 months",
  },
};

test("a removal notice from the expected community parses", () => {
  const parsed = parseRemovalNotice(NOTICE, NOTICE.issuer);
  assert.equal(parsed.code, "adminRemoved");
  assert.equal(parsed.disposition, "tombstone");
  // Not the envelope's issuedAt: the decision and its delivery diverge by
  // however long the member was offline.
  assert.equal(parsed.decidedAt, "2026-08-20T09:00:00Z");
  assert.equal(parsed.decidedBy, "did:key:zAdmin");
});

test("a notice from anyone else is refused", () => {
  // The security boundary. An unauthenticated party must not be able to tell a
  // wallet its membership is gone — that is a cheap way to make somebody
  // abandon a community they are still in.
  assert.equal(parseRemovalNotice(NOTICE, "did:webvh:QmOther:elsewhere.example"), null);
  assert.equal(parseRemovalNotice({ ...NOTICE, issuer: undefined }, NOTICE.issuer), null);
});

test("decidedBy is not who the notice is trusted from", () => {
  // `decidedBy` names the administrator; the community is the `issuer`. Trusting
  // the payload's own claim would let any community's notice pass as any
  // other's.
  assert.equal(parseRemovalNotice(NOTICE, "did:key:zAdmin"), null);
});

test("a notice missing a required member is refused, not half-rendered", () => {
  for (const drop of ["did", "code", "disposition", "decidedAt", "decidedBy"]) {
    const payload = { ...NOTICE.payload };
    delete payload[drop];
    assert.equal(
      parseRemovalNotice({ ...NOTICE, payload }, NOTICE.issuer),
      null,
      `missing ${drop}`,
    );
  }
  // An unknown code is not coerced to a known one.
  assert.equal(
    parseRemovalNotice(
      { ...NOTICE, payload: { ...NOTICE.payload, code: "removed" } },
      NOTICE.issuer,
    ),
    null,
  );
});

test("an absent reason stays absent — it is not an empty string", () => {
  const payload = { ...NOTICE.payload };
  delete payload.reason;
  const parsed = parseRemovalNotice({ ...NOTICE, payload }, NOTICE.issuer);
  assert.equal("reason" in parsed, false, "render 'no reason given', not a blank line");
});

test("anything that is not a removal notice is ignored in silence", () => {
  assert.equal(parseRemovalNotice(null, NOTICE.issuer), null);
  assert.equal(parseRemovalNotice({ type: "urn:something-else" }, NOTICE.issuer), null);
});
