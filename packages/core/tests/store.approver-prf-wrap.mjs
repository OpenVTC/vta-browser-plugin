// Tests for the approver PRF wrap — the KEK-isolation + per-decision derivation
// that guards the approver signing key.
//
// The security claims under test: the approver seed round-trips only with the
// exact PRF output that sealed it; a different biometric/output can't open it;
// the approver record is tagged with its own algorithm so it can never be loaded
// with the worker's wrap; and the whole thing composes with mint/loadApprover.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApproverPrfSecretWrap,
  APPROVER_WRAP_ALGORITHM,
  InMemoryKVStore,
  mintApproverIdentity,
  loadApproverIdentity,
  unwrapSecret,
} from "../dist/index.js";

const VTA = "did:key:zVtaPRF";
// Two distinct 32-byte "PRF outputs" standing in for two authenticator results.
const PRF = new Uint8Array(32).fill(7);
const OTHER_PRF = new Uint8Array(32).fill(9);

test("round-trips the seed with the same PRF output", async () => {
  const wrap = new ApproverPrfSecretWrap(PRF);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrap.wrap(seed);

  assert.equal(wrapped.algorithm, APPROVER_WRAP_ALGORITHM);
  const back = await new ApproverPrfSecretWrap(PRF).unwrap(wrapped);
  assert.deepEqual([...back], [...seed]);
});

test("a different PRF output cannot open the seed", async () => {
  const wrapped = await new ApproverPrfSecretWrap(PRF).wrap(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  // AES-GCM auth-tag failure — a wrong biometric/output must not silently return
  // garbage; it must throw.
  await assert.rejects(() => new ApproverPrfSecretWrap(OTHER_PRF).unwrap(wrapped));
});

test("the approver record is tagged so the worker wrap can't load it", async () => {
  const wrapped = await new ApproverPrfSecretWrap(PRF).wrap(new Uint8Array(32));
  // unwrapSecret dispatches on algorithm; with no matching wrap it must fail
  // closed rather than fall through to plaintext.
  await assert.rejects(() => unwrapSecret(wrapped));
  await assert.rejects(() => unwrapSecret(wrapped, { algorithm: "webauthn-prf-aes-gcm" }));
});

test("mint + load an approver identity through the PRF wrap", async () => {
  const store = new InMemoryKVStore();
  const minted = await mintApproverIdentity(store, {
    vtaDid: VTA,
    secretWrap: new ApproverPrfSecretWrap(PRF),
  });

  // Correct PRF output → the same identity.
  const loaded = await loadApproverIdentity(store, {
    vtaDid: VTA,
    secretWrap: new ApproverPrfSecretWrap(PRF),
  });
  assert.equal(loaded.did, minted.did);
  assert.deepEqual([...loaded.signing.privateKey], [...minted.signing.privateKey]);

  // Wrong PRF output → cannot load (per-decision biometric really gates it).
  await assert.rejects(() =>
    loadApproverIdentity(store, {
      vtaDid: VTA,
      secretWrap: new ApproverPrfSecretWrap(OTHER_PRF),
    }),
  );
});
