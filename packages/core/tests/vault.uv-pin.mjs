// Sign-in approval without a PRF passkey: the `vtaPin` and `remoteApprover`
// UV key kinds, on the wire contract the VTA checks
// (`vta-service/src/operations/vault/oob_sign_in.rs::verify_uv_decision`).
//
// Pinned: K is PBKDF2-HMAC-SHA256 over the NFC-normalised PIN (checked against
// Node's own PBKDF2); the proof strings; the enrolment shapes; what goes in
// `ext["org.openvtc.uv-consent"]` for each kind; the change proof over the JCS
// of the new enrolment; and the refusal details the window shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

import {
  EXT_UV_CONSENT,
  EXT_UV_KEY,
  EXT_UV_KEY_CHANGE,
  EXT_UV_APPROVERS,
  readUvKeySummary,
  UV_PIN_ITERATIONS,
  buildUvConsentDecision,
  derivePinKey,
  deviceUvRefusal,
  enrolUvKey,
  listUvApprovers,
  pinChangeMessage,
  pinChangeProof,
  pinProof,
  pinProofMessage,
  remoteApproverUvKeyEnrolment,
  vaultOobRefusal,
  vaultOobRefusalDetail,
  vaultSignGrant,
  vtaPinUvKeyEnrolment,
  OOB_UV_PIN_WRONG,
  OOB_UV_LOCKED,
  OOB_UV_PENDING,
  OOB_UV_DECLINED,
  OOB_UV_EXPIRED,
} from "../dist/vault/index.js";
import { InMemoryKVStore, readUvPinParams, writeUvPinParams, uvPinParamsKey } from "../dist/store/index.js";
import { generateSigningIdentity, jcsCanonicalize, verifyTrustTaskProof } from "../dist/index.js";

const VTA = "did:webvh:QmVta:vta.example.org";
const holder = { did: "did:key:z6MkHolder" };
const service = { did: VTA };
const D = "zQmTestDigest";
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function recorder(reply) {
  const sent = [];
  return {
    sent,
    send: async (envelope, opts) => {
      sent.push({ envelope, opts });
      return reply(envelope);
    },
  };
}

test("K is PBKDF2-HMAC-SHA256 over the NFC PIN, 32 bytes, as Node computes it", async () => {
  const salt = new Uint8Array(16).map((_, i) => i + 1);
  const k = await derivePinKey("246810", salt, 1000);
  assert.equal(k.length, 32);
  assert.deepEqual(Buffer.from(k), pbkdf2Sync(Buffer.from("246810", "utf8"), Buffer.from(salt), 1000, 32, "sha256"));
  // The contract's iteration count, once.
  const full = await derivePinKey("correct horse", salt, UV_PIN_ITERATIONS);
  assert.equal(UV_PIN_ITERATIONS, 600_000);
  assert.deepEqual(Buffer.from(full), pbkdf2Sync("correct horse", Buffer.from(salt), 600_000, 32, "sha256"));
});

test("the PIN is NFC-normalised first: a decomposed é derives the composed one's key", async () => {
  const salt = new Uint8Array(16).fill(9);
  const composed = await derivePinKey("café-pin", salt, 1000);
  const decomposed = await derivePinKey("café-pin", salt, 1000);
  assert.deepEqual(composed, decomposed);
  assert.deepEqual(Buffer.from(composed), pbkdf2Sync(Buffer.from("café-pin", "utf8"), Buffer.from(salt), 1000, 32, "sha256"));
});

test("pinProof: base64url HMAC-SHA256(K, 'org.openvtc.uv-pin/v1|' + D)", async () => {
  const K = new Uint8Array(32).fill(3);
  assert.equal(pinProofMessage(D), "org.openvtc.uv-pin/v1|" + D);
  const want = createHmac("sha256", Buffer.from(K)).update("org.openvtc.uv-pin/v1|" + D, "utf8").digest("base64url");
  assert.equal(await pinProof(K, D), want);
});

test("pinChangeProof: HMAC over 'org.openvtc.uv-pin/v1|change|' + sha256hex(JCS(new enrolment))", async () => {
  const K = new Uint8Array(32).fill(4);
  const next = remoteApproverUvKeyEnrolment("did:key:z6MkPhone");
  const hex = createHash("sha256").update(jcsCanonicalize(next), "utf8").digest("hex");
  assert.equal(await pinChangeMessage(next), "org.openvtc.uv-pin/v1|change|" + hex);
  // Key order does not change it: JCS sorts.
  const reordered = { biometricGated: false, hardwareBacked: false, approver: "did:key:z6MkPhone", kind: "remoteApprover" };
  assert.equal(await pinChangeMessage(reordered), "org.openvtc.uv-pin/v1|change|" + hex);
  const want = createHmac("sha256", Buffer.from(K)).update("org.openvtc.uv-pin/v1|change|" + hex, "utf8").digest("base64url");
  assert.equal(await pinChangeProof(K, next), want);
});

test("the vtaPin and remoteApprover enrolments are the VTA's shapes, never claiming hardware", () => {
  const salt = new Uint8Array(16).fill(1);
  const verifier = new Uint8Array(32).fill(2);
  assert.deepEqual(vtaPinUvKeyEnrolment({ salt, iterations: 600_000, verifier }), {
    kind: "vtaPin",
    salt: b64u(salt),
    iterations: 600_000,
    verifier: b64u(verifier),
    hardwareBacked: false,
    biometricGated: false,
  });
  assert.deepEqual(remoteApproverUvKeyEnrolment("did:key:z6MkPhone"), {
    kind: "remoteApprover",
    approver: "did:key:z6MkPhone",
    hardwareBacked: false,
    biometricGated: false,
  });
});

test("vtaPin approval: the decision by the device's transport key, and the PIN proof beside it", async () => {
  const device = generateSigningIdentity();
  const decision = await buildUvConsentDecision({ uvKey: device, vtaDid: VTA, payloadDigest: D });
  assert.equal(decision.issuer, device.did);
  assert.deepEqual(decision.payload, { challenge: D, payloadDigest: D, decision: "approve" });
  assert.equal("evidence" in decision.payload, false);
  const v = await verifyTrustTaskProof(decision, { expectedProofPurpose: "assertionMethod" });
  assert.equal(v.signer, device.did);

  const ch = recorder(() => ({ signedEnvelope: {} }));
  const grant = { type: "https://trusttasks.org/spec/auth/oob/grant/0.1", payload: {} };
  await vaultSignGrant(ch, { holder, service, entryId: "e1", unsignedGrant: grant, consent: { decision, pinProof: "proof" } });
  assert.deepEqual(ch.sent[0].envelope.payload, {
    entryId: "e1",
    unsignedEnvelope: grant,
    ext: { [EXT_UV_CONSENT]: { decision, pinProof: "proof" } },
  });
});

test("remoteApprover approval: {remote: true} and no decision", async () => {
  const ch = recorder(() => ({ signedEnvelope: {} }));
  const grant = { type: "https://trusttasks.org/spec/auth/oob/grant/0.1", payload: {} };
  await vaultSignGrant(ch, { holder, service, entryId: "e1", unsignedGrant: grant, consent: { remote: true } });
  assert.deepEqual(ch.sent[0].envelope.payload.ext, { [EXT_UV_CONSENT]: { remote: true } });
});

const refusal = (details) =>
  Object.assign(new Error(`vault/sign-trust-task:${details.code}`), { details: { code: "taskFailed", details } });

test("the UV refusals and what the VTA says beside them", () => {
  assert.deepEqual(vaultOobRefusalDetail(refusal({ code: OOB_UV_PIN_WRONG, attemptsRemaining: 3 })), {
    code: "oobUvPinWrong",
    attemptsRemaining: 3,
  });
  // The guess that imposes the lock says so.
  assert.deepEqual(vaultOobRefusalDetail(refusal({ code: OOB_UV_PIN_WRONG, attemptsRemaining: 0, lockedUntil: 1_800_000_900 })), {
    code: "oobUvPinWrong",
    attemptsRemaining: 0,
    lockedUntil: 1_800_000_900,
  });
  assert.deepEqual(vaultOobRefusalDetail(refusal({ code: OOB_UV_LOCKED, lockedUntil: 1_800_000_000 })), {
    code: "oobUvLocked",
    lockedUntil: 1_800_000_000,
  });
  assert.deepEqual(vaultOobRefusalDetail(refusal({ code: OOB_UV_PENDING, matchCode: "42", expiresAt: 1_800_000_120 })), {
    code: "oobUvPending",
    matchCode: "42",
    expiresAt: 1_800_000_120,
  });
  assert.equal(vaultOobRefusal(refusal({ code: OOB_UV_DECLINED })), "oobUvDeclined");
  assert.equal(vaultOobRefusal(refusal({ code: OOB_UV_EXPIRED })), "oobUvExpired");
  // A field of the wrong type is dropped, not passed on.
  assert.deepEqual(vaultOobRefusalDetail(refusal({ code: OOB_UV_PIN_WRONG, attemptsRemaining: "3" })), { code: "oobUvPinWrong" });
  assert.equal(vaultOobRefusalDetail(new Error("x")), undefined);
});

test("device/heartbeat's UV key change refusals are read by their code's last segment", () => {
  const e = (code, extra = {}) => Object.assign(new Error(code), { details: { code: "taskFailed", details: { code, ...extra } } });
  assert.deepEqual(deviceUvRefusal(e("device:uvPinWrong", { attemptsRemaining: 2 })), { code: "uvPinWrong", attemptsRemaining: 2 });
  assert.deepEqual(deviceUvRefusal(e("device:uvKeyLocked", { lockedUntil: 5 })), { code: "uvKeyLocked", lockedUntil: 5 });
  assert.deepEqual(deviceUvRefusal(e("device:uvKeyChangeProofRequired")), { code: "uvKeyChangeProofRequired" });
  assert.deepEqual(deviceUvRefusal(e("device:uvKeyChangeProofInvalid")), { code: "uvKeyChangeProofInvalid" });
  assert.equal(deviceUvRefusal(e("device:somethingElse")), undefined);
  // This one is only in the message.
  const notPermitted = Object.assign(new Error("device/heartbeat refused: uvApproverNotPermitted: not designated"), {
    details: { code: "taskFailed", details: {} },
  });
  assert.deepEqual(deviceUvRefusal(notPermitted), { code: "uvApproverNotPermitted" });
});

test("enrolling over a vtaPin key carries the change proof; a register never does", async () => {
  const next = remoteApproverUvKeyEnrolment("did:key:z6MkPhone");
  const ch = recorder(() => ({}));
  await enrolUvKey(ch, { holder, service, enrolment: next, displayName: "Chrome", changeProof: "p" });
  assert.deepEqual(ch.sent[0].envelope.payload, {
    ext: { [EXT_UV_KEY]: next, [EXT_UV_KEY_CHANGE]: { pinProof: "p" } },
  });
  const unregistered = recorder((env) => {
    if (env.type.includes("heartbeat")) {
      throw Object.assign(new Error("not registered"), { details: { details: { reason: "not_found" } } });
    }
    return {};
  });
  await enrolUvKey(unregistered, { holder, service, enrolment: next, displayName: "Chrome", changeProof: "p" });
  assert.deepEqual(unregistered.sent[1].envelope.payload.ext, { [EXT_UV_KEY]: next });
});

test("the approver listing is a heartbeat with ext[org.openvtc.uv-approvers] = {}, read from the response's ext", async () => {
  assert.equal(EXT_UV_APPROVERS, "org.openvtc.uv-approvers");
  const ch = recorder(() => ({
    respondedAt: new Date().toISOString(),
    ext: {
      "org.openvtc.uv-approvers": {
        approvers: [
          { did: "did:key:z6MkPhone", displayName: "Alice's iPhone", formFactor: "mobile" },
          { did: 7 },
          { displayName: "no DID" },
          { did: "did:key:z6MkTablet" },
        ],
      },
    },
  }));
  const list = await listUvApprovers(ch, { holder, service });
  assert.equal(ch.sent[0].envelope.type, "https://trusttasks.org/spec/device/heartbeat/0.3");
  assert.equal(ch.sent[0].envelope.issuer, holder.did);
  assert.deepEqual(ch.sent[0].envelope.payload, { ext: { "org.openvtc.uv-approvers": {} } });
  assert.deepEqual(list, [
    { did: "did:key:z6MkPhone", displayName: "Alice's iPhone", formFactor: "mobile" },
    { did: "did:key:z6MkTablet" },
  ]);
  // A response with no listing is an empty one.
  assert.deepEqual(await listUvApprovers(recorder(() => ({})), { holder, service }), []);
});

test("the UV key summary on a heartbeat response: kind, salt, iterations, lock; null lock is no lock", async () => {
  const ch = recorder(() => ({
    ext: {
      "org.openvtc.uv-key": { kind: "vtaPin", salt: "c2FsdHNhbHRzYWx0c2FsdA", iterations: 600000, failedAttempts: 2, lockedUntil: null },
    },
  }));
  assert.deepEqual(await readUvKeySummary(ch, { holder, service }), {
    kind: "vtaPin",
    salt: "c2FsdHNhbHRzYWx0c2FsdA",
    iterations: 600000,
    failedAttempts: 2,
  });
  assert.deepEqual(ch.sent[0].envelope.payload, {}, "a plain heartbeat");
  const phone = recorder(() => ({ ext: { "org.openvtc.uv-key": { kind: "remoteApprover", approver: "did:key:z6MkPhone", lockedUntil: null } } }));
  assert.deepEqual(await readUvKeySummary(phone, { holder, service }), { kind: "remoteApprover", approver: "did:key:z6MkPhone" });
  assert.equal(await readUvKeySummary(recorder(() => ({})), { holder, service }), undefined);
});

test("the wallet keeps the salt and iterations per VTA, and nothing else", async () => {
  const store = new InMemoryKVStore();
  await writeUvPinParams(store, VTA, { salt: "c2FsdA", iterations: 600_000, pin: "nope", key: "nope" });
  assert.deepEqual(await store.get(uvPinParamsKey(VTA)), { salt: "c2FsdA", iterations: 600_000 });
  assert.equal(uvPinParamsKey(VTA), "pnm/uv-pin/v1/" + VTA);
  assert.deepEqual(await readUvPinParams(store, VTA), { salt: "c2FsdA", iterations: 600_000 });
  assert.equal(await readUvPinParams(store, "did:web:other"), undefined);
});
