// How this browser approves sign-ins at an agent when it is not a passkey
// (`sign-in-uv.ts`), against a fake agent session and an in-memory store.
//
// Pinned: a PIN is enrolled as the VTA's `vtaPin` shape with K as the
// verifier, and only the salt and iterations are kept; the approval is a
// decision by this device with the PIN's proof over D; replacing a PIN (with
// another PIN or the phone) carries the current PIN's change proof over the
// new enrolment, and a refused change keeps the old PIN; switching from a
// passkey needs nothing; the record names the kind (and the phone).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

import {
  InMemoryKVStore,
  generateSigningIdentity,
  jcsCanonicalize,
  verifyTrustTaskProof,
  uvPinParamsKey,
} from "@openvtc/pnm-core";
import {
  enrolPhone,
  enrolPin,
  pinConsent,
  recordPrfEnrolment,
  recoverEnrolment,
  uvEnrolment,
  uvEnrolmentOrRecovered,
  PinParamsMissingError,
  uvEnrolledKey,
  PinPolicyError,
  type SignInUvDeps,
} from "../src/sign-in-uv.ts";

const VTA = "did:webvh:QmVta:vta.example.org";
const device = generateSigningIdentity();

function fake(answer: (env: { type: string; payload: Record<string, unknown> }) => unknown = () => ({})) {
  const store = new InMemoryKVStore();
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const deps: SignInUvDeps = {
    store,
    holder: async () => ({ did: device.did, signing: device }),
    session: async () => ({
      sender: {
        send: async (env: unknown) => {
          const e = env as { type: string; payload: Record<string, unknown> };
          sent.push(e);
          return answer(e);
        },
      } as never,
      holder: { did: device.did },
      service: { did: VTA },
    }),
    displayName: () => "Chromium on Linux",
    now: () => 1000,
  };
  return { deps, store, sent };
}

const b64 = (s: string) => Buffer.from(s, "base64url");
const ext = (e: { payload: Record<string, unknown> }) => e.payload.ext as Record<string, Record<string, unknown>>;

test("a new PIN: the vtaPin enrolment with K as verifier; only salt and iterations are kept", async () => {
  const { deps, store, sent } = fake();
  const { record: rec, key } = await enrolPin(deps, VTA, undefined, "246810");
  assert.deepEqual(rec, { holderDid: device.did, kind: "vtaPin", at: 1000 });
  const e = ext(sent[0]!)["org.openvtc.uv-key"]!;
  assert.equal(sent[0]!.type, "https://trusttasks.org/spec/device/heartbeat/0.2");
  assert.equal(e.kind, "vtaPin");
  assert.equal(e.iterations, 600_000);
  assert.equal(b64(e.salt as string).length, 16);
  assert.deepEqual(b64(e.verifier as string), pbkdf2Sync("246810", b64(e.salt as string), 600_000, 32, "sha256"));
  assert.deepEqual(Buffer.from(key), b64(e.verifier as string), "K is handed back for the first proof, derived once");
  assert.equal(e.hardwareBacked, false);
  assert.equal(e.biometricGated, false);
  assert.equal("org.openvtc.uv-key-change" in ext(sent[0]!), false, "nothing to replace");
  assert.deepEqual(await store.get(uvPinParamsKey(VTA)), { salt: e.salt, iterations: 600_000 });
  assert.deepEqual(await store.get(uvEnrolledKey(VTA)), rec);
  assert.deepEqual(await uvEnrolment(deps, VTA), rec);
});

test("a PIN shorter than 6 is refused before anything is sent", async () => {
  const { deps, sent } = fake();
  await assert.rejects(enrolPin(deps, VTA, undefined, "12345"), PinPolicyError);
  assert.equal(sent.length, 0);
});

test("a PIN approval: a decision by this device over D, and HMAC(K, 'org.openvtc.uv-pin/v1|' + D)", async () => {
  const { deps, sent } = fake();
  await enrolPin(deps, VTA, undefined, "246810");
  const K = b64(ext(sent[0]!)["org.openvtc.uv-key"]!.verifier as string);
  const consent = (await pinConsent(deps, VTA, undefined, VTA, "246810", "zQmD")) as { decision: never; pinProof: string };
  assert.equal(consent.pinProof, createHmac("sha256", K).update("org.openvtc.uv-pin/v1|zQmD").digest("base64url"));
  const decision = consent.decision as { issuer: string; recipient: string; payload: unknown };
  assert.equal(decision.issuer, device.did, "the device's transport key, not a UV key");
  assert.equal(decision.recipient, VTA);
  assert.deepEqual(decision.payload, { challenge: "zQmD", payloadDigest: "zQmD", decision: "approve" });
  assert.equal((await verifyTrustTaskProof(decision as never, { expectedProofPurpose: "assertionMethod" })).verified, true);
  // With K in hand (just set), the same proof without deriving again.
  const again = (await pinConsent(deps, VTA, undefined, VTA, "ignored", "zQmD", new Uint8Array(K))) as { pinProof: string };
  assert.equal(again.pinProof, consent.pinProof);
});

test("changing the PIN carries the current PIN's change proof over the new enrolment", async () => {
  const { deps, sent } = fake();
  await enrolPin(deps, VTA, undefined, "246810");
  const oldK = b64(ext(sent[0]!)["org.openvtc.uv-key"]!.verifier as string);
  await enrolPin(deps, VTA, undefined, "new passphrase", "246810");
  const next = ext(sent[1]!)["org.openvtc.uv-key"]!;
  const hex = createHash("sha256").update(jcsCanonicalize(next)).digest("hex");
  assert.deepEqual(ext(sent[1]!)["org.openvtc.uv-key-change"], {
    pinProof: createHmac("sha256", oldK).update("org.openvtc.uv-pin/v1|change|" + hex).digest("base64url"),
  });
});

test("a refused change keeps the old PIN's salt", async () => {
  let refuse = false;
  const { deps, store } = fake(() => {
    if (refuse) {
      throw Object.assign(new Error("device:uvPinWrong"), {
        details: { code: "taskFailed", details: { code: "device:uvPinWrong", attemptsRemaining: 4 } },
      });
    }
    return {};
  });
  await enrolPin(deps, VTA, undefined, "246810");
  const before = await store.get(uvPinParamsKey(VTA));
  refuse = true;
  await assert.rejects(enrolPin(deps, VTA, undefined, "999999", "000000"));
  assert.deepEqual(await store.get(uvPinParamsKey(VTA)), before);
  assert.equal((await uvEnrolment(deps, VTA))!.kind, "vtaPin");
});

test("from a PIN to the phone: the change proof, then the PIN's salt is forgotten", async () => {
  const { deps, store, sent } = fake();
  await enrolPin(deps, VTA, undefined, "246810");
  const rec = await enrolPhone(deps, VTA, undefined, "did:key:z6MkPhone", "246810");
  assert.deepEqual(rec, { holderDid: device.did, kind: "remoteApprover", approver: "did:key:z6MkPhone", at: 1000 });
  assert.deepEqual(ext(sent[1]!)["org.openvtc.uv-key"], {
    kind: "remoteApprover",
    approver: "did:key:z6MkPhone",
    hardwareBacked: false,
    biometricGated: false,
  });
  assert.ok(ext(sent[1]!)["org.openvtc.uv-key-change"]);
  assert.equal(await store.get(uvPinParamsKey(VTA)), undefined);
});

test("from a passkey to the phone or a PIN needs nothing extra", async () => {
  const { deps, sent } = fake();
  await recordPrfEnrolment(deps, VTA, device.did, "did:key:z6MkUv");
  await enrolPhone(deps, VTA, undefined, "did:key:z6MkPhone");
  assert.equal("org.openvtc.uv-key-change" in ext(sent[0]!), false);
  await enrolPin(deps, VTA, undefined, "246810");
  assert.equal("org.openvtc.uv-key-change" in ext(sent[1]!), false, "the phone is not a PIN");
});

test("a record made for another holder (onboarded again) is not this device's", async () => {
  const { deps, store } = fake();
  await store.put(uvEnrolledKey(VTA), { holderDid: "did:key:z6MkOld", kind: "vtaPin", at: 1 });
  assert.equal(await uvEnrolment(deps, VTA), undefined);
});

// ── Who may drive it: the wallet's own pages, never a content script ────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

/** The text of the `if (… === TYPE) { … }` branch that handles `type`. */
function branch(source: string, cond: string): string {
  const at = source.indexOf(cond);
  assert.ok(at >= 0, `${cond} not found`);
  return source.slice(at, at + 600);
}

test("a PIN-bearing message is not page-facing, and both hops check the sender is the wallet's own", () => {
  const protocol = src("bridge-protocol.ts");
  const list = /const PAGE_FACING_RUNTIME_TYPES = \[([^\]]*)\]/.exec(protocol)![1]!;
  assert.equal(list.includes("RUNTIME_UV_SETTINGS"), false);
  assert.equal(list.includes("RUNTIME_SIGN_IN_STEP"), false);
  assert.equal(src("content.ts").includes("vta-wallet/uv-settings"), false);
  assert.match(branch(src("background.ts"), "if (msgType === RUNTIME_UV_SETTINGS)"), /if \(!isExtensionPageSender\(sender\)\)/);
  const offscreen = src("offscreen.ts");
  assert.match(branch(offscreen, "if (msg.type === OFFSCREEN_UV_SETTINGS)"), /if \(!isExtensionContextSender\(sender\)\)/);
  assert.match(branch(offscreen, "if (msg.type === OFFSCREEN_SIGN_IN_STEP)"), /if \(!isExtensionContextSender\(sender\)\)/);
});

// ── A browser whose storage was cleared asks its agent ──────────────────────

/** A heartbeat answer carrying the VTA's summary of this device's UV key. */
const summary = (uvKey: Record<string, unknown>) => (e: { type: string; payload: Record<string, unknown> }) =>
  e.type.includes("heartbeat") && !(e.payload.ext as Record<string, unknown> | undefined)?.["org.openvtc.uv-key"]
    ? { ext: { "org.openvtc.uv-key": uvKey } }
    : {};

test("a lost PIN salt is fetched from the agent's summary, restored, and the PIN approves", async () => {
  const salt = Buffer.alloc(16, 5).toString("base64url");
  const { deps, store, sent } = fake(summary({ kind: "vtaPin", salt, iterations: 600_000, failedAttempts: 0, lockedUntil: null }));
  assert.equal(await store.get(uvPinParamsKey(VTA)), undefined);
  const consent = (await pinConsent(deps, VTA, undefined, VTA, "246810", "zQmD")) as { pinProof: string };
  const K = pbkdf2Sync("246810", Buffer.alloc(16, 5), 600_000, 32, "sha256");
  assert.equal(consent.pinProof, createHmac("sha256", K).update("org.openvtc.uv-pin/v1|zQmD").digest("base64url"));
  assert.deepEqual(await store.get(uvPinParamsKey(VTA)), { salt, iterations: 600_000 });
  assert.equal((await uvEnrolment(deps, VTA))!.kind, "vtaPin", "the record is restored too");
  assert.deepEqual(sent[0]!.payload, {}, "asked with a plain heartbeat");
});

test("no PIN at the agent either: said plainly", async () => {
  const { deps } = fake(summary({ kind: "remoteApprover", approver: "did:key:z6MkPhone", lockedUntil: null }));
  await assert.rejects(pinConsent(deps, VTA, undefined, VTA, "246810", "zQmD"), PinParamsMissingError);
});

test("no record here: the agent's summary fills it in, phone included", async () => {
  const { deps } = fake(summary({ kind: "remoteApprover", approver: "did:key:z6MkPhone", lockedUntil: null }));
  assert.deepEqual(await uvEnrolmentOrRecovered(deps, VTA), {
    holderDid: device.did,
    kind: "remoteApprover",
    approver: "did:key:z6MkPhone",
    at: 1000,
  });
  // An agent holding nothing (or a kind this wallet does not enrol) leaves it unset.
  assert.equal(await recoverEnrolment(fake(() => ({})).deps, VTA), undefined);
  assert.equal(await recoverEnrolment(fake(summary({ kind: "hardwareKey" })).deps, VTA), undefined);
});
