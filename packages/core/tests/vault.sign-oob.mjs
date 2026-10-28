// The wire shapes the VTA reads for wallet sign-in (verifiable-trust-
// infrastructure `feat/oob-sign-in-vta`, contract C9), and the `auth/oob`
// payloads checked against the `dtgwg-trust-tasks-tf` `feat/auth-oob` schemas.
//
// The schema checks read the schema files from a sibling checkout when one is
// present and are skipped otherwise: the schemas are not published yet. When
// `@openvtc/trust-tasks` ships `AuthOob*_v0_1`, replace this with the generated
// validators.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgainstSchema, describeViolations } from "../dist/trust-tasks/validate.js";

import {
  EXT_UV_CONSENT,
  EXT_UV_KEY,
  buildUvConsentDecision,
  vaultSignGrant,
  vaultSignIdentify,
  enrolUvKey,
  prfSealedUvKeyEnrolment,
  uvChallengeBytes,
} from "../dist/vault/index.js";
import { generateSigningIdentity, verifyTrustTaskProof } from "../dist/index.js";
import {
  newApproverKey,
  buildClaim,
  buildIdentify,
  buildProve,
  buildGrant,
  buildRespond,
  buildCancel,
  grantDigest,
  contextDigest,
} from "../dist/vtc/index.js";

const VTA = "did:webvh:QmVta:vta.example.org";
const VTC = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const MEMBER = "did:webvh:QmAlice:members.example.org:alice";
const REQ = "Hk2pQ9xV4mT7rW1sZ8yN3A";

/** A channel that records what it was asked to send and answers `reply`. */
function recorder(reply) {
  const sent = [];
  return {
    sent,
    send: async (envelope) => {
      sent.push(envelope);
      return reply(envelope);
    },
  };
}

const holder = { did: "did:key:z6MkHolder" };
const service = { did: VTA };

async function sampleGrant() {
  const kA = newApproverKey();
  return buildGrant(MEMBER, VTC, {
    requestId: REQ,
    decision: "approve",
    sessionKey: newApproverKey().did,
    approverKey: kA.did,
    origin: "https://members.example.org",
    contextDigest: await contextDigest({ x: 1 }),
    sessionEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

test("the grant envelope carries framework members only — no ext", async () => {
  const g = await sampleGrant();
  const allowed = ["id", "type", "issuer", "recipient", "issuedAt", "expiresAt", "threadId", "parentThreadId", "payload"];
  for (const k of Object.keys(g)) assert.ok(allowed.includes(k), k);
  assert.ok(Math.abs(Date.parse(g.issuedAt) - Date.now()) < 300_000);
});

test("the UV decision: task-consent/decision/0.2 to the VTA, by the UV key, challenge = payloadDigest = D, no evidence", async () => {
  const uvKey = generateSigningIdentity();
  const D = await grantDigest(await sampleGrant());
  const decision = await buildUvConsentDecision({ uvKey, vtaDid: VTA, payloadDigest: D });
  assert.equal(decision.type, "https://trusttasks.org/spec/task-consent/decision/0.2");
  assert.equal(decision.issuer, uvKey.did);
  assert.equal(decision.recipient, VTA);
  assert.deepEqual(decision.payload, { challenge: D, payloadDigest: D, decision: "approve" });
  const v = await verifyTrustTaskProof(decision, { expectedProofPurpose: "assertionMethod" });
  assert.equal(v.verified, true);
  assert.equal(v.signer, uvKey.did);
});

test("C9: the passkey ceremony is bound to the UTF-8 bytes of D, not the hash", async () => {
  const D = await grantDigest(await sampleGrant());
  assert.deepEqual(uvChallengeBytes(D), new TextEncoder().encode(D));
  assert.match(D, /^zQm/);
});

test("vault/sign-trust-task/0.2 for a grant: {entryId, unsignedEnvelope, ext[org.openvtc.uv-consent].decision}", async () => {
  const grant = await sampleGrant();
  const decision = { type: "https://trusttasks.org/spec/task-consent/decision/0.2" };
  const ch = recorder(() => ({ signedEnvelope: { ...grant, proof: {} } }));
  await vaultSignGrant(ch, { holder, service, entryId: "e1", unsignedGrant: grant, consent: { decision } });
  assert.equal(ch.sent[0].type, "https://trusttasks.org/spec/vault/sign-trust-task/0.2");
  assert.deepEqual(ch.sent[0].payload, { entryId: "e1", unsignedEnvelope: grant, ext: { [EXT_UV_CONSENT]: { decision } } });
  assert.equal(EXT_UV_CONSENT, "org.openvtc.uv-consent");

  // A decline carries no decision, and no ext.
  const ch2 = recorder(() => ({ signedEnvelope: {} }));
  await vaultSignGrant(ch2, { holder, service, entryId: "e1", unsignedGrant: grant });
  assert.deepEqual(Object.keys(ch2.sent[0].payload).sort(), ["entryId", "unsignedEnvelope"]);
});

test("identify goes through vault/sign-trust-task/0.2 as {entryId, unsignedEnvelope}", async () => {
  const id = buildIdentify(MEMBER, VTC, { requestId: REQ, approverKey: newApproverKey().did, enteredNumber: "07" });
  const ch = recorder(() => ({ signedEnvelope: { ...id, proof: {} } }));
  await vaultSignIdentify(ch, { holder, service, entryId: "e1", unsignedIdentify: id });
  assert.deepEqual(ch.sent[0].payload, { entryId: "e1", unsignedEnvelope: id });
  assert.equal(typeof id.payload.enteredNumber, "string");
});

const ENROLMENT = prfSealedUvKeyEnrolment("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK");

test("the UV-key enrolment is the VTA's prfSealedKey shape, never claiming hardware", () => {
  assert.deepEqual(ENROLMENT, {
    kind: "prfSealedKey",
    did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    hardwareBacked: false,
    biometricGated: false,
  });
});

test("UV-key enrolment: device/heartbeat/0.3 with payload.ext[org.openvtc.uv-key]", async () => {
  const ch = recorder(() => ({ respondedAt: new Date().toISOString() }));
  await enrolUvKey(ch, { holder, service, enrolment: ENROLMENT, displayName: "Chrome" });
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].type, "https://trusttasks.org/spec/device/heartbeat/0.3");
  assert.equal(ch.sent[0].issuer, holder.did);
  assert.deepEqual(ch.sent[0].payload, { ext: { [EXT_UV_KEY]: ENROLMENT } });
});

test("UV-key enrolment of an unregistered device falls back to device/register/0.2 on not_found", async () => {
  const ch = recorder((env) => {
    if (env.type.includes("heartbeat")) {
      throw Object.assign(new Error("device/heartbeat:notRegistered"), {
        details: { code: "taskFailed", details: { reason: "not_found" } },
      });
    }
    return { binding: {} };
  });
  await enrolUvKey(ch, { holder, service, enrolment: ENROLMENT, displayName: "Chrome" });
  assert.equal(ch.sent[1].type, "https://trusttasks.org/spec/device/register/0.2");
  assert.deepEqual(ch.sent[1].payload, {
    consumerKind: { kind: "companion", formFactor: "browser" },
    displayName: "Chrome",
    ext: { [EXT_UV_KEY]: ENROLMENT },
  });
  // Any other refusal is not papered over with a registration.
  const other = recorder(() => {
    throw Object.assign(new Error("disabled"), { details: { details: { reason: "forbidden" } } });
  });
  await assert.rejects(enrolUvKey(other, { holder, service, enrolment: ENROLMENT, displayName: "Chrome" }));
  assert.equal(other.sent.length, 1);
});

// The schemas are the ones this package pins and generates (`src/specs/`), so
// these run everywhere rather than skipping when a sibling checkout is absent.
const OOB_VERSIONS = { claim: "0.2", identify: "0.1", prove: "0.3", grant: "0.3", respond: "0.3", cancel: "0.1" };

async function schemaFor(task) {
  return (await import(`../dist/specs/auth/oob/${task}/${OOB_VERSIONS[task]}/payload.js`)).PAYLOAD_SCHEMA;
}

async function assertValid(task, payload) {
  const r = validateAgainstSchema(await schemaFor(task), payload);
  assert.equal(r.valid, true, r.valid ? "" : `${task}: ${describeViolations(r.violations)}`);
}

test("every auth/oob payload the wallet emits validates against the pinned schema", async () => {
  const kA = newApproverKey();
  await assertValid("claim", buildClaim(kA, VTC, REQ).payload);
  const identify = buildIdentify(MEMBER, VTC, { requestId: REQ, approverKey: kA.did, enteredNumber: "47" });
  await assertValid("identify", identify.payload);
  await assertValid("prove", buildProve(kA, VTC, { ...identify, proof: {} }, REQ).payload);
  const grant = await sampleGrant();
  await assertValid("grant", grant.payload);
  await assertValid("grant", { ...grant.payload, decision: "decline" });
  await assertValid("respond", buildRespond(kA, VTC, { ...grant, proof: {} }, REQ).payload);
  await assertValid("cancel", buildCancel(kA, VTC, REQ).payload);
});

test("the schemas refuse what grant 0.3 rules out", async () => {
  const grant = await sampleGrant();
  const schema = await schemaFor("grant");
  const bad = (p) => assert.equal(validateAgainstSchema(schema, p).valid, false, JSON.stringify(p));
  // The 0.2 bound: epoch seconds under `notAfter`.
  const { sessionEndsAt: _, ...rest } = grant.payload;
  bad({ ...rest, notAfter: Math.floor(Date.now() / 1000) + 3600 });
  bad({ ...grant.payload, contextDigest: "a".repeat(64) });
  const id = buildIdentify(MEMBER, VTC, { requestId: REQ, approverKey: newApproverKey().did, enteredNumber: "47" });
  assert.equal(validateAgainstSchema(await schemaFor("identify"), { ...id.payload, enteredNumber: 47 }).valid, false);
});
