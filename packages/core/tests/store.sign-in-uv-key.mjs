// The sign-in approval key (`store/sign-in-uv-key.ts`): one sealed Ed25519
// `did:key` per VTA, unsealed per approval by the wallet passkey's PRF output.
//
// What these pin:
//   - the first approval mints it, later ones unseal the same key;
//   - it is sealed in its own KEK domain: another PRF output, the approver's
//     wrap or the holder's cannot open it;
//   - a record not sealed by its wrap is refused, never read as plaintext;
//   - each VTA gets its own key, and a decision it signs verifies as it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApproverPrfSecretWrap,
  InMemoryKVStore,
  SIGN_IN_UV_WRAP_ALGORITHM,
  buildUvConsentDecision,
  forgetSignInUvKey,
  signInUvKey,
  signInUvKeyDid,
  verifyTrustTaskProof,
  wrapSecret,
} from "../dist/index.js";

const VTA = "did:webvh:QmVta:vta.example.org";
const OTHER_VTA = "did:webvh:QmOther:vta.example.org";
const prf = (b) => new Uint8Array(32).fill(b);

test("the first approval mints the key; later ones unseal the same one", async () => {
  const store = new InMemoryKVStore();
  assert.equal(await signInUvKeyDid(store, VTA), null);
  const first = await signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) });
  assert.equal(first.minted, true);
  assert.match(first.signing.did, /^did:key:z6Mk/);
  assert.equal(first.signing.kid, `${first.signing.did}#${first.signing.did.slice("did:key:".length)}`);
  assert.equal(await signInUvKeyDid(store, VTA), first.signing.did);

  const again = await signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) });
  assert.equal(again.minted, false);
  assert.equal(again.signing.did, first.signing.did);
  assert.deepEqual(again.signing.privateKey, first.signing.privateKey);
});

test("only the same passkey's PRF output opens it", async () => {
  const store = new InMemoryKVStore();
  await signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) });
  await assert.rejects(signInUvKey(store, { vtaDid: VTA, prfOutput: prf(2) }));
});

test("a record sealed in another key domain, or not sealed at all, is refused", async () => {
  const store = new InMemoryKVStore();
  const { signing } = await signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) });
  const key = `pnm/sign-in-uv-key/v1/${VTA}`;
  const record = await store.get(key);
  assert.equal(record.wrappedSecret.algorithm, SIGN_IN_UV_WRAP_ALGORITHM);

  // The approver's wrap, same PRF output: a different KEK and algorithm.
  const asApprover = await wrapSecret(signing.privateKey, new ApproverPrfSecretWrap(prf(1)));
  await store.put(key, { ...record, wrappedSecret: asApprover });
  await assert.rejects(signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) }), /not sealed/);

  // Passthrough: usable without anyone's gesture, so never opened.
  const plain = await wrapSecret(signing.privateKey, undefined);
  await store.put(key, { ...record, wrappedSecret: plain });
  await assert.rejects(signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) }), /not sealed/);
});

test("each VTA gets its own key, and forgetting one leaves the others", async () => {
  const store = new InMemoryKVStore();
  const a = await signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) });
  const b = await signInUvKey(store, { vtaDid: OTHER_VTA, prfOutput: prf(1) });
  assert.notEqual(a.signing.did, b.signing.did);
  await forgetSignInUvKey(store, VTA);
  assert.equal(await signInUvKeyDid(store, VTA), null);
  assert.equal(await signInUvKeyDid(store, OTHER_VTA), b.signing.did);
});

test("a decision the unsealed key signs verifies as that key", async () => {
  const store = new InMemoryKVStore();
  const { signing } = await signInUvKey(store, { vtaDid: VTA, prfOutput: prf(1) });
  const decision = await buildUvConsentDecision({ uvKey: signing, vtaDid: VTA, payloadDigest: "zQmDigest" });
  const v = await verifyTrustTaskProof(decision, { expectedProofPurpose: "assertionMethod" });
  assert.equal(v.verified, true);
  assert.equal(v.signer, signing.did);
});
