// The `keys/*` request bodies.
//
// The agent accepts snake_case aliases on intake as well as canonical
// camelCase, which is the trap worth testing around: a body emitted with the
// wrong casing works against today's agent and fails against a stricter one, so
// a smoke test would not catch what these assertions do.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  keysCreate,
  keysList,
  keysShow,
  keysRename,
  keysRevoke,
  keysSign,
} from "../dist/admin/index.js";

const HOLDER = { did: "did:key:zAdmin" };
const SERVICE = { did: "did:webvh:QmAgent:agent.example" };

const RECORD = {
  keyId: "signing-1",
  derivationPath: "m/44'/0'/0'/0/0",
  keyType: "ed25519",
  status: "active",
  publicKey: "z6Mk…",
  createdAt: "2026-08-18T00:00:00Z",
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

test("create sends camelCase, and unwraps the record from `key`", async () => {
  const channel = recorder({ key: RECORD });
  const result = await keysCreate(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    derivationPath: "m/44'/0'/0'/0/0",
    label: "signing",
    contextId: "demo",
  });

  const { envelope, opts } = channel.sent[0];
  assert.equal(envelope.type, "https://trusttasks.org/spec/keys/create/0.1");
  assert.deepEqual(envelope.payload, {
    keyType: "ed25519",
    derivationPath: "m/44'/0'/0'/0/0",
    label: "signing",
    contextId: "demo",
  });
  assert.equal(opts.expectedResponseType, "https://trusttasks.org/spec/keys/create/0.1#response");
  assert.deepEqual(result, RECORD);
});

test("internal:false is sent, not dropped", async () => {
  // `internal` decides whether the key is recoverable from the mnemonic ever
  // again. A truthiness guard would silently drop an explicit `false`, and the
  // agent's default is the opposite of what the caller asked for in the case
  // that matters.
  const channel = recorder({ key: RECORD });
  await keysCreate(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    derivationPath: "m/0",
    internal: false,
  });
  assert.equal(channel.sent[0].envelope.payload.internal, false);
});

test("create omits the optional fields that were not given", async () => {
  const channel = recorder({ key: RECORD });
  await keysCreate(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "p256",
    derivationPath: "m/0",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    keyType: "p256",
    derivationPath: "m/0",
  });
});

test("list sends only the filters given, and offset 0 is a filter", async () => {
  const channel = recorder({ keys: [RECORD], total: 1, offset: 0, limit: 50 });
  const result = await keysList(channel, {
    holder: HOLDER,
    service: SERVICE,
    offset: 0,
    status: "active",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { offset: 0, status: "active" });
  assert.deepEqual(result, { keys: [RECORD], total: 1, offset: 0, limit: 50 });
});

test("list survives an agent that omits the paging fields", async () => {
  const channel = recorder({});
  const result = await keysList(channel, { holder: HOLDER, service: SERVICE });
  assert.deepEqual(result, { keys: [], total: 0, offset: 0, limit: 0 });
});

test("show returns null for a key the agent does not hold", async () => {
  // `key: null` is a successful response, not a rejection — the caller should
  // not have to read an error to tell "no such key" from "the call failed".
  const channel = recorder({ key: null });
  const result = await keysShow(channel, { holder: HOLDER, service: SERVICE, keyId: "nope" });
  assert.equal(result, null);
  assert.deepEqual(channel.sent[0].envelope.payload, { keyId: "nope" });
});

test("show returns the record when there is one", async () => {
  const channel = recorder({ key: RECORD });
  const result = await keysShow(channel, { holder: HOLDER, service: SERVICE, keyId: "signing-1" });
  assert.deepEqual(result, RECORD);
});

test("rename sends both ids", async () => {
  const channel = recorder({ keyId: "signing-2", updatedAt: "2026-08-18T00:01:00Z" });
  const result = await keysRename(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyId: "signing-1",
    newKeyId: "signing-2",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    keyId: "signing-1",
    newKeyId: "signing-2",
  });
  assert.equal(result.keyId, "signing-2");
});

test("revoke is a state change — the record comes back revoked, not deleted", async () => {
  const channel = recorder({
    keyId: "signing-1",
    status: "revoked",
    updatedAt: "2026-08-18T00:02:00Z",
  });
  const result = await keysRevoke(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyId: "signing-1",
    reason: "rotated",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, { keyId: "signing-1", reason: "rotated" });
  assert.equal(result.status, "revoked");
});

test("sign sends the algorithm in its canonical spelling", async () => {
  // `EdDSA` and `ES256`, not `eddsa`/`es256`. The agent aliases the lowercase
  // forms on intake, so getting this wrong passes locally and fails elsewhere.
  const channel = recorder({ keyId: "signing-1", signature: "sig", algorithm: "EdDSA" });
  await keysSign(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyId: "signing-1",
    payload: "aGVsbG8=",
    algorithm: "EdDSA",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    keyId: "signing-1",
    payload: "aGVsbG8=",
    algorithm: "EdDSA",
  });
});

test("a refusal propagates rather than resolving to a half-answer", async () => {
  const failing = {
    send: () => Promise.reject(new Error("e.keys.revoked: key is not active")),
  };
  await assert.rejects(
    () =>
      keysSign(failing, {
        holder: HOLDER,
        service: SERVICE,
        keyId: "signing-1",
        payload: "aGVsbG8=",
        algorithm: "EdDSA",
      }),
    /e\.keys\.revoked/,
  );
});

test("keyId is sent, and an internal key needs one", async () => {
  // `keys/create/0.1` gained `keyId` errata-style (dtgwg-trust-tasks-tf#275),
  // and vta-sdk 0.30.0 was cut for exactly that field. It is optional in the
  // schema, but not in practice for `internal: true`: such a key derives from
  // no seed and records no derivation path, so there is nothing for the agent
  // to name it after. Omitting it there is how an unrecoverable key ends up
  // unaddressable as well.
  const channel = recorder({ key: { keyId: "signing-1", origin: "internal" } });
  await keysCreate(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    keyId: "signing-1",
    internal: true,
  });
  const payload = channel.sent[0].envelope.payload;
  assert.equal(payload.keyId, "signing-1");
  assert.equal(payload.internal, true);
  assert.equal("derivationPath" in payload, false, "an internal key has no path");
});

test("internal is a first-class member now, not a widening", async () => {
  // `internal` and `origin: "internal"` were the agent's own extensions, carried
  // here as explicit widenings of the generated types. The registry specified
  // both, so the widenings went; this pins that the plain generated types still
  // carry them, which is what makes their removal safe.
  const channel = recorder({ key: { keyId: "k", origin: "internal" } });
  const rec = await keysCreate(channel, {
    holder: HOLDER, service: SERVICE, keyType: "ed25519", internal: false,
  });
  // `internal: false` is a decision — "derive it, keep it recoverable" — and
  // must survive rather than being dropped as falsy.
  assert.equal(channel.sent[0].envelope.payload.internal, false);
  assert.equal(rec.origin, "internal");
});
