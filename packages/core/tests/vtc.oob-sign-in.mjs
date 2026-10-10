// The approver's side of wallet sign-in (`auth/oob/*`), against a fake
// community that signs its replies the way contract C5 says it must.
//
// What is pinned here is what the wallet refuses: a reply nobody signed, one
// signed for the wrong purpose or by a key the community's document does not
// list under `assertionMethod`, a step 1 for another request or origin, a step
// 2 that does not repeat step 1, and a document the VTA changed while signing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OOB_TYPES,
  OOB_REPLY_INVALID,
  OobRefusedError,
  selectSignInServices,
  originMatchesPortal,
  resolveCommunityDocument,
  newApproverKey,
  buildClaim,
  buildIdentify,
  buildGrant,
  sendOob,
  checkStep1,
  checkStep2,
  assertSignedAsSent,
  contextDigest,
  grantDigest,
  networkLine,
} from "../dist/vtc/index.js";
import { generateSigningIdentity, signTrustTask, decodeDigestMultibase } from "../dist/index.js";
import { uvChallengeBytes } from "../dist/vault/index.js";

const VTC = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const REQ = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const PORTAL = "https://members.example.org";
const ENDPOINT = "https://members.example.org/v1/trust-tasks";

const vtcKey = generateSigningIdentity();
const VM = `${VTC}#key-1`;
const vtcSigner = { ...vtcKey, did: VTC, kid: VM };
const vtcDoc = {
  id: VTC,
  verificationMethod: [
    { id: VM, type: "Multikey", controller: VTC, publicKeyMultibase: vtcKey.did.slice("did:key:".length) },
  ],
  assertionMethod: [VM],
  authentication: [VM],
  service: [
    { id: `${VTC}#tt-old`, type: "TrustTaskHTTPS", serviceEndpoint: "http://members.example.org/v1/trust-tasks" },
    { id: `${VTC}#portal`, type: "SignInPortal", serviceEndpoint: `${PORTAL}/members/` },
    { id: `${VTC}#tt`, type: "TrustTaskHTTPS", serviceEndpoint: ENDPOINT },
    { id: `${VTC}#tt2`, type: "TrustTaskHTTPS", serviceEndpoint: "https://other.example.org" },
  ],
};

const step1 = (over = {}) => ({
  requestId: REQ,
  service: { did: VTC, name: "Example Community" },
  origin: PORTAL,
  purpose: "login",
  decisionDeadline: Math.floor(Date.now() / 1000) + 120,
  ...over,
});

/** A community that answers one document with `reply(doc)`, signed as told. */
function community(reply, { sign = true, purpose = "assertionMethod", signer = vtcSigner } = {}) {
  const seen = [];
  const fetch = async (url, init) => {
    const doc = JSON.parse(init.body);
    seen.push({ url, doc });
    const out = reply(doc);
    if (out.error) {
      return new Response(
        JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.2", payload: { code: out.error, retryable: false } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const res = {
      id: crypto.randomUUID(),
      type: `${doc.type}#response`,
      issuer: VTC,
      recipient: doc.issuer,
      threadId: doc.id,
      issuedAt: new Date().toISOString(),
      payload: out.payload,
    };
    if (sign) await signTrustTask({ envelope: res, signing: signer, proofPurpose: purpose });
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

const sendOpts = (fetch) => ({ vtcDid: VTC, vtcDocument: vtcDoc, trustTaskEndpoint: ENDPOINT, fetch });

test("services: matched on type, first usable in document order, https only", () => {
  const r = selectSignInServices(vtcDoc);
  assert.equal(r.ok, true);
  assert.equal(r.services.portalOrigin, PORTAL);
  assert.equal(r.services.trustTaskEndpoint, ENDPOINT); // the http one is skipped
});

test("services: no portal is no-portal-service; no Trust-Task endpoint is no-common-transport", () => {
  assert.deepEqual(selectSignInServices({ service: vtcDoc.service.filter((s) => s.type !== "SignInPortal") }), {
    ok: false,
    reason: "no-portal-service",
  });
  assert.deepEqual(selectSignInServices({ service: vtcDoc.service.filter((s) => s.type !== "TrustTaskHTTPS") }), {
    ok: false,
    reason: "no-common-transport",
  });
  // An endpoint on a private name fails the host rules.
  const local = { service: [{ type: "SignInPortal", serviceEndpoint: "https://portal.local/" }, vtcDoc.service[2]] };
  assert.equal(selectSignInServices(local).ok, false);
});

test("VTI-LNK-105: the activation origin must be the portal origin exactly", () => {
  assert.equal(originMatchesPortal(PORTAL, PORTAL), true);
  assert.equal(originMatchesPortal("https://evil.example", PORTAL), false);
  assert.equal(originMatchesPortal("https://members.example.org:8443", PORTAL), false);
  assert.equal(originMatchesPortal("http://members.example.org", PORTAL), false);
  assert.equal(originMatchesPortal("", PORTAL), false);
});

test("resolution: a did:web with a port is refused before anything is fetched", async () => {
  let asked = false;
  const r = await resolveCommunityDocument("did:web:example.com%3A8443", {
    resolveDid: async () => {
      asked = true;
      return {};
    },
  });
  assert.deepEqual(r, { ok: false, reason: "did-document-unverified" });
  assert.equal(asked, false);
});

test("resolution: a resolver error or a document for another DID is unverified", async () => {
  const err = await resolveCommunityDocument(VTC, { resolveDid: async () => ({ didResolutionMetadata: { error: "invalidDid" } }) });
  assert.equal(err.ok, false);
  const other = await resolveCommunityDocument(VTC, { resolveDid: async () => ({ didDocument: { id: "did:web:x.example" } }) });
  assert.equal(other.ok, false);
  const good = await resolveCommunityDocument(VTC, { resolveDid: async () => ({ didDocument: vtcDoc }) });
  assert.equal(good.ok, true);
});

test("claim: issuer K_a, recipient the community, unique id, parentThreadId = requestId", () => {
  const kA = newApproverKey();
  const a = buildClaim(kA, VTC, REQ);
  const b = buildClaim(kA, VTC, REQ);
  assert.equal(a.type, OOB_TYPES.claim);
  assert.equal(a.issuer, kA.did);
  assert.match(kA.did, /^did:key:z6Mk/);
  assert.equal(a.recipient, VTC);
  assert.equal(a.parentThreadId, REQ);
  assert.equal(a.payload.requestId, REQ);
  assert.notEqual(a.id, b.id);
  assert.notEqual(newApproverKey().did, kA.did, "K_a is fresh every time");
});

test("sendOob: a signed, threaded step 1 is returned; the claim went out signed by K_a", async () => {
  const kA = newApproverKey();
  const c = community(() => ({ payload: step1() }));
  const reply = await sendOob(kA, buildClaim(kA, VTC, REQ), sendOpts(c.fetch), "claim");
  assert.equal(reply.payload.service.name, "Example Community");
  assert.equal(c.seen[0].url, ENDPOINT, "the endpoint exactly as published (C9)");
  assert.equal(c.seen[0].doc.proof.proofPurpose, "authentication");
  assert.equal(c.seen[0].doc.proof.verificationMethod.startsWith(kA.did), true);
  checkStep1(reply.payload, { requestId: REQ, vtcDid: VTC, portalOrigin: PORTAL, now: Date.now() });
});

test("sendOob: a refusal carries its stable code", async () => {
  const kA = newApproverKey();
  const c = community(() => ({ error: "alreadyClaimed" }));
  await assert.rejects(sendOob(kA, buildClaim(kA, VTC, REQ), sendOpts(c.fetch), "claim"), (e) => {
    assert.ok(e instanceof OobRefusedError);
    assert.equal(e.code, "alreadyClaimed");
    return true;
  });
});

test("sendOob: unsigned, wrong-purpose, or wrong-key replies are refused", async () => {
  const kA = newApproverKey();
  const reply = () => ({ payload: step1() });
  for (const opts of [
    { sign: false },
    { purpose: "authentication" },
    { signer: { ...generateSigningIdentity(), did: VTC, kid: VM } },
  ]) {
    const c = community(reply, opts);
    await assert.rejects(sendOob(kA, buildClaim(kA, VTC, REQ), sendOpts(c.fetch), "claim"), (e) => e.code === OOB_REPLY_INVALID);
  }
});

test("sendOob: a key listed only under authentication is not the community's assertion", async () => {
  const kA = newApproverKey();
  const c = community(() => ({ payload: step1() }));
  const doc = { ...vtcDoc, assertionMethod: [] };
  await assert.rejects(
    sendOob(kA, buildClaim(kA, VTC, REQ), { ...sendOpts(c.fetch), vtcDocument: doc }, "claim"),
    (e) => e.code === OOB_REPLY_INVALID,
  );
});

test("C9: the endpoint is used exactly as published, trailing slash and all", () => {
  const doc = { service: [vtcDoc.service[1], { type: "TrustTaskHTTPS", serviceEndpoint: "https://h.example/api/trust-tasks/" }] };
  assert.equal(selectSignInServices(doc).services.trustTaskEndpoint, "https://h.example/api/trust-tasks/");
});

test("C9: a deadline is integer epoch seconds only", () => {
  const want = { requestId: REQ, vtcDid: VTC, portalOrigin: PORTAL, now: Date.now() };
  checkStep1(step1(), want);
  assert.throws(() => checkStep1(step1({ decisionDeadline: new Date(Date.now() + 60_000).toISOString() }), want));
});

test("step 1 checks", () => {
  const want = { requestId: REQ, vtcDid: VTC, portalOrigin: PORTAL, now: Date.now() };
  for (const over of [
    { requestId: "AAAAAAAAAAAAAAAAAAAAAA" },
    { service: { did: "did:web:evil.example", name: "x" } },
    { purpose: "step-up" },
    { origin: "https://evil.example" },
    { decisionDeadline: Math.floor(Date.now() / 1000) - 1 },
    { decisionDeadline: new Date(Date.now() - 1000).toISOString() },
    { decisionDeadline: "soon" },
  ]) {
    assert.throws(() => checkStep1(step1(over), want), (e) => e.code === OOB_REPLY_INVALID, JSON.stringify(over));
  }
});

test("step 2 must repeat step 1, carry a did:key session key and name the chosen identity", () => {
  const s1 = step1();
  const member = "did:webvh:Qm:members.example.org:alice";
  const s2 = {
    ...s1,
    sessionKey: generateSigningIdentity().did,
    requester: { location: "Sydney, Australia", browser: "Chrome", os: "macOS", createdAt: new Date().toISOString(), sameNetwork: "unknown" },
    identifiedAs: member,
  };
  checkStep2(s2, s1, member);
  assert.throws(() => checkStep2({ ...s2, origin: "https://evil.example" }, s1, member));
  assert.throws(() => checkStep2({ ...s2, sessionKey: "did:web:x.example" }, s1, member));
  assert.throws(() => checkStep2({ ...s2, identifiedAs: "did:web:bob.example" }, s1, member));
});

test("the VTA's signature must be over the document sent, for the type's purpose", () => {
  const unsigned = buildIdentify("did:web:alice.example", VTC, { requestId: REQ, approverKey: "did:key:z6Mk", enteredNumber: "47" });
  const signed = { ...unsigned, proof: { proofPurpose: "authentication" } };
  assert.equal(assertSignedAsSent(unsigned, signed, "authentication"), signed);
  assert.throws(() => assertSignedAsSent(unsigned, { ...unsigned }, "authentication"));
  assert.throws(() => assertSignedAsSent(unsigned, { ...signed, payload: { ...unsigned.payload, enteredNumber: "48" } }, "authentication"));
  assert.throws(() => assertSignedAsSent(unsigned, { ...unsigned, proof: { proofPurpose: "assertionMethod" } }, "authentication"));
});

test("identify refuses anything but two digits", () => {
  assert.throws(() => buildIdentify("did:web:a.example", VTC, { requestId: REQ, approverKey: "did:key:z6Mk", enteredNumber: "7" }));
  assert.throws(() => buildIdentify("did:web:a.example", VTC, { requestId: REQ, approverKey: "did:key:z6Mk", enteredNumber: "4a" }));
});

test("digests: contextDigest covers the proof; the grant digest excludes one; the UV challenge is the 32 hash bytes", async () => {
  const doc = { id: "1", type: "t", issuer: VTC, recipient: "x", issuedAt: "now", payload: {} };
  const signedA = { ...doc, proof: { proofValue: "zA" } };
  const signedB = { ...doc, proof: { proofValue: "zB" } };
  assert.notEqual(await contextDigest(signedA), await contextDigest(signedB));
  const grant = buildGrant("did:web:a.example", VTC, {
    requestId: REQ,
    decision: "approve",
    sessionKey: "did:key:z6Mk",
    approverKey: "did:key:z6Mk",
    origin: PORTAL,
    contextDigest: await contextDigest(signedA),
    notAfter: Math.floor(Date.now() / 1000) + 3600,
  });
  const d = await grantDigest(grant);
  assert.equal(d, await grantDigest({ ...grant, proof: { x: 1 } }));
  assert.match(d, /^z/);
  assert.equal(decodeDigestMultibase(d).length, 32);
  // C9: the WebAuthn challenge is the UTF-8 bytes of the string D.
  assert.equal(new TextDecoder().decode(uvChallengeBytes(d)), d);
});

test("the network line: true, false or \"unknown\" (C9)", () => {
  assert.equal(networkLine(true), "same");
  assert.equal(networkLine(false), "different");
  assert.equal(networkLine("unknown"), "unknown");
});
