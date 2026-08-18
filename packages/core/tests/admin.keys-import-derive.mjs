// `keys/import`, the derive-and-sign pair, and `vault/get`.
//
// The import carriers are the sharp edge: three ways to hand over a private
// key, exactly one permitted per request, and one of the three is cleartext.
// The parameter type enforces the exclusivity because the schema's `oneOf`
// does not survive into the generated TypeScript — so these tests check the
// payload really does carry a single carrier.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  keysImport,
  keysDeriveAndSign,
  keysDeriveAndSignDocument,
} from "../dist/admin/index.js";
import { vaultGet } from "../dist/vault/index.js";

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

const RECORD = {
  keyId: "imported-1",
  keyType: "ed25519",
  status: "active",
  publicKey: "z6Mk…",
  createdAt: "2026-08-18T00:00:00Z",
};

test("import sends exactly the carrier it was given — sealed", async () => {
  const channel = recorder({ key: RECORD });
  await keysImport(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    sealed: "-----BEGIN VTA SEALED BUNDLE-----…",
  });
  const payload = channel.sent[0].envelope.payload;
  assert.deepEqual(Object.keys(payload).sort(), ["keyType", "privateKeySealed"]);
});

test("import maps jwe and multibase to their own members", async () => {
  const jwe = recorder({ key: RECORD });
  await keysImport(jwe, { holder: HOLDER, service: SERVICE, keyType: "ed25519", jwe: "ey…" });
  assert.equal(jwe.sent[0].envelope.payload.privateKeyJwe, "ey…");
  assert.ok(!("privateKeySealed" in jwe.sent[0].envelope.payload));

  const mb = recorder({ key: RECORD });
  await keysImport(mb, { holder: HOLDER, service: SERVICE, keyType: "p256", multibase: "z3u…" });
  assert.equal(mb.sent[0].envelope.payload.privateKeyMultibase, "z3u…");
  assert.ok(!("privateKeyJwe" in mb.sent[0].envelope.payload));
});

test("import unwraps the realized record from `key`", async () => {
  const channel = recorder({ key: RECORD });
  const result = await keysImport(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    sealed: "…",
  });
  assert.deepEqual(result, RECORD);
});

test("derive-and-sign carries the path, and keeps no record behind", async () => {
  // The signature is tied to the agent by the returned publicKey and the path
  // it derived from — there is no key to look up afterwards, which is the
  // difference from keysSign worth remembering.
  const channel = recorder({
    publicKey: "z6Mk…",
    signature: "sig",
    algorithm: "EdDSA",
  });
  const result = await keysDeriveAndSign(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    derivationPath: "m/44'/0'/1'/0/0",
    payload: "aGVsbG8=",
    algorithm: "EdDSA",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    keyType: "ed25519",
    derivationPath: "m/44'/0'/1'/0/0",
    payload: "aGVsbG8=",
    algorithm: "EdDSA",
  });
  assert.equal(result.publicKey, "z6Mk…");
});

test("derive-and-sign-document returns the signer DID a verifier resolves", async () => {
  const signed = { "@context": [], proof: { type: "DataIntegrityProof" } };
  const channel = recorder({ signerDid: "did:webvh:QmAgent:agent.example", document: signed });
  const result = await keysDeriveAndSignDocument(channel, {
    holder: HOLDER,
    service: SERVICE,
    keyType: "ed25519",
    derivationPath: "m/0",
    document: { "@context": [] },
    proofPurpose: "assertionMethod",
  });
  assert.deepEqual(channel.sent[0].envelope.payload, {
    keyType: "ed25519",
    derivationPath: "m/0",
    document: { "@context": [] },
    proofPurpose: "assertionMethod",
  });
  assert.equal(result.signerDid, "did:webvh:QmAgent:agent.example");
  assert.deepEqual(result.document, signed);
});

test("vault get returns metadata and reports what was withheld", async () => {
  // Redaction has to be visible: an entry rendered without saying parts were
  // withheld reads as a complete record to whoever decides something from it.
  const entry = {
    id: "e1",
    contextId: "personal",
    targets: [{ kind: "webOrigin", origin: "https://example.com" }],
    label: "Example",
    secretKind: "password",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    version: 2,
  };
  const channel = recorder({ entry, redactedFields: ["notes"] });
  const result = await vaultGet(channel, { holder: HOLDER, service: SERVICE, id: "e1" });

  assert.equal(channel.sent[0].envelope.type, "https://trusttasks.org/spec/vault/get/0.2");
  assert.deepEqual(channel.sent[0].envelope.payload, { id: "e1" });
  assert.deepEqual(result.redactedFields, ["notes"]);
  assert.equal(result.entry.label, "Example");
});

test("vault get never carries the secret itself", async () => {
  // Reading an entry and obtaining what is inside it are separate authorities;
  // the secret comes from vault/release, which is gated on its own.
  const channel = recorder({
    entry: { id: "e1", contextId: "c", targets: [], label: "l", secretKind: "password", createdAt: "", updatedAt: "", version: 1 },
  });
  const result = await vaultGet(channel, { holder: HOLDER, service: SERVICE, id: "e1" });
  assert.ok(!("secret" in result.entry));
  assert.deepEqual(result.redactedFields, []);
});
