// did:scid in the wallet's own DID handling: method detection and the domain
// shown for it, the src host guard, and a Trust-Task proof by a did:scid key
// attributed to the identity — the bare DID — whatever `src` the proof's
// verification method carried (VTI-KEY-160, 163).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  didMethod,
  didScidDomain,
  verifyDid,
  assertResolvableScidHost,
  isBlockedEndpointError,
  deriveSigningKeyId,
} from "../dist/did/index.js";
import { signTrustTask } from "../dist/trust-tasks/sign.js";
import { verifyTrustTaskProof, listsMethodUnder } from "../dist/trust-tasks/verify.js";
import { base58btcEncode } from "../dist/trust-tasks/canonical.js";

const SCID = "did:scid:vh:1:QmXa7Rk2ZpLwT9vNc4HbYe1Jd8sMfU3qGo6PtVnEyKiBhW";
const URL_ = `${SCID}?src=dids.example.org/alice`;

test("didMethod and didScidDomain", () => {
  assert.equal(didMethod(URL_), "scid");
  assert.equal(didMethod(SCID), "scid");
  assert.equal(didScidDomain(URL_), "dids.example.org");
  assert.equal(didScidDomain(`${SCID}?src=https://dids.example.org/alice/`), "dids.example.org");
  assert.equal(didScidDomain(SCID), undefined);
  assert.equal(didScidDomain("did:webvh:Qm:dids.example.org"), undefined);
});

test("the src host is guarded like a did:webvh host", () => {
  assertResolvableScidHost(URL_);
  for (const did of [`${SCID}?src=localhost:8000`, `${SCID}?src=127.0.0.1`, `${SCID}?src=intranet`, SCID]) {
    assert.throws(() => assertResolvableScidHost(did), (e) => isBlockedEndpointError(e), did);
  }
});

test("verifyDid: a did:scid DID URL resolves, with its src host as the domain", async () => {
  const asked = [];
  const r = await verifyDid(URL_, {
    resolveDid: async (did) => (asked.push(did), { didDocument: { id: SCID, alsoKnownAs: ["did:webvh:Qm:dids.example.org:alice"] } }),
  });
  assert.equal(r.method, "scid");
  assert.equal(r.domain, "dids.example.org");
  assert.equal(r.resolved, true);
  assert.deepEqual(asked, [URL_]);
});

test("verifyDid: a private src host is refused before anything is resolved", async () => {
  const r = await verifyDid(`${SCID}?src=localhost:8000`, { resolveDid: async () => assert.fail("must not resolve") });
  assert.equal(r.resolved, false);
});

test("deriveSigningKeyId: a did:scid's candidates are its document's bare key ids", async () => {
  const r = await deriveSigningKeyId(URL_, {
    resolveDid: async () => ({ didDocument: { id: SCID, authentication: [`${SCID}#key-1`] } }),
  });
  assert.deepEqual(r.candidates, [`${SCID}#key-1`]);
});

function scidSigner() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const multikey = `z${base58btcEncode(new Uint8Array([0xed, 0x01, ...publicKey]))}`;
  const doc = {
    id: SCID,
    verificationMethod: [{ id: `${SCID}#key-1`, type: "Multikey", controller: SCID, publicKeyMultibase: multikey }],
    authentication: [`${SCID}#key-1`],
  };
  return { privateKey, publicKey, doc };
}

test("a proof whose verificationMethod carries src is attributed to the bare did:scid", async () => {
  const { privateKey, publicKey, doc } = scidSigner();
  const envelope = { id: "t-1", type: "https://trusttasks.org/spec/example/0.1", issuer: SCID, recipient: "did:key:z6Mk", issuedAt: new Date().toISOString(), payload: {} };
  await signTrustTask({
    envelope,
    signing: { did: SCID, kid: `${URL_}#key-1`, privateKey, publicKey },
    proofPurpose: "authentication",
  });

  const asked = [];
  const r = await verifyTrustTaskProof(envelope, {
    expectedProofPurpose: "authentication",
    resolveDid: async (did) => (asked.push(did), doc),
  });
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.signer, SCID);
  // Resolved through the DID URL the proof named.
  assert.deepEqual(asked, [URL_]);
  assert.equal(listsMethodUnder(doc, `${URL_}#key-1`, "authentication"), true);
  assert.equal(listsMethodUnder(doc, `${URL_}#key-2`, "authentication"), false);
});
