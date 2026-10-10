// Wallet sign-in from a trigger link, end to end against a fake community and
// a fake VTA (contract C3, base design §14).
//
// Pinned: nothing goes to the community before Continue (and nothing at all to
// one the wallet does not know, or from a page that is not the portal); the
// claim is the first message and carries K_a; the number and the identify go
// in prove; the grant is signed only with the passkey's decision over its
// digest; a decline needs none; closing the window cancels a held claim.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSigningIdentity, signTrustTask, bytesToBase64url } from "@openvtc/pnm-core";
import {
  SignInFlows,
  ALREADY_CLAIMED_MESSAGE,
  VTA_REFUSAL_MESSAGES,
  type SignInVaultEntry,
} from "../src/sign-in-flows.ts";

const VTC = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const PORTAL = "https://members.example.org";
// The published `TrustTaskHTTPS` endpoint is the base; documents go to
// `<base>/trust-tasks` (HTTPS binding 0.2 §6).
const BASE = "https://members.example.org/v1";
const ENDPOINT = `${BASE}/trust-tasks`;
const ID = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const NOW = 1_791_460_900_000;
const LINK = `https://link.trustoverip.org/t#_from=${VTC}&_id=${ID}&_exp=${Math.floor(NOW / 1000) + 100}&_type=/vti/flow/sign-in/0.1`;
const ALICE = "did:webvh:QmAlice:members.example.org:alice";

const vtcKey = generateSigningIdentity();
const VM = `${VTC}#key-1`;
const vtcDoc = {
  id: VTC,
  verificationMethod: [{ id: VM, type: "Multikey", controller: VTC, publicKeyMultibase: vtcKey.did.slice(8) }],
  assertionMethod: [VM],
  service: [
    { id: `${VTC}#sign-in-portal`, type: "SignInPortal", serviceEndpoint: `${PORTAL}/members/` },
    { id: `${VTC}#tt`, type: "TrustTaskHTTPS", serviceEndpoint: BASE },
  ],
};

const entries: SignInVaultEntry[] = [
  { id: "e-other", label: "Elsewhere", secretKind: "didSelfIssued", principalDid: "did:web:x.example", targets: [{ kind: "did", did: "did:web:other.example" }] },
  { id: "e-pw", label: "Example Community", secretKind: "password", principalDid: ALICE, targets: [{ kind: "did", did: VTC }] },
  { id: "e-alice", label: "Example Community", secretKind: "didSelfIssued", principalDid: ALICE, targets: [{ kind: "did", did: VTC }] },
];

interface World {
  flows: SignInFlows;
  sent: Array<{ type: string; doc: Record<string, unknown> }>;
  vtaCalls: Array<{ what: string; decision?: unknown }>;
}

/** What the member's VTA refuses a sign-in document with (`details.details.code`). */
const vtaRefusal = (code: string) =>
  Object.assign(new Error(`vault/sign-trust-task:${code}`), { details: { code: "taskFailed", details: { code } } });

function world(
  opts: {
    name?: string;
    claimError?: string;
    known?: SignInVaultEntry[];
    identifyError?: unknown;
    uvCredentialId?: string;
    /** The community's `ext` on step 1, repeated in step 2. */
    ext?: Record<string, unknown>;
  } = {},
): World {
  const sent: World["sent"] = [];
  const vtaCalls: World["vtaCalls"] = [];
  const sessionKey = generateSigningIdentity().did;
  const step1 = {
    requestId: ID,
    service: { did: VTC, name: opts.name ?? "Example Community" },
    origin: PORTAL,
    purpose: "login",
    decisionDeadline: Math.floor(NOW / 1000) + 120,
    ...(opts.ext ? { ext: opts.ext } : {}),
  };
  const fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, ENDPOINT, "posted to <base>/trust-tasks (binding 0.2 §6)");
    const doc = JSON.parse(String(init.body));
    const type = String(doc.type).replace("https://trusttasks.org/spec/auth/oob/", "").replace("/0.1", "");
    sent.push({ type, doc });
    if (type === "claim" && opts.claimError) {
      return new Response(
        JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.2", payload: { code: opts.claimError, retryable: false } }),
        { status: 409 },
      );
    }
    const payload =
      type === "claim"
        ? step1
        : type === "prove"
          ? {
              ...step1,
              sessionKey,
              requester: { location: "Sydney, Australia", browser: "Chrome", os: "macOS", createdAt: new Date(NOW).toISOString(), sameNetwork: true },
              identifiedAs: doc.payload.identify.issuer,
            }
          : { status: type === "cancel" ? "cancelled" : "approved" };
    const res = { id: crypto.randomUUID(), type: `${doc.type}#response`, issuer: VTC, recipient: doc.issuer, threadId: doc.id, issuedAt: new Date().toISOString(), payload };
    await signTrustTask({ envelope: res, signing: { ...vtcKey, did: VTC, kid: VM }, proofPurpose: "assertionMethod" });
    return new Response(JSON.stringify(res), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  const flows = new SignInFlows({
    now: () => NOW,
    grantLifetimeMs: 3_600_000,
    fetch,
    resolveDid: async (did) => {
      assert.equal(did, VTC);
      return { didDocument: vtcDoc };
    },
    vta: () => ({
      ensureDevice: async () => {
        vtaCalls.push({ what: "ensure-device" });
      },
      enrolledUvCredential: async () => opts.uvCredentialId,
      listIdentities: async () => {
        vtaCalls.push({ what: "list" });
        return opts.known ?? entries;
      },
      signIdentify: async (_entryId, unsigned) => {
        vtaCalls.push({ what: "identify" });
        if (opts.identifyError) throw opts.identifyError;
        return { ...unsigned, proof: { proofPurpose: "authentication" } };
      },
      signGrant: async (_entryId, unsigned, uv) => {
        vtaCalls.push({ what: "grant", decision: uv });
        return { ...unsigned, proof: { proofPurpose: "assertionMethod" } };
      },
      enrolUvKey: async (enrolment) => {
        vtaCalls.push({ what: "enrol", decision: enrolment });
      },
    }),
  });
  return { flows, sent, vtaCalls };
}

const step = (w: World, s: Record<string, unknown>, flowId = "f1") =>
  w.flows.step({ flowId, vtaDid: "did:webvh:vta", ...s } as Parameters<SignInFlows["step"]>[0]);

const ASSERTION = {
  id: "AAECAwQFBgc",
  rawId: "AAECAwQFBgc",
  type: "public-key" as const,
  response: { clientDataJSON: "j", authenticatorData: "a", signature: "s" },
};

test("the whole approval, in the contract's order", async () => {
  const w = world();
  const confirm = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(confirm, {
    kind: "confirm",
    communityName: "Example Community",
    portalOrigin: PORTAL,
    identities: [{ entryId: "e-alice", did: ALICE, label: "Example Community" }],
  });
  assert.equal(w.sent.length, 0, "nothing goes to the community before Continue");

  const enter = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(enter.kind, "enter-number");
  assert.equal("nameMismatch" in enter, false);
  assert.equal((enter as { audience: string }).audience, "member", "no extension: the member portal");
  const claim = w.sent[0]!.doc;
  assert.equal(w.sent[0]!.type, "claim");
  assert.equal(claim.parentThreadId, ID);
  assert.match(String(claim.issuer), /^did:key:z6Mk/);
  const kA = claim.issuer;

  const review = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal(review.kind, "review");
  assert.equal((review as { network: string }).network, "same");
  assert.equal((review as { audience: string }).audience, "member");
  assert.equal(w.sent[1]!.doc.parentThreadId, ID, "prove carries parentThreadId (C9)");
  const prove = w.sent[1]!.doc as { issuer: string; payload: { identify: { issuer: string; payload: Record<string, unknown> } } };
  assert.equal(prove.issuer, kA);
  assert.equal(prove.payload.identify.issuer, ALICE);
  assert.deepEqual(prove.payload.identify.payload, { requestId: ID, approverKey: kA, enteredNumber: "47" });

  const challenge = await step(w, { step: "grant-digest" });
  assert.equal(challenge.kind, "uv-challenge");
  assert.equal(w.vtaCalls.filter((c) => c.what === "grant").length, 0, "no grant is signed before the passkey");

  const done = await step(w, { step: "respond", decision: "approve", assertion: ASSERTION });
  assert.deepEqual(done, { kind: "done", decision: "approve", status: "approved" });
  const grantCall = w.vtaCalls.find((c) => c.what === "grant")!;
  const decision = grantCall.decision as { payloadDigest: string; assertion: unknown };
  assert.deepEqual(decision.assertion, ASSERTION);
  // The passkey signed exactly the digest the VTA is told about: the UTF-8
  // bytes of the string D (C9).
  assert.equal(
    bytesToBase64url(new TextEncoder().encode(decision.payloadDigest)),
    (challenge as { challenge: string }).challenge,
  );
  const grant = (w.sent[2]!.doc as { payload: { grant: { payload: Record<string, unknown> } } }).payload.grant.payload;
  assert.equal(w.sent[2]!.type, "respond");
  assert.equal(w.sent[2]!.doc.parentThreadId, ID, "respond carries parentThreadId (C9)");
  assert.equal(grant.decision, "approve");
  assert.equal(grant.approverKey, kA);
  assert.equal(grant.origin, PORTAL);
  assert.equal(grant.notAfter, Math.floor((NOW + 3_600_000) / 1000), "epoch seconds (C9)");
  assert.match(String(grant.contextDigest), /^zQm/);

  // Spent: nothing more goes out for this flow.
  const again = await step(w, { step: "respond", decision: "decline" });
  assert.equal(again.kind, "failed");
  assert.equal(w.sent.length, 3);
});

test("a community the wallet does not know: nothing is sent, and joining is offered", async () => {
  const w = world({ known: entries.filter((e) => e.id !== "e-alice") });
  const r = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(r, { kind: "not-member", contactLabel: "members.example.org" });
  assert.equal(w.sent.length, 0);
});

test("a link clicked on a page that is not the portal is wrong-origin, and nothing is sent", async () => {
  const w = world();
  const r = await step(w, { step: "prepare", link: LINK, origin: "https://evil.example" });
  assert.deepEqual(r, { kind: "refused", outcome: "invalid", message: "This code can't be used." });
  assert.equal(w.sent.length, 0);
  assert.equal((await step(w, { step: "claim", entryId: "e-alice" })).kind, "failed", "no flow to claim on");
});

test("a refused link shows only its outcome's message", async () => {
  const w = world();
  const expired = LINK.replace(/_exp=\d+/, "_exp=1000");
  assert.deepEqual(await step(w, { step: "prepare", link: expired, origin: PORTAL }), {
    kind: "refused",
    outcome: "expired",
    message: "This code has expired. Get a new one.",
  });
  const claim = LINK.replace("sign-in/0.1", "vta-claim/0.1");
  assert.equal((await step(w, { step: "prepare", link: claim, origin: PORTAL }, "f2")).kind, "refused");
});

test("the community's own name, when different, is flagged after the claim", async () => {
  const w = world({ name: "Totally Legit Bank" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal((r as { nameMismatch?: string }).nameMismatch, "Totally Legit Bank");
});

test("steps out of order are refused without sending", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal((await step(w, { step: "prove", enteredNumber: "47" })).kind, "failed");
  assert.equal((await step(w, { step: "claim", entryId: "not-offered" })).kind, "failed");
  assert.equal(w.sent.length, 0);
});

test("a claim someone else made first", async () => {
  const w = world({ claimError: "alreadyClaimed" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(await step(w, { step: "claim", entryId: "e-alice" }), {
    kind: "failed",
    code: "alreadyClaimed",
    message: ALREADY_CLAIMED_MESSAGE,
  });
});

test("a decline is signed without user verification", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  await step(w, { step: "prove", enteredNumber: "47" });
  const r = await step(w, { step: "respond", decision: "decline" });
  assert.equal(r.kind, "done");
  assert.equal(w.vtaCalls.find((c) => c.what === "grant")!.decision, undefined);
  const grant = (w.sent[2]!.doc as { payload: { grant: { payload: { decision: string } } } }).payload.grant.payload;
  assert.equal(grant.decision, "decline");
});

test("closing the window cancels a held claim, signed by K_a, once", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  await w.flows.abort("f1");
  await w.flows.abort("f1");
  assert.deepEqual(w.sent.map((s) => s.type), ["claim", "cancel"]);
  assert.equal(w.sent[1]!.doc.issuer, w.sent[0]!.doc.issuer);
  assert.equal(w.flows.has("f1"), false);
});

test("closing before Continue sends nothing", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await w.flows.abort("f1");
  assert.equal(w.sent.length, 0);
});

test("enrolling the UV passkey goes to the VTA, and only once the member is identified", async () => {
  const w = world();
  const enrolment = {
    kind: "webauthn" as const,
    credentialId: "AAECAwQFBgc",
    publicKeyMultibase: "zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169",
    rpId: "ext",
    origin: "chrome-extension://ext",
    hardwareBacked: false,
    biometricGated: false,
  };
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal((await step(w, { step: "enrol-uv", enrolment })).kind, "failed", "not before step 2");
  await step(w, { step: "claim", entryId: "e-alice" });
  await step(w, { step: "prove", enteredNumber: "47" });
  assert.deepEqual(await step(w, { step: "enrol-uv", enrolment }), { kind: "uv-enrolled" });
  assert.deepEqual(w.vtaCalls.find((c) => c.what === "enrol")!.decision, enrolment);
});

test("the browser enrols as one of the member's devices before anything is sent", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(
    w.vtaCalls.map((c) => c.what),
    ["ensure-device", "list"],
    "registered at the VTA before the identities are read, and before the claim",
  );
  assert.equal(w.sent.length, 0);
});

test("the challenge says which passkey the VTA holds for this device", async () => {
  const w = world({ uvCredentialId: "AAECAwQFBgc" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  await step(w, { step: "prove", enteredNumber: "47" });
  const challenge = await step(w, { step: "grant-digest" });
  assert.equal((challenge as { uvCredentialId?: string }).uvCredentialId, "AAECAwQFBgc");
  const none = world();
  await step(none, { step: "prepare", link: LINK, origin: PORTAL });
  await step(none, { step: "claim", entryId: "e-alice" });
  await step(none, { step: "prove", enteredNumber: "47" });
  assert.equal("uvCredentialId" in (await step(none, { step: "grant-digest" })), false);
});

test("the member's VTA refusing as a disabled device is said plainly, and the claim is cancelled", async () => {
  for (const code of ["oobDeviceDisabled", "oobNotEnrolledDevice"]) {
    const w = world({ identifyError: vtaRefusal(code) });
    await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    await step(w, { step: "claim", entryId: "e-alice" });
    const r = await step(w, { step: "prove", enteredNumber: "47" });
    assert.deepEqual(r, { kind: "failed", code, message: VTA_REFUSAL_MESSAGES[code] });
    assert.deepEqual(w.sent.map((s) => s.type), ["claim", "cancel"], "the portal stops waiting");
  }
  // A refusal the wallet has no words for keeps the generic message.
  const w = world({ identifyError: vtaRefusal("oobSomethingNew") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(((await step(w, { step: "prove", enteredNumber: "47" })) as { code: string }).code, "sign-in/failed");
});

test("an operator-console sign-in: the audience is read from step 1 and held through step 2", async () => {
  const w = world({ ext: { "org.openvtc.session": { audience: "admin" } } });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const enter = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(enter.kind, "enter-number");
  assert.equal((enter as { audience: string }).audience, "admin");
  const review = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal(review.kind, "review");
  assert.equal((review as { audience: string }).audience, "admin");
});
