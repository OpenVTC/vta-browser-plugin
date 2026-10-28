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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Validator } from "@cfworker/json-schema";

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
    notAfter: Math.floor(Date.now() / 1000) + 3600,
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

const SPECS = process.env.AUTH_OOB_SPECS ?? join(import.meta.dirname, "../../../../../dtgwg-trust-tasks-tf-worktrees/feat-auth-oob/specs");
const haveSpecs = existsSync(join(SPECS, "auth/oob/claim/0.1/payload.schema.json"));

/** A validator for one payload schema, with its `$ref`s resolved against the
 *  files they name. */
function validatorFor(task) {
  const load = (rel) => {
    const path = join(SPECS, rel);
    return { ...JSON.parse(readFileSync(path, "utf8")), $id: pathToFileURL(path).href };
  };
  const v = new Validator(load(`auth/oob/${task}/0.1/payload.schema.json`), "2020-12", false);
  v.addSchema(load("auth/oob/_shared/0.1/oob.schema.json"));
  v.addSchema(load("_framework/0.4/framework.schema.json"));
  return v;
}

function assertValid(task, payload) {
  const r = validatorFor(task).validate(payload);
  assert.equal(r.valid, true, `${task}: ${JSON.stringify(r.errors.slice(0, 3))}`);
}

test("every auth/oob payload the wallet emits validates against feat/auth-oob", { skip: !haveSpecs && "schemas not checked out" }, async () => {
  const kA = newApproverKey();
  assertValid("claim", buildClaim(kA, VTC, REQ).payload);
  const identify = buildIdentify(MEMBER, VTC, { requestId: REQ, approverKey: kA.did, enteredNumber: "47" });
  assertValid("identify", identify.payload);
  assertValid("prove", buildProve(kA, VTC, { ...identify, proof: {} }, REQ).payload);
  const grant = await sampleGrant();
  assertValid("grant", grant.payload);
  assertValid("grant", { ...grant.payload, decision: "decline" });
  assertValid("respond", buildRespond(kA, VTC, { ...grant, proof: {} }, REQ).payload);
  assertValid("cancel", buildCancel(kA, VTC, REQ).payload);
});

test("the schemas refuse what C9 rules out", { skip: !haveSpecs && "schemas not checked out" }, async () => {
  const grant = await sampleGrant();
  const bad = (p) => assert.equal(validatorFor("grant").validate(p).valid, false);
  bad({ ...grant.payload, notAfter: new Date().toISOString() });
  bad({ ...grant.payload, contextDigest: "a".repeat(64) });
  const id = buildIdentify(MEMBER, VTC, { requestId: REQ, approverKey: newApproverKey().did, enteredNumber: "47" });
  assert.equal(validatorFor("identify").validate({ ...id.payload, enteredNumber: 47 }).valid, false);
});
