// `signTrustTask` signs as the identity the page asked for, or refuses. It
// used to fall back to the holder key — a document whose `issuer` claims one
// identity carrying a proof by another — whenever no vault entry matched
// `asDid`, and whenever the wallet knew no REST base for its VTA.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseTrustTaskSigner,
  needsVault,
  SIGN_AS_UNAVAILABLE,
  type SignableEntry,
} from "../src/sign-identity.ts";

const HOLDER = "did:key:z6MkHolder";
const PERSONA = "did:key:z6MkPersona";
const entries: SignableEntry[] = [
  { id: "e-password", principalDid: PERSONA, secretKind: "password" },
  { id: "e-persona", principalDid: PERSONA, secretKind: "didSelfIssued" },
];

const refusal = (e: unknown) =>
  (e as { code?: string }).code === SIGN_AS_UNAVAILABLE;

test("no asDid, or asDid naming the holder, signs with the holder key", () => {
  assert.deepEqual(chooseTrustTaskSigner(undefined, HOLDER, null), { kind: "holder" });
  assert.deepEqual(chooseTrustTaskSigner(HOLDER, HOLDER, null), { kind: "holder" });
  assert.equal(needsVault(undefined, HOLDER), false);
  assert.equal(needsVault(HOLDER, HOLDER), false);
});

test("a persona with a signable vault entry is signed by the VTA as that entry", () => {
  assert.deepEqual(chooseTrustTaskSigner(PERSONA, HOLDER, entries), {
    kind: "vault",
    entryId: "e-persona",
  });
});

test("an asDid with no signable vault entry is refused, never holder-signed", () => {
  assert.throws(() => chooseTrustTaskSigner("did:key:z6MkStranger", HOLDER, entries), refusal);
  // A matching principal whose secret is not a signing identity does not count.
  assert.throws(
    () => chooseTrustTaskSigner(PERSONA, HOLDER, [entries[0]!]),
    refusal,
  );
});

test("an asDid with no route to the VTA is refused, never holder-signed", () => {
  assert.throws(() => chooseTrustTaskSigner(PERSONA, HOLDER, null), refusal);
});
