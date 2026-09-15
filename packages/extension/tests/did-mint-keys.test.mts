// Which existing keys a new DID may be built on.
//
// Each of the three filters rules out a different kind of wrong, and two of
// them are wrong in a way that only shows up much later:
//
//   - an x25519 signing method is a DID that can never update its own log,
//     because x25519 does not sign — and the entry that would have to be signed
//     is the first one, written at mint time
//   - a revoked key is retained so historic signatures stay attributable;
//     publishing it in a NEW DID attributes new material to a key somebody
//     decided to stop trusting
//   - a key's absent `contextId` is not a wildcard. The record's own
//     documentation says a consumer reading it as one inverts the guarantee.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeyRecord } from "@openvtc/pnm-core/admin";
import {
  AGREEMENT_TYPE,
  SIGNING_TYPES,
  keyLabel,
  mintKeys,
  stillOffered,
} from "../src/manager/mint-keys.js";

const key = (over: Partial<KeyRecord> = {}): KeyRecord =>
  ({
    keyId: "key-1",
    keyType: "ed25519",
    status: "active",
    publicKey: "z6MkOne",
    contextId: "ops",
    createdAt: "2026-09-01T00:00:00Z",
    ...over,
  }) as KeyRecord;

test("a signing key and a key-agreement key go to different lists", () => {
  const out = mintKeys(
    [key({ keyId: "sign", keyType: "ed25519" }), key({ keyId: "ka", keyType: "x25519" })],
    "ops",
  );
  assert.deepEqual(out.signing.map((k) => k.keyId), ["sign"]);
  assert.deepEqual(out.agreement.map((k) => k.keyId), ["ka"]);
});

test("p256 signs too, and is offered as a signing key", () => {
  const out = mintKeys([key({ keyId: "p", keyType: "p256" })], "ops");
  assert.deepEqual(out.signing.map((k) => k.keyId), ["p"]);
  assert.deepEqual(out.agreement, []);
  assert.deepEqual([...SIGNING_TYPES].sort(), ["ed25519", "p256"]);
  assert.equal(AGREEMENT_TYPE, "x25519");
});

// The sharp one. A DID whose signing method cannot sign is not a DID with a
// faulty key — it is a DID that can never be updated, and the log entry that
// would have to carry the signature is the one written at mint time.
test("a key-agreement key is never offered as the one that signs", () => {
  const out = mintKeys([key({ keyId: "ka", keyType: "x25519" })], "ops");
  assert.deepEqual(out.signing, []);
});

test("a signing key is never offered for key agreement", () => {
  const out = mintKeys([key({ keyType: "ed25519" }), key({ keyId: "b", keyType: "p256" })], "ops");
  assert.deepEqual(out.agreement, []);
});

test("a revoked key is offered for neither role", () => {
  const out = mintKeys(
    [
      key({ keyId: "gone", keyType: "ed25519", status: "revoked" }),
      key({ keyId: "gone-ka", keyType: "x25519", status: "revoked" }),
    ],
    "ops",
  );
  assert.deepEqual(out.signing, []);
  assert.deepEqual(out.agreement, []);
});

test("a key from another context is not offered", () => {
  const out = mintKeys([key({ keyId: "elsewhere", contextId: "rooms" })], "ops");
  assert.deepEqual(out.signing, []);
});

// The specification is explicit that absence is the MORE restrictive reading —
// such a key is reachable only by unrestricted authority — so treating it as
// "usable in every context" would invert the guarantee.
test("a key with no context is not treated as belonging to every context", () => {
  const out = mintKeys([key({ keyId: "unscoped", contextId: undefined })], "ops");
  assert.deepEqual(out.signing, [], "absence is not a wildcard");
});

test("a label is shown where there is one, and the id always", () => {
  assert.equal(keyLabel(key({ keyId: "key-3", label: "billing signer" })), "billing signer (key-3) · ed25519");
  assert.equal(keyLabel(key({ keyId: "key-3" })), "key-3 · ed25519");
});

// Changing the tree changes which keys are usable. A stale id would reach the
// agent as a key belonging to a different context — refused, but only after it
// had derived everything else.
test("a selection the context no longer offers is not still offered", () => {
  const offered = [key({ keyId: "a" })];
  assert.equal(stillOffered("a", offered), true);
  assert.equal(stillOffered("b", offered), false);
  assert.equal(stillOffered("", offered), true, "no selection is always valid");
  assert.equal(stillOffered("", []), true);
});
