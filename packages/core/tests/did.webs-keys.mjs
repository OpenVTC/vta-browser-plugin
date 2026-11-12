// did:webs keys, read by relationship, at every site that reads a key out of a
// DID document (VTI-KEY-003).
//
// A did:webs publishes `JsonWebKey` verification methods (`publicKeyJwk`, ids
// `<did>#<CESR key>`), and a VTA with key roles (VTI-KEY-173) keeps one key per
// relationship: an attestation key under `assertionMethod`, an operational key
// under `authentication`, and key agreement keys — P-256 before X25519 — under
// `keyAgreement`. So each site must pick its key by relationship: a key read as
// "the first Ed25519 key" or by fragment suffix is, for this document, the
// wrong key. Each site also keeps a did:webvh (Multikey) regression, and fails
// closed on what it cannot read.
//
// The party documents are vti-didcomm-js #39's (`fixtures/did-webs/README.md`);
// the VTA's Ed25519 secrets are known (seeds of 0x32 / 0x33), so its proofs here
// are real signatures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { multibase } from "@openvtc/vti-didcomm-js";

import {
  deriveSigningKeyId,
  didMethod,
  didWebsDomain,
  publicKeyOf,
  selectKey,
  verifyDid,
  x25519KeyAgreement,
} from "../dist/did/index.js";
import { signTrustTask, verifyTrustTaskProof } from "../dist/trust-tasks/index.js";
import { tspEndpointFromResolved } from "../dist/index.js";
import { assertionKeys, verifyDomainLinkage, DID_CONFIGURATION_CONTEXT } from "../dist/vtc/index.js";
import { bytesToBase64url } from "../dist/util/index.js";

const fixture = (party) => {
  const dir = new URL(`./fixtures/did-webs/${party}/`, import.meta.url);
  return {
    did: readFileSync(new URL("did.txt", dir), "utf8").trim(),
    doc: JSON.parse(readFileSync(new URL("resolved.json", dir), "utf8")),
  };
};
const VTA = fixture("vta");
const MEDIATOR = fixture("mediator");
const clone = (o) => structuredClone(o);

const ATTESTATION_SK = new Uint8Array(32).fill(0x32);
const OPERATIONAL_SK = new Uint8Array(32).fill(0x33);
const ATTESTATION_PK = ed25519.getPublicKey(ATTESTATION_SK);
const OPERATIONAL_PK = ed25519.getPublicKey(OPERATIONAL_SK);
const X25519_PK = x25519.getPublicKey(new Uint8Array(32).fill(0x31));
const ATTESTATION_KID = VTA.doc.assertionMethod[0];
const OPERATIONAL_KID = VTA.doc.authentication[0];
const hex = (u8) => Buffer.from(u8).toString("hex");
const b64url = (u8) => Buffer.from(u8).toString("base64url");

/** Rewrite the method `kid` names in a copy of `doc`. */
function withMethod(doc, kid, edit) {
  const out = clone(doc);
  out.verificationMethod = out.verificationMethod.map((vm) => (vm.id === kid ? edit({ ...vm }) : vm));
  return out;
}
/** The fail-closed rewrites every site must refuse. */
const UNREADABLE = {
  "no type": (vm) => (delete vm.type, vm),
  "an unknown type": (vm) => ({ ...vm, type: "EcdsaSecp256k1VerificationKey2019" }),
  "a Multikey type on a JWK": (vm) => ({ ...vm, type: "Multikey" }),
  "a JWK carrying d": (vm) => ({ ...vm, publicKeyJwk: { ...vm.publicKeyJwk, d: b64url(new Uint8Array(32)) } }),
  revoked: (vm) => ({ ...vm, revoked: "2026-01-01T00:00:00Z" }),
};

// ── The shared reader (did/vm-key.ts) ───────────────────────────────────────

test("did:webs: each relationship yields its own key", () => {
  const a = selectKey(VTA.doc, VTA.did, "assertionMethod", { curves: ["Ed25519"] });
  assert.equal(a.kid, ATTESTATION_KID);
  assert.deepEqual(a.publicKey, ATTESTATION_PK);
  const o = selectKey(VTA.doc, VTA.did, "authentication", { curves: ["Ed25519"] });
  assert.equal(o.kid, OPERATIONAL_KID);
  assert.deepEqual(o.publicKey, OPERATIONAL_PK);
  // The X25519 key is found by relationship and curve, past the P-256 one listed first.
  const ka = x25519KeyAgreement(VTA.doc, VTA.did);
  assert.equal(ka.kid, VTA.doc.keyAgreement[1]);
  assert.deepEqual(ka.x25519Pub, X25519_PK);
  assert.equal(selectKey(VTA.doc, VTA.did, "keyAgreement").crv, "P-256");
  // A key named under another relationship is refused, never substituted.
  assert.throws(() => selectKey(VTA.doc, VTA.did, "authentication", { kid: ATTESTATION_KID }), /lists no authentication key/);
});

test("did:webs: an unreadable method is refused", () => {
  for (const [why, edit] of Object.entries(UNREADABLE)) {
    const doc = withMethod(VTA.doc, OPERATIONAL_KID, edit);
    const vm = doc.verificationMethod.find((m) => m.id === OPERATIONAL_KID);
    assert.throws(() => publicKeyOf(vm), why);
    assert.throws(() => selectKey(doc, VTA.did, "authentication", { kid: OPERATIONAL_KID }), why);
    assert.throws(() => selectKey(doc, VTA.did, "authentication"), why);
  }
  // A curve there is no primitive for.
  const k1 = withMethod(VTA.doc, OPERATIONAL_KID, (vm) => ({
    ...vm,
    publicKeyJwk: { kty: "EC", crv: "secp256k1", x: b64url(new Uint8Array(32)), y: b64url(new Uint8Array(32)) },
  }));
  assert.throws(() => selectKey(k1, VTA.did, "authentication"));
});

// ── 1. Trust-Task proofs (trust-tasks/verify.ts) ────────────────────────────

async function signedBy(sk, kid, proofPurpose, issuer = VTA.did) {
  const envelope = { id: "urn:uuid:1", type: "https://example.org/t/0.1", issuer, payload: { a: 1 } };
  await signTrustTask({
    envelope,
    signing: { did: issuer, kid, privateKey: sk, publicKey: ed25519.getPublicKey(sk) },
    proofPurpose,
  });
  return envelope;
}
const resolverOf = (doc) => async () => clone(doc);

test("proof: a did:webs VTA's attestation key verifies for assertionMethod, its operational key for authentication", async () => {
  const resolveDid = resolverOf(VTA.doc);
  const assertion = await signedBy(ATTESTATION_SK, ATTESTATION_KID, "assertionMethod");
  const r1 = await verifyTrustTaskProof(assertion, { expectedProofPurpose: "assertionMethod", resolveDid });
  assert.equal(r1.verified, true, r1.reason);
  assert.equal(r1.signer, VTA.did);
  const auth = await signedBy(OPERATIONAL_SK, OPERATIONAL_KID, "authentication");
  const r2 = await verifyTrustTaskProof(auth, { expectedProofPurpose: "authentication", resolveDid });
  assert.equal(r2.verified, true, r2.reason);
  // With no purpose required, the proof's own purpose names the relationship.
  assert.equal((await verifyTrustTaskProof(auth, { resolveDid })).verified, true);
});

test("proof: a did:webs key is refused for the relationship it is not listed under", async () => {
  const resolveDid = resolverOf(VTA.doc);
  // The attestation key claiming to authenticate, and the operational key claiming to attest.
  const asAuth = await signedBy(ATTESTATION_SK, ATTESTATION_KID, "authentication");
  for (const opts of [{ expectedProofPurpose: "authentication", resolveDid }, { resolveDid }]) {
    const r = await verifyTrustTaskProof(asAuth, opts);
    assert.equal(r.verified, false);
    assert.match(r.reason, /not listed under authentication/);
  }
  const asAssertion = await signedBy(OPERATIONAL_SK, OPERATIONAL_KID, "assertionMethod");
  const r = await verifyTrustTaskProof(asAssertion, { expectedProofPurpose: "assertionMethod", resolveDid });
  assert.equal(r.verified, false);
  // A key-agreement key is no signing key, whichever relationship lists it.
  const ka = await signedBy(ATTESTATION_SK, VTA.doc.keyAgreement[1], "keyAgreement");
  assert.equal((await verifyTrustTaskProof(ka, { resolveDid })).verified, false);
});

test("proof: a did:webs method that cannot be read fails closed", async () => {
  const doc = await signedBy(OPERATIONAL_SK, OPERATIONAL_KID, "authentication");
  for (const [why, edit] of Object.entries(UNREADABLE)) {
    const r = await verifyTrustTaskProof(doc, {
      expectedProofPurpose: "authentication",
      resolveDid: resolverOf(withMethod(VTA.doc, OPERATIONAL_KID, edit)),
    });
    assert.equal(r.verified, false, why);
  }
});

test("proof: a did:webvh Multikey document still verifies (regression), and an id is never matched by suffix", async () => {
  const did = "did:webvh:QmScid:example.com";
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  const publicKeyMultibase = multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, pk);
  const doc = {
    id: did,
    verificationMethod: [{ id: `${did}#key-0`, type: "Multikey", controller: did, publicKeyMultibase }],
    authentication: [`${did}#key-0`],
    assertionMethod: ["#key-0"],
  };
  for (const purpose of ["authentication", "assertionMethod"]) {
    const env = await signedBy(sk, `${did}#key-0`, purpose, did);
    const r = await verifyTrustTaskProof(env, { expectedProofPurpose: purpose, resolveDid: resolverOf(doc) });
    assert.equal(r.verified, true, r.reason);
  }
  // A method whose id only *ends* in the fragment the proof names is another key.
  const elsewhere = {
    ...doc,
    verificationMethod: [{ ...doc.verificationMethod[0], id: "did:webvh:QmOther:other.example#key-0" }],
    authentication: ["#key-0"],
  };
  const env = await signedBy(sk, `${did}#key-0`, "authentication", did);
  assert.equal((await verifyTrustTaskProof(env, { resolveDid: resolverOf(elsewhere) })).verified, false);
});

// ── 2. The TSP VID signing key (vta/tsp-vid.ts) ─────────────────────────────

const okp = (crv, pub) => ({ kty: "OKP", crv, x: b64url(pub) });

test("tsp: a did:webs VID signs with its authentication (operational) key, not its attestation key", () => {
  const ep = tspEndpointFromResolved(VTA.did, okp("X25519", X25519_PK), clone(VTA.doc));
  assert.deepEqual(ep.signingPublicKey, OPERATIONAL_PK);
  assert.notDeepEqual(ep.signingPublicKey, ATTESTATION_PK);
  const med = MEDIATOR.doc.verificationMethod.find((vm) => vm.id === MEDIATOR.doc.authentication[0]);
  const medEp = tspEndpointFromResolved(MEDIATOR.did, okp("X25519", X25519_PK), clone(MEDIATOR.doc));
  assert.equal(b64url(medEp.signingPublicKey), med.publicKeyJwk.x);
});

test("tsp: a did:webs VID with no readable authentication key has no endpoint", () => {
  for (const [why, edit] of Object.entries(UNREADABLE)) {
    const doc = withMethod(VTA.doc, OPERATIONAL_KID, edit);
    assert.throws(() => tspEndpointFromResolved(VTA.did, okp("X25519", X25519_PK), doc), why);
  }
  // No authentication at all: the attestation key is not a substitute.
  const noAuth = clone(VTA.doc);
  delete noAuth.authentication;
  assert.throws(() => tspEndpointFromResolved(VTA.did, okp("X25519", X25519_PK), noAuth));
});

// ── 3. A member's directory-card keys (vtc/directory-card.ts) ───────────────

test("directory card: a did:webs member's assertion keys are exactly its attestation key", () => {
  assert.deepEqual([...assertionKeys(VTA.did, clone(VTA.doc))], [hex(ATTESTATION_PK)]);
  for (const [why, edit] of Object.entries(UNREADABLE)) {
    const doc = withMethod(VTA.doc, ATTESTATION_KID, edit);
    assert.equal(assertionKeys(VTA.did, doc).size, 0, why);
  }
});

test("directory card: a did:webvh member's Multikey assertion keys (regression)", () => {
  const did = "did:webvh:QmScid:example.com";
  const pk = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const other = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const mb = (k) => multibase.encodeMultikey(multibase.MULTICODEC.ED25519_PUB, k);
  const doc = {
    id: did,
    verificationMethod: [
      { id: "#a", type: "Multikey", controller: did, publicKeyMultibase: mb(pk) },
      { id: `${did}#auth`, type: "Multikey", controller: did, publicKeyMultibase: mb(other) },
    ],
    assertionMethod: [`${did}#a`],
    authentication: ["#auth"],
  };
  assert.deepEqual([...assertionKeys(did, doc)], [hex(pk)]);
  // An embedded assertion method counts too.
  const embedded = { ...doc, assertionMethod: [{ id: `${did}#e`, type: "Multikey", controller: did, publicKeyMultibase: mb(other) }] };
  assert.deepEqual([...assertionKeys(did, embedded)], [hex(other)]);
});

// ── 4. Domain Linkage Credentials (vtc/domain-linkage.ts) ───────────────────

const ORIGIN = "https://portal.example.org";
const NOW = 1_791_460_900_000;
const DAY = 86_400_000;
const enc = (o) => bytesToBase64url(new TextEncoder().encode(JSON.stringify(o)));
function linkageJwt(did, kid, sk) {
  const h = enc({ alg: "EdDSA", kid, typ: "JWT" });
  const p = enc({
    iss: did,
    sub: did,
    nbf: Math.floor((NOW - DAY) / 1000),
    exp: Math.floor((NOW + DAY) / 1000),
    vc: {
      "@context": ["https://www.w3.org/2018/credentials/v1", DID_CONFIGURATION_CONTEXT],
      type: ["VerifiableCredential", "DomainLinkageCredential"],
      issuer: did,
      issuanceDate: new Date(NOW - DAY).toISOString(),
      expirationDate: new Date(NOW + DAY).toISOString(),
      credentialSubject: { id: did, origin: ORIGIN },
    },
  });
  const sig = ed25519.sign(new TextEncoder().encode(`${h}.${p}`), sk);
  return `${h}.${p}.${bytesToBase64url(sig)}`;
}
const linkage = (did, doc, token) =>
  verifyDomainLinkage({
    did,
    didDocument: doc,
    origin: ORIGIN,
    now: NOW,
    fetch: async () => new Response(JSON.stringify({ "@context": DID_CONFIGURATION_CONTEXT, linked_dids: [token] })),
  });

test("domain linkage: a did:webs credential verifies with its attestation key only", async () => {
  assert.deepEqual(await linkage(VTA.did, clone(VTA.doc), linkageJwt(VTA.did, ATTESTATION_KID, ATTESTATION_SK)), {
    ok: true,
    format: "jwt",
  });
  const op = await linkage(VTA.did, clone(VTA.doc), linkageJwt(VTA.did, OPERATIONAL_KID, OPERATIONAL_SK));
  assert.equal(op.ok, false);
  assert.equal(op.detail, "a key not under assertionMethod");
});

test("domain linkage: a did:webs assertion key that cannot be read fails closed", async () => {
  const token = linkageJwt(VTA.did, ATTESTATION_KID, ATTESTATION_SK);
  for (const [why, edit] of Object.entries(UNREADABLE)) {
    const r = await linkage(VTA.did, withMethod(VTA.doc, ATTESTATION_KID, edit), token);
    assert.equal(r.ok, false, why);
    assert.match(r.detail, /^an unusable key/, why);
  }
});

// ── 5. DID methods (did/verify.ts, did/derive-signing-key.ts) ───────────────

const resolving = (doc) => {
  const calls = [];
  return { calls, resolveDid: async (d) => (calls.push(d), { didDocument: clone(doc), didResolutionMetadata: {} }) };
};

test("didMethod knows did:webs, and verifyDid judges its host before resolving", async () => {
  assert.equal(didMethod(VTA.did), "webs");
  assert.equal(didWebsDomain(VTA.did), "vta.example.com");
  assert.equal(didWebsDomain("did:webs:example.com%3A8443:people:EAid"), "example.com%3A8443");
  const ok = resolving(VTA.doc);
  const r = await verifyDid(VTA.did, { resolveDid: ok.resolveDid });
  assert.equal(r.method, "webs");
  assert.equal(r.resolved, true, r.error);
  assert.equal(r.domain, "vta.example.com");
  for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "intranet"]) {
    const blocked = resolving(VTA.doc);
    const did = `did:webs:${host}:EGmHgrgkre3Xw39L0_4q7ijQaX3eCdOFI1MizIr-Z9vT`;
    const res = await verifyDid(did, { resolveDid: blocked.resolveDid });
    assert.equal(res.resolved, false, host);
    assert.deepEqual(blocked.calls, [], `${host} reached the resolver`);
    assert.deepEqual((await deriveSigningKeyId(did, { resolveDid: blocked.resolveDid })).candidates, [], host);
    assert.deepEqual(blocked.calls, [], `${host} reached the resolver`);
  }
});

test("deriveSigningKeyId: a did:webs offers its authentication key, never any verification method", async () => {
  assert.deepEqual(await deriveSigningKeyId(VTA.did, { resolveDid: resolving(VTA.doc).resolveDid }), {
    did: VTA.did,
    candidates: [OPERATIONAL_KID],
  });
  // With neither signing relationship, nothing — not its key-agreement keys.
  const bare = clone(VTA.doc);
  delete bare.authentication;
  delete bare.assertionMethod;
  const r = await deriveSigningKeyId(VTA.did, { resolveDid: resolving(bare).resolveDid });
  assert.deepEqual(r.candidates, []);
  assert.ok(r.error);
});
