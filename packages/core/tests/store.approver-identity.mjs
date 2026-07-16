// Unit tests for the co-located approver identity.
//
// The approver identity is the security pivot of the single-browser two-role
// model: a DID distinct from the worker (so `excludeRequester` and delegated
// conferral hold), an Ed25519 signing key + its X25519 keyAgreement form, and a
// seed that is only ever persisted PRF-wrapped. These tests pin the did:key
// shape, the round-trip, and that the wrap is actually applied.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryKVStore,
  mintApproverIdentity,
  loadApproverIdentity,
  approverDid,
  clearApproverIdentity,
} from "../dist/index.js";

const VTA_A = "did:key:zVtaAAAA";
const VTA_B = "did:key:zVtaBBBB";
const recordKey = (vta) => `pnm/approver-identity/v1/${vta}`;

test("mint produces a did:key with ed signing + x25519 keyAgreement VMs", async () => {
  const store = new InMemoryKVStore();
  const a = await mintApproverIdentity(store, { vtaDid: VTA_A });

  assert.match(a.did, /^did:key:z6Mk/, "Ed25519 did:key");
  assert.equal(a.signing.did, a.did);
  const mb = a.did.slice("did:key:".length);
  assert.equal(a.signing.kid, `${a.did}#${mb}`, "signing kid is <did>#<ed-multikey>");
  assert.equal(a.signing.privateKey.length, 32, "Ed25519 seed is 32 bytes");

  // The persisted record carries the X25519 keyAgreement VM (z6LS multikey).
  const rec = await store.get(recordKey(VTA_A));
  assert.match(rec.keyAgreementKid, /#z6LS/, "keyAgreement is the X25519 multikey");
  assert.equal(rec.schemaVersion, 1);
  assert.ok(rec.wrappedSecret, "seed is persisted wrapped, never bare");
});

test("distinct VTAs get distinct approver DIDs (independent seeds)", async () => {
  const store = new InMemoryKVStore();
  const a = await mintApproverIdentity(store, { vtaDid: VTA_A });
  const b = await mintApproverIdentity(store, { vtaDid: VTA_B });
  assert.notEqual(a.did, b.did);
});

test("minting twice for the same VTA throws — no silent re-mint", async () => {
  const store = new InMemoryKVStore();
  await mintApproverIdentity(store, { vtaDid: VTA_A });
  await assert.rejects(
    () => mintApproverIdentity(store, { vtaDid: VTA_A }),
    /already exists/,
  );
});

test("load round-trips the same identity, and is scoped per VTA", async () => {
  const store = new InMemoryKVStore();
  const minted = await mintApproverIdentity(store, { vtaDid: VTA_A });

  const loaded = await loadApproverIdentity(store, { vtaDid: VTA_A });
  assert.equal(loaded.did, minted.did);
  assert.deepEqual([...loaded.signing.privateKey], [...minted.signing.privateKey]);

  // No cross-talk: a VTA with no approver minted returns null.
  assert.equal(await loadApproverIdentity(store, { vtaDid: VTA_B }), null);
});

test("approverDid returns the DID without unwrapping the key", async () => {
  const store = new InMemoryKVStore();
  assert.equal(await approverDid(store, VTA_A), null, "none before mint");
  const minted = await mintApproverIdentity(store, { vtaDid: VTA_A });
  // No secretWrap passed — proves it never touches the wrapped seed.
  assert.equal(await approverDid(store, VTA_A), minted.did);
});

test("clear removes one approver, or all", async () => {
  const store = new InMemoryKVStore();
  await mintApproverIdentity(store, { vtaDid: VTA_A });
  await mintApproverIdentity(store, { vtaDid: VTA_B });

  await clearApproverIdentity(store, VTA_A);
  assert.equal(await loadApproverIdentity(store, { vtaDid: VTA_A }), null);
  assert.ok(await loadApproverIdentity(store, { vtaDid: VTA_B }), "B survives");

  await clearApproverIdentity(store);
  assert.equal(await loadApproverIdentity(store, { vtaDid: VTA_B }), null);
});

test("the supplied SecretWrap is applied on mint and required on load", async () => {
  const store = new InMemoryKVStore();
  const calls = { wrap: 0, unwrap: 0 };
  const wrap = {
    algorithm: "test-prf",
    async wrap(secret) {
      calls.wrap++;
      return {
        algorithm: "test-prf",
        ciphertextB64u: Buffer.from(secret).toString("base64url"),
        ivB64u: "",
        params: {},
      };
    },
    async unwrap(w) {
      calls.unwrap++;
      return new Uint8Array(Buffer.from(w.ciphertextB64u, "base64url"));
    },
  };

  const minted = await mintApproverIdentity(store, { vtaDid: VTA_A, secretWrap: wrap });
  assert.equal(calls.wrap, 1, "seed was wrapped on mint");
  const rec = await store.get(recordKey(VTA_A));
  assert.equal(rec.wrappedSecret.algorithm, "test-prf", "stored under the wrap's algorithm");

  const loaded = await loadApproverIdentity(store, { vtaDid: VTA_A, secretWrap: wrap });
  assert.equal(calls.unwrap, 1);
  assert.equal(loaded.did, minted.did, "round-trips through the wrap");

  // Loading a wrapped record without the matching wrap must fail closed, not
  // fall back to plaintext.
  await assert.rejects(() => loadApproverIdentity(store, { vtaDid: VTA_A }));
});
