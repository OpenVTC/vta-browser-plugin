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
  UV_APPROVER_HELP,
  SIGN_IN_JOIN_FAILED,
  SIGN_IN_JOIN_DECLINED,
  notListedMessage,
  siteKindOf,
  communityNameMismatch,
  communityContextId,
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
  // The VTC signs its operational replies (the join requests') for
  // `authentication` (VTI-KEY-106).
  authentication: [VM],
  service: [
    { id: `${VTC}#sign-in-portal`, type: "SignInPortal", serviceEndpoint: `${PORTAL}/members/` },
    { id: `${VTC}#tt`, type: "TrustTaskHTTPS", serviceEndpoint: BASE },
  ],
};

/** The same service, published as a DID hosting service (affinidi-webvh-service
 *  `add_webvh_hosting_service`). */
const hostingDoc = {
  ...vtcDoc,
  service: [
    ...vtcDoc.service,
    { id: `${VTC}#webvh-hosting`, type: "WebVHHosting", serviceEndpoint: { uri: PORTAL } },
  ],
};
/** A VTC: its REST service, no `WebVHHosting`. */
const communityDoc = {
  ...vtcDoc,
  service: [...vtcDoc.service, { id: `${VTC}#vtc-rest`, type: "VTCRest", serviceEndpoint: BASE }],
};
/** A community admitting by review and asking a display name (required) and a
 *  country (optional) — the VTC's own defaults, plus requested attributes. */
const MANIFEST = {
  communityDid: VTC,
  criteria: [
    { id: "invited", admission: "automatic", invitationRequired: true, requirementsDigest: "zInvited" },
    {
      id: "member-credential",
      admission: "automatic",
      presentationDefinition: { credentials: [{ id: "membership", format: "ldp_vc" }] },
      credentialIssuers: "community",
      requirementsDigest: "zCredential",
    },
    { id: "review", admission: "review", requirementsDigest: "zReview" },
  ],
  branding: { displayName: "Example Community" },
  requestedAttributes: [
    { type: "name.display", required: true, purpose: "So members know who you are" },
    { type: "address.country", required: false },
  ],
};
/** One that admits anyone on the spot. */
const OPEN_MANIFEST = { communityDid: VTC, criteria: [{ id: "open", admission: "automatic", requirementsDigest: "zOpen" }] };

const PERSONAS = [
  { did: "did:webvh:QmBob:dids.example.net:bob", contextId: "personal" },
  { did: "did:webvh:QmWork:dids.example.net:work", contextId: "work" },
];

const entries: SignInVaultEntry[] = [
  { id: "e-other", label: "Elsewhere", secretKind: "didSelfIssued", principalDid: "did:web:x.example", targets: [{ kind: "did", did: "did:web:other.example" }] },
  { id: "e-pw", label: "Example Community", secretKind: "password", principalDid: ALICE, targets: [{ kind: "did", did: VTC }] },
  { id: "e-alice", label: "Example Community", secretKind: "didSelfIssued", principalDid: ALICE, targets: [{ kind: "did", did: VTC }] },
];

interface World {
  flows: SignInFlows;
  /** Every `vault/delete` of an entry the flow recorded. */
  unbinds: string[];
  /** Every document the VTA was asked to sign as a persona (`signTask`). */
  signed: Array<{ entryId: string; doc: Record<string, unknown> }>;
  sent: Array<{ type: string; doc: Record<string, unknown> }>;
  vtaCalls: Array<{ what: string; decision?: unknown }>;
  /** Every `bindIdentity` the flow asked the VTA for. */
  binds: Array<{ origin: string; did: string; rpDid: string }>;
}

/** What the member's VTA refuses a sign-in document with (`details.details.code`). */
const vtaRefusal = (code: string) =>
  Object.assign(new Error(`vault/sign-trust-task:${code}`), { details: { code: "taskFailed", details: { code } } });

function world(
  opts: {
    name?: string;
    /** How long a claim waits for the page's number (C11); 0 by default. */
    pageNumberWaitMs?: number;
    /** The VTA refuses renaming a record with this error. */
    renameError?: Error;
    claimError?: string;
    proveError?: string;
    /** What step 2 offers as `signingScope`. */
    signingScope?: string[];
    /** The community cannot be reached at all on this step. */
    unreachableOn?: string;
    identifyResult?: (unsigned: Record<string, unknown>) => unknown;
    known?: SignInVaultEntry[];
    identifyError?: unknown;
    /** The VTA refuses enrolling the UV key with this error. */
    enrolError?: Error;
    /** The community's `ext` on step 1, repeated in step 2. */
    ext?: Record<string, unknown>;
    /** The service's DID document; the plain sign-in service by default. */
    doc?: Record<string, unknown>;
    personas?: Array<{ did: string; contextId: string }>;
    bindError?: Error;
    /** The community's join manifest. */
    manifest?: Record<string, unknown>;
    /** Its answer to a join request: a submit response payload, or a refusal
     *  code. */
    submit?: Record<string, unknown> | { refuse: string };
    /** The manifest reply goes out unsigned. */
    manifestUnsigned?: boolean;
    signTaskError?: unknown;
    /** How this browser approves at the VTA, as recorded. */
    uvMethod?: "prfSealedKey" | "vtaPin" | "remoteApprover";
    /** What the VTA answers each grant signature with, in turn: an error to
     *  throw, or undefined to sign. The last one repeats. */
    grantAnswers?: Array<Error | undefined>;
    /** The phones the VTA lists, or an error. */
    approvers?: Array<{ did: string; displayName?: string }> | Error;
    /** The VTA's DID hosting servers, or an error listing them. Absent: the
     *  wallet cannot set up a new identity at all. */
    servers?: Array<{ id: string; label?: string }> | Error;
    /** Setting up a new identity fails with this error. */
    createIdentityError?: Error;
  } = {},
): World {
  const sent: World["sent"] = [];
  const unbinds: string[] = [];
  const signed: World["signed"] = [];
  const binds: World["binds"] = [];
  const vtaCalls: World["vtaCalls"] = [];
  const sessionKey = generateSigningIdentity().did;
  const step1 = {
    requestId: ID,
    service: { did: VTC, name: opts.name ?? "Example Community" },
    origin: PORTAL,
    purpose: "login",
    decisionClosesAt: new Date(NOW + 120_000).toISOString(),
    ...(opts.ext ? { ext: opts.ext } : {}),
  };
  const fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, ENDPOINT, "posted to <base>/trust-tasks (binding 0.2 §6)");
    const doc = JSON.parse(String(init.body));
    const join = /\/vtc\/join-requests\/(?:(manifest)\/0\.4|(submit)\/0\.3)$/.exec(String(doc.type));
    const type = join
      ? `join-${join[1] ?? join[2]}`
      : String(doc.type).replace("https://trusttasks.org/spec/auth/oob/", "").replace(/\/\d+\.\d+$/, "");
    sent.push({ type, doc });
    if (type === opts.unreachableOn) throw new TypeError("Failed to fetch");
    if (join) {
      const answer = type === "join-manifest" ? (opts.manifest ?? MANIFEST) : (opts.submit ?? { requestId: "jr-1", verdict: { effect: "refer", with: { queue: "admin-review" } } });
      if ("refuse" in answer) {
        return new Response(
          JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.2", payload: { code: answer.refuse, retryable: false } }),
          { status: 409 },
        );
      }
      const res = { id: crypto.randomUUID(), type: `${doc.type}#response`, issuer: VTC, recipient: doc.issuer, threadId: doc.id, issuedAt: new Date().toISOString(), payload: answer };
      if (!(type === "join-manifest" && opts.manifestUnsigned)) {
        await signTrustTask({ envelope: res, signing: { ...vtcKey, did: VTC, kid: VM }, proofPurpose: "authentication" });
      }
      return new Response(JSON.stringify(res), { status: 200 });
    }
    const refusal = type === "claim" ? opts.claimError : type === "prove" ? opts.proveError : undefined;
    if (refusal) {
      return new Response(
        JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.2", payload: { code: refusal, retryable: false } }),
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
              ...(opts.signingScope ? { signingScope: opts.signingScope } : {}),
            }
          : { status: type === "cancel" ? "cancelled" : "approved" };
    const res = { id: crypto.randomUUID(), type: `${doc.type}#response`, issuer: VTC, recipient: doc.issuer, threadId: doc.id, issuedAt: new Date().toISOString(), payload };
    await signTrustTask({ envelope: res, signing: { ...vtcKey, did: VTC, kid: VM }, proofPurpose: "assertionMethod" });
    return new Response(JSON.stringify(res), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  const flows = new SignInFlows({
    now: () => NOW,
    grantLifetimeMs: 3_600_000,
    pageNumberWaitMs: opts.pageNumberWaitMs ?? 0,
    fetch,
    resolveDid: async (did) => {
      assert.equal(did, VTC);
      return { didDocument: opts.doc ?? vtcDoc };
    },
    vta: () => ({
      ensureDevice: async () => {
        vtaCalls.push({ what: "ensure-device" });
      },
      listIdentities: async () => {
        vtaCalls.push({ what: "list" });
        return opts.known ?? entries;
      },
      listPersonas: async () => {
        vtaCalls.push({ what: "personas" });
        return opts.personas ?? PERSONAS;
      },
      bindIdentity: async (binding) => {
        vtaCalls.push({ what: "bind" });
        if (opts.bindError) throw opts.bindError;
        binds.push(binding);
        return { entryId: "e-new", label: new URL(binding.origin).hostname };
      },
      unbindIdentity: async (entryId) => {
        vtaCalls.push({ what: "unbind" });
        unbinds.push(entryId);
      },
      ...(opts.servers
        ? {
            listHostingServers: async () => {
              vtaCalls.push({ what: "servers" });
              if (opts.servers instanceof Error) throw opts.servers;
              return opts.servers!;
            },
            createCommunityIdentity: async (request: { contextId: string; name: string; serverId: string }) => {
              vtaCalls.push({ what: "create-identity", decision: request });
              if (opts.createIdentityError) throw opts.createIdentityError;
              return { did: NEW_DID, contextId: request.contextId };
            },
          }
        : {}),
      renameIdentity: async (entryId, label) => {
        vtaCalls.push({ what: "rename", decision: { entryId, label } });
        if (opts.renameError) throw opts.renameError;
      },
      signTask: async (entryId, unsigned) => {
        vtaCalls.push({ what: "sign-task" });
        if (opts.signTaskError) throw opts.signTaskError;
        signed.push({ entryId, doc: unsigned as unknown as Record<string, unknown> });
        return { ...unsigned, proof: { proofPurpose: "authentication" } };
      },
      signIdentify: async (_entryId, unsigned) => {
        vtaCalls.push({ what: "identify" });
        if (opts.identifyError) throw opts.identifyError;
        if (opts.identifyResult) return opts.identifyResult(unsigned as Record<string, unknown>);
        return { ...unsigned, proof: { proofPurpose: "authentication" } };
      },
      signGrant: async (_entryId, unsigned, uv) => {
        vtaCalls.push({ what: "grant", decision: uv });
        const answers = opts.grantAnswers ?? [];
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        if (answer) throw answer;
        return { ...unsigned, proof: { proofPurpose: "assertionMethod" } };
      },
      enrolUvKey: async (prfOutput) => {
        vtaCalls.push({ what: "enrol", decision: prfOutput });
        if (opts.enrolError) throw opts.enrolError;
      },
      uvMethod: async () => opts.uvMethod,
      enrolUvMethod: async (choice) => {
        vtaCalls.push({ what: "enrol-method", decision: choice });
        if (opts.enrolError) throw opts.enrolError;
        // K, for a PIN: the flow hands it to the grant and wipes it after.
        if (choice.kind === "vtaPin") return new Uint8Array(32).fill(9);
      },
      uvApprovers: async () => {
        vtaCalls.push({ what: "approvers" });
        if (opts.approvers instanceof Error) throw opts.approvers;
        return opts.approvers ?? [];
      },
    }),
  });
  return { flows, sent, vtaCalls, binds, unbinds, signed };
}

const step = (w: World, s: Record<string, unknown>, flowId = "f1") =>
  w.flows.step({ flowId, vtaDid: "did:webvh:vta", ...s } as Parameters<SignInFlows["step"]>[0]);

/** The PRF output of the passkey ceremony the window ran for the grant. */
const PRF = new Uint8Array(32).fill(7);
const PRF_B64U = bytesToBase64url(PRF);

test("a page pinned to another community is told so on the confirm screen (M5)", async () => {
  // The background says what the click's origin is pinned to, from an earlier
  // sign-in there. The same community is nothing to report; another one is —
  // the pairing was still verified against the document, so the flow goes on,
  // but the screen must say which community it was.
  const same = await step(world(), { step: "prepare", link: LINK, origin: PORTAL, pinnedDid: VTC });
  assert.equal(same.kind, "confirm");
  assert.equal("changedFromDid" in same, false);

  const other = "did:webvh:QmOther:members.example.org";
  const changed = await step(world(), { step: "prepare", link: LINK, origin: PORTAL, pinnedDid: other });
  assert.equal(changed.kind, "confirm");
  assert.equal((changed as { changedFromDid?: string }).changedFromDid, other);
});

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
  assert.equal((challenge as { vtaDid: string }).vtaDid, "did:webvh:vta", "names the VTA a first approval encrypts");

  const done = await step(w, { step: "respond", decision: "approve", prfOutputB64u: PRF_B64U });
  assert.deepEqual(done, { kind: "done", decision: "approve", status: "approved" });
  // The UV key is enrolled (or confirmed) before the grant, with the same
  // PRF output that then unseals it for the decision.
  const whats = w.vtaCalls.map((c) => c.what);
  assert.ok(whats.indexOf("enrol") < whats.indexOf("grant"), "enrolled before the grant");
  assert.deepEqual(w.vtaCalls.find((c) => c.what === "enrol")!.decision, PRF);
  const grantCall = w.vtaCalls.find((c) => c.what === "grant")!;
  const decision = grantCall.decision as { payloadDigest: string; prfOutput: Uint8Array };
  assert.deepEqual(decision.prfOutput, PRF);
  // The ceremony was bound to exactly the digest the VTA is told about: the
  // UTF-8 bytes of the string D (C9).
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
  assert.equal(grant.sessionEndsAt, new Date(NOW + 3_600_000).toISOString().replace(".000Z", "Z"), "an RFC 3339 date-time (grant 0.3)");
  assert.equal("notAfter" in grant, false);
  assert.match(String(grant.contextDigest), /^zQm/);

  // Spent: nothing more goes out for this flow.
  const again = await step(w, { step: "respond", decision: "decline" });
  assert.equal(again.kind, "failed");
  assert.equal(w.sent.length, 3);
});

const UNKNOWN = entries.filter((e) => e.id !== "e-alice");

test("a site that is neither a community nor a DID host: verified first, then not-member, and nothing is sent", async () => {
  const w = world({ known: UNKNOWN, doc: vtcDoc });
  const r = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(r, { kind: "not-member", contactLabel: "members.example.org", portalOrigin: PORTAL });
  assert.equal(w.sent.length, 0);
  assert.equal(w.vtaCalls.some((c) => c.what === "personas" || c.what === "bind"), false);
  assert.equal((await step(w, { step: "join", did: PERSONAS[0]!.did })).kind, "failed", "nothing to join");
  assert.equal((await step(w, { step: "join-manifest" })).kind, "failed", "nothing to join");
  assert.equal(w.binds.length, 0);
  assert.equal(w.sent.length, 0);
});

test("the site's kind is read from its verified document's services", () => {
  assert.equal(siteKindOf(hostingDoc), "did-hosting");
  assert.equal(siteKindOf({ service: [{ type: ["Other", "WebVHHosting"] }] }), "did-hosting");
  assert.equal(siteKindOf(communityDoc), "community");
  assert.equal(siteKindOf({ ...communityDoc, service: [...communityDoc.service, ...hostingDoc.service] }), "did-hosting");
  assert.equal(siteKindOf(vtcDoc), "other");
  assert.equal(siteKindOf({}), "other");
});

test("an unknown DID hosting service: offered, joined, and straight on to confirm", async () => {
  const w = world({ known: UNKNOWN, doc: hostingDoc });
  const offer = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(offer, {
    kind: "join-hosting",
    host: "members.example.org",
    portalOrigin: PORTAL,
    identities: PERSONAS,
  });
  assert.equal(w.sent.length, 0, "nothing goes to the service before the person agrees");

  const confirm = await step(w, { step: "join", did: PERSONAS[1]!.did });
  // The legacy first-use entry: the portal origin, and the service's DID.
  assert.deepEqual(w.binds, [{ origin: PORTAL, did: PERSONAS[1]!.did, rpDid: VTC }]);
  assert.deepEqual(confirm, {
    kind: "confirm",
    communityName: "members.example.org",
    portalOrigin: PORTAL,
    identities: [{ entryId: "e-new", did: PERSONAS[1]!.did, label: "members.example.org" }],
  });
  assert.equal(w.sent.length, 0, "joining sends nothing to the service either");

  // The same link goes on: no second click on the website.
  const enter = await step(w, { step: "claim", entryId: "e-new" });
  assert.equal(enter.kind, "enter-number");
  assert.deepEqual(w.sent.map((s) => s.type), ["claim"]);
  await step(w, { step: "prove", enteredNumber: "47" });
  const prove = w.sent[1]!.doc as { payload: { identify: { issuer: string } } };
  assert.equal(prove.payload.identify.issuer, PERSONAS[1]!.did);
});

test("declining an unknown DID hosting service sends nothing, and records nothing", async () => {
  for (const decline of ["cancel", "abort"] as const) {
    const w = world({ known: UNKNOWN, doc: hostingDoc });
    assert.equal((await step(w, { step: "prepare", link: LINK, origin: PORTAL })).kind, "join-hosting");
    if (decline === "cancel") {
      assert.deepEqual(await step(w, { step: "cancel" }), { kind: "done", decision: "decline", status: "cancelled" });
    } else {
      await w.flows.abort("f1");
    }
    assert.equal(w.sent.length, 0, `${decline}: zero network calls to the site`);
    assert.equal(w.binds.length, 0, `${decline}: nothing recorded in the vault`);
    assert.equal(w.flows.has("f1"), false);
    assert.equal((await step(w, { step: "join", did: PERSONAS[0]!.did })).kind, "failed", "the offer is gone");
    assert.equal(w.binds.length, 0);
  }
});

test("joining is offered only for the DIDs the agent listed", async () => {
  const w = world({ known: UNKNOWN, doc: hostingDoc });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join", did: "did:web:not-mine.example" });
  assert.equal(r.kind, "failed");
  assert.equal(w.binds.length, 0);
  assert.equal(w.sent.length, 0);
});

test("a vault that will not record the service ends the flow with its reason, and nothing is sent", async () => {
  const w = world({ known: UNKNOWN, doc: hostingDoc, bindError: new Error("no signing key could be derived") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join", did: PERSONAS[0]!.did });
  assert.equal(r.kind, "failed");
  const f = r as { code: string; stage?: string; message: string };
  assert.equal(f.code, SIGN_IN_JOIN_FAILED);
  assert.equal(f.stage, "join");
  assert.match(f.message, /no signing key could be derived/);
  assert.equal(w.sent.length, 0);
  assert.equal(w.flows.has("f1"), false);
});

test("an unknown site clicked on a page that is not its portal is still wrong-origin, before any offer", async () => {
  for (const doc of [hostingDoc, communityDoc]) {
    const w = world({ known: UNKNOWN, doc });
    const r = await step(w, { step: "prepare", link: LINK, origin: "https://evil.example" });
    assert.deepEqual(r, {
      kind: "refused",
      outcome: "invalid",
      message: "This code can't be used.",
      detail: { reason: "wrong-origin", did: VTC, pageOrigin: "https://evil.example", portalOrigin: PORTAL },
    });
    assert.equal(w.sent.length, 0);
    assert.equal(w.vtaCalls.some((c) => c.what === "personas"), false);
    assert.equal((await step(w, { step: "join", did: PERSONAS[0]!.did })).kind, "failed");
    assert.equal(w.binds.length, 0);
  }
});

test("a DID hosting service that has not listed the DID: the DID is shown, to send its operator", async () => {
  const w = world({ known: UNKNOWN, doc: hostingDoc, proveError: "auth/oob:notAuthorized" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join", did: PERSONAS[0]!.did });
  await step(w, { step: "claim", entryId: "e-new" });
  const r = await step(w, { step: "prove", enteredNumber: "47" });
  assert.deepEqual(r, {
    kind: "failed",
    code: "auth/oob:notAuthorized",
    message: notListedMessage("members.example.org"),
    stage: "prove",
    party: "community",
    unlisted: { host: "members.example.org", did: PERSONAS[0]!.did },
  });
  assert.equal(r.kind === "failed" && r.message, "members.example.org hasn't added you yet. Send this DID to its operator:");
  assert.equal(w.flows.has("f1"), false, "the request ended at the service");
});

test("an existing DID hosting entry that is refused gets the same screen", async () => {
  const w = world({ doc: hostingDoc, proveError: "auth/oob:notAuthorized" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = await step(w, { step: "prove", enteredNumber: "47" });
  assert.deepEqual((r as { unlisted?: unknown }).unlisted, { host: "members.example.org", did: ALICE });
});

test("a VTC refusing the proof keeps the generic message: its members are not an access list to ask for", async () => {
  const w = world({ doc: communityDoc, proveError: "auth/oob:notAuthorized" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal(r.kind, "failed");
  assert.equal("unlisted" in r, false);
  assert.match((r as { message: string }).message, /can't be used/);
});

test("the services' family-qualified codes are matched on their stable name (C9)", async () => {
  const w = world({ claimError: "auth/oob/claim:alreadyClaimed" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal((r as { message: string }).message, ALREADY_CLAIMED_MESSAGE);
  const x = world({ claimError: "auth/oob:requestExpired" });
  await step(x, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal((await step(x, { step: "claim", entryId: "e-alice" })).kind, "refused");
});

test("a link clicked on a page that is not the portal is wrong-origin, and nothing is sent", async () => {
  const w = world();
  const r = await step(w, { step: "prepare", link: LINK, origin: "https://evil.example" });
  // The message stays the outcome's; the detail names both origins, for Details.
  assert.deepEqual(r, {
    kind: "refused",
    outcome: "invalid",
    message: "This code can't be used.",
    detail: { reason: "wrong-origin", did: VTC, pageOrigin: "https://evil.example", portalOrigin: PORTAL },
  });
  assert.equal(w.sent.length, 0);
  assert.equal((await step(w, { step: "claim", entryId: "e-alice" })).kind, "failed", "no flow to claim on");
});

test("refusals about the service's DID document carry what was wrong, and the message stays the outcome's", async () => {
  const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
    [
      { ...vtcDoc, service: vtcDoc.service.filter((s) => s.type !== "SignInPortal") },
      { reason: "no-portal-service", did: VTC, service: "SignInPortal" },
      "invalid",
    ],
    [
      { ...vtcDoc, service: [{ type: "SignInPortal", serviceEndpoint: "https://portal.local/" }, vtcDoc.service[1]] },
      { reason: "no-portal-service", did: VTC, service: "SignInPortal", unusable: true },
      "invalid",
    ],
    [
      { ...vtcDoc, service: vtcDoc.service.filter((s) => s.type !== "TrustTaskHTTPS") },
      { reason: "no-common-transport", did: VTC, service: "TrustTaskHTTPS" },
      "unreachable",
    ],
    // A document that is not the DID's does not verify.
    [{ ...vtcDoc, id: "did:webvh:QmOther:elsewhere.example" }, { reason: "did-document-unverified", did: VTC }, "invalid"],
  ];
  for (const [doc, detail, outcome] of cases) {
    const w = world({ doc });
    const r = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    assert.equal(r.kind, "refused");
    const refusal = r as Extract<typeof r, { kind: "refused" }>;
    assert.equal(refusal.outcome, outcome);
    assert.deepEqual(refusal.detail, detail);
    assert.doesNotMatch(refusal.message, /SignInPortal|TrustTask|did:/, "the message names nothing");
    assert.equal(w.sent.length, 0);
  }
});

test("a contact method sign-in does not take is named in the detail; a bad link field is not", async () => {
  const w = world();
  const didKey = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const r = await step(w, { step: "prepare", link: LINK.replace(VTC, didKey), origin: PORTAL });
  assert.deepEqual(r, {
    kind: "refused",
    outcome: "invalid",
    message: "This code can't be used.",
    detail: { reason: "from-not-allowed", method: "did:key" },
  });
  const badId = await step(w, { step: "prepare", link: LINK.replace(ID, "short"), origin: PORTAL }, "f2");
  assert.deepEqual(badId, { kind: "refused", outcome: "invalid", message: "This code can't be used." });
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

// ── C11: the number from the page the code was clicked on ───────────────────

const identifyNumber = (w: World) =>
  (w.sent[1]!.doc as { payload: { identify: { payload: { enteredNumber: string } } } }).payload.identify.payload
    .enteredNumber;

test("the page's number, arriving while the claim waits, proves without a number screen", async () => {
  const w = world({ pageNumberWaitMs: 5_000 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const claimed = step(w, { step: "claim", entryId: "e-alice" });
  setTimeout(() => w.flows.pageNumber("f1", "47"), 10);
  const review = await claimed;
  assert.equal(review.kind, "review");
  assert.deepEqual(w.sent.map((s) => s.type), ["claim", "prove"]);
  assert.equal(identifyNumber(w), "47");
  assert.equal((review as { decisionDeadline: number }).decisionDeadline > 0, true, "the review carries the countdown");
});

test("the page's number, already known when the claim lands, is used at once", async () => {
  const w = world({ pageNumberWaitMs: 60_000 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  w.flows.pageNumber("f1", "05");
  const review = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(review.kind, "review");
  assert.equal(identifyNumber(w), "05");
});

test("no number from the page: after the wait the person types it", async () => {
  const w = world({ pageNumberWaitMs: 20 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const enter = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(enter.kind, "enter-number");
  assert.equal(w.sent.length, 1, "only the claim");
  // A number that turns up after the person was asked is dropped.
  w.flows.pageNumber("f1", "47");
  assert.equal(w.sent.length, 1);
});

test("a number that is not two digits is not the page's number", async () => {
  const w = world({ pageNumberWaitMs: 20 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  for (const bad of ["7", "123", "4a", ""]) w.flows.pageNumber("f1", bad);
  assert.equal((await step(w, { step: "claim", entryId: "e-alice" })).kind, "enter-number");
});

test("a community name that differs from the wallet's still asks, page number or not", async () => {
  const w = world({ name: "Totally Legit Bank", pageNumberWaitMs: 60_000 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  w.flows.pageNumber("f1", "47");
  const r = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(r.kind, "enter-number");
  assert.equal((r as { nameMismatch?: string }).nameMismatch, "Totally Legit Bank");
  assert.equal(w.sent.length, 1, "nothing proved for the person");
});

test("calling the community by its own name renames the record and goes on with the page's number", async () => {
  const w = world({ name: "Totally  Legit Bank", pageNumberWaitMs: 60_000 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  w.flows.pageNumber("f1", "47");
  assert.equal((await step(w, { step: "claim", entryId: "e-alice" })).kind, "enter-number");
  const review = await step(w, { step: "adopt-name" });
  assert.deepEqual(w.vtaCalls.find((c) => c.what === "rename")!.decision, {
    entryId: "e-alice",
    label: "Totally Legit Bank",
  });
  assert.equal(review.kind, "review");
  assert.equal(identifyNumber(w), "47");
});

test("calling the community by its own name, with no page number: the number screen, no longer flagged", async () => {
  const w = world({ name: "Totally Legit Bank", pageNumberWaitMs: 20 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = await step(w, { step: "adopt-name" });
  assert.equal(r.kind, "enter-number");
  assert.equal("nameMismatch" in r, false);
  assert.equal(w.sent.length, 1, "nothing proved for the person");
  // And the number they type proves as usual.
  assert.equal((await step(w, { step: "prove", enteredNumber: "47" })).kind, "review");
});

test("a rename the VTA refuses keeps the flow, the warning and the reason", async () => {
  const w = world({ name: "Totally Legit Bank", renameError: new Error("version conflict") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = await step(w, { step: "adopt-name" });
  assert.equal(r.kind, "enter-number");
  assert.equal((r as { nameMismatch?: string }).nameMismatch, "Totally Legit Bank");
  assert.equal((r as { adoptFailed?: string }).adoptFailed, "version conflict");
  assert.equal(w.sent.some((s) => s.type === "cancel"), false, "the claim is still held");
  assert.equal((await step(w, { step: "prove", enteredNumber: "47" })).kind, "review");
});

test("adopting a name before the claim is out of order, and sends nothing", async () => {
  const w = world({ name: "Totally Legit Bank" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "adopt-name" });
  assert.equal(r.kind, "failed");
  assert.equal(w.vtaCalls.some((c) => c.what === "rename"), false);
});

test("two entries for one DID are offered once", async () => {
  const twin: SignInVaultEntry = { ...entries[2]!, id: "e-alice-2", label: "members.example.org" };
  const w = world({ known: [...entries, twin] });
  const confirm = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual((confirm as { identities: unknown[] }).identities, [
    { entryId: "e-alice", did: ALICE, label: "Example Community" },
  ]);
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
    stage: "claim",
    party: "community",
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

test("an approval needs the ceremony's PRF output, and only once the member is identified", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal(
    (await step(w, { step: "respond", decision: "approve", prfOutputB64u: PRF_B64U })).kind,
    "failed",
    "not before step 2",
  );
  assert.equal(w.vtaCalls.some((c) => c.what === "enrol"), false);
});

test("a UV key the VTA will not enrol stops the approval before any grant is signed", async () => {
  const w = world({ enrolError: new Error("refused") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  await step(w, { step: "prove", enteredNumber: "47" });
  await step(w, { step: "grant-digest" });
  const res = await step(w, { step: "respond", decision: "approve", prfOutputB64u: PRF_B64U });
  assert.equal(res.kind, "failed");
  assert.equal((res as { stage?: string }).stage, "enrol-uv");
  assert.equal(w.vtaCalls.some((c) => c.what === "grant"), false);
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

test("the member's VTA refusing as a disabled device is said plainly, and the claim is cancelled", async () => {
  for (const code of ["oobDeviceDisabled", "oobNotEnrolledDevice"]) {
    const w = world({ identifyError: vtaRefusal(code) });
    await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    await step(w, { step: "claim", entryId: "e-alice" });
    const r = await step(w, { step: "prove", enteredNumber: "47" });
    assert.deepEqual(r, { kind: "failed", code, message: VTA_REFUSAL_MESSAGES[code], stage: "identify", party: "vta" });
    assert.deepEqual(w.sent.map((s) => s.type), ["claim", "cancel"], "the portal stops waiting");
  }
  // A refusal the wallet has no words for keeps the generic message.
  const w = world({ identifyError: vtaRefusal("oobSomethingNew") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal((r as { code: string }).code, "sign-in/failed");
  // …and says, in its details, what the agent's code was and where.
  assert.deepEqual(
    { stage: (r as { stage?: string }).stage, party: (r as { party?: string }).party, cause: (r as { cause?: string }).cause },
    { stage: "identify", party: "vta", cause: "oobSomethingNew" },
  );
});

// ── Name mismatch (VTI-LNK-104) ──────────────────────────────────────────────

test("an unnamed community — its service name is its DID — is not flagged", async () => {
  const w = world({ name: VTC });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(r.kind, "enter-number");
  assert.equal("nameMismatch" in r, false);
});

test("the name rule: absent names and DIDs are not names; case and spacing are not differences", () => {
  const ours = "TEST VTC";
  const did = "did:webvh:QmNvAiYMwoZMWGfY62gqNJuedQgH224FMpHenzJTK1wJrG:webvh.storm.ws:test-vtc";
  assert.equal(communityNameMismatch("", did, ours), undefined, "empty");
  assert.equal(communityNameMismatch("   ", did, ours), undefined, "blank");
  assert.equal(communityNameMismatch(undefined, did, ours), undefined, "absent");
  assert.equal(communityNameMismatch(did, did, ours), undefined, "the service's own DID");
  assert.equal(communityNameMismatch(` ${did} `, did, ours), undefined, "its DID, padded");
  assert.equal(communityNameMismatch("did:web:elsewhere.example", did, ours), undefined, "any did: string");
  assert.equal(communityNameMismatch("DID:web:elsewhere.example", did, ours), undefined, "any did: string, any case");
  assert.equal(communityNameMismatch("test vtc", did, ours), undefined, "case folded");
  assert.equal(communityNameMismatch("  Test\t  VTC \n", did, ours), undefined, "whitespace trimmed and collapsed");
  assert.equal(communityNameMismatch("TEST VTC", did, ours), undefined, "identical");
  assert.equal(communityNameMismatch("Totally Legit Bank", did, ours), "Totally Legit Bank", "a different human name");
  assert.equal(communityNameMismatch("TEST VTC 2", did, ours), "TEST VTC 2", "a near miss is still different");
  assert.equal(communityNameMismatch("  Totally  Legit ", did, ours), "  Totally  Legit ", "flagged as the community sent it");
});

test("the name rule: the verified portal host is not a different name (VTI-LNK-104)", () => {
  const ours = "DID Hosting";
  const did = "did:webvh:QmSNo2TJRq5xiiYhHZNrTqoaq8bivffWq4PZXjQQAzvNtr:webvh.storm.ws";
  const portal = "https://webvh.storm.ws";
  assert.equal(communityNameMismatch("webvh.storm.ws", did, ours, portal), undefined, "the portal host");
  assert.equal(communityNameMismatch(" WebVH.Storm.WS ", did, ours, portal), undefined, "the portal host, any case");
  assert.equal(communityNameMismatch("webvh.storm.ws", did, ours), "webvh.storm.ws", "no portal origin to compare with");
  assert.equal(communityNameMismatch("evil.example", did, ours, portal), "evil.example", "another host");
  assert.equal(communityNameMismatch("storm.ws", did, ours, portal), "storm.ws", "a parent domain is still different");
  assert.equal(communityNameMismatch("https://webvh.storm.ws", did, ours, portal), "https://webvh.storm.ws", "only the bare host");
  assert.equal(communityNameMismatch("webvh.storm.ws", did, ours, "not a url"), "webvh.storm.ws", "an unparseable origin");
});

test("the name rule: a record labelled with the portal host holds no name to differ from", () => {
  const did = "did:webvh:QmNvAiYMwoZMWGfY62gqNJuedQgH224FMpHenzJTK1wJrG:webvh.storm.ws:test-vtc";
  const portal = "https://test-vtc.openvtc.net";
  // The label the wallet made itself when it recorded the community.
  assert.equal(communityNameMismatch("Verifiable Trust Community", did, "test-vtc.openvtc.net", portal), undefined);
  assert.equal(communityNameMismatch("Verifiable Trust Community", did, " Test-VTC.openvtc.net", portal), undefined, "any case");
  // A name the person gave it still differs.
  assert.equal(
    communityNameMismatch("Verifiable Trust Community", did, "My Club", portal),
    "Verifiable Trust Community",
  );
  // Another host as the label is a name like any other.
  assert.equal(
    communityNameMismatch("Verifiable Trust Community", did, "openvtc.net", portal),
    "Verifiable Trust Community",
  );
});

// ── Failure details: where, who, and the code ────────────────────────────────

test("a community refusing the proof says so: stage prove, party community", async () => {
  const w = world({ proveError: "numberMismatch" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal(r.kind, "failed");
  const f = r as { code: string; stage?: string; party?: string; message: string };
  assert.equal(f.code, "numberMismatch");
  assert.equal(f.stage, "prove");
  assert.equal(f.party, "community");
  assert.match(f.message, /can't be used/, "the member's message is unchanged");
});

test("a signed document the wallet rejects is the wallet's refusal, at the step that produced it", async () => {
  const w = world({ identifyResult: (unsigned) => unsigned });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = (await step(w, { step: "prove", enteredNumber: "47" })) as { code: string; stage?: string; party?: string };
  assert.deepEqual({ code: r.code, stage: r.stage, party: r.party }, { code: "auth/oob/reply-invalid", stage: "identify", party: "wallet" });
});

test("a community that cannot be reached names no party: nobody refused", async () => {
  const w = world({ unreachableOn: "claim" });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = (await step(w, { step: "claim", entryId: "e-alice" })) as Record<string, unknown>;
  assert.equal(r.code, "network");
  assert.equal(r.stage, "claim");
  assert.equal("party" in r, false);
});

test("a generic failure keeps its generic code and gives the error's name as the cause", async () => {
  const w = world({ identifyError: new RangeError("boom") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const r = (await step(w, { step: "prove", enteredNumber: "47" })) as Record<string, unknown>;
  assert.equal(r.code, "sign-in/failed");
  assert.equal(r.stage, "identify");
  assert.equal(r.cause, "RangeError");
  assert.equal("party" in r, false, "a thrown error is not a refusal");
  assert.equal(JSON.stringify(r).includes("boom"), false, "no message body leaves the flow");
});

test("an out-of-order step is the wallet's", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = (await step(w, { step: "prove", enteredNumber: "47" })) as Record<string, unknown>;
  assert.equal(r.code, "sign-in/out-of-order");
  assert.equal(r.party, "wallet");
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

// ── An unknown community (VTC): joining ─────────────────────────────────────

const NAME = [{ type: "name.display", value: "Ada" }];
const NEW_DID = "did:webvh:QmNew:dids.example.net:vtc-members";

test("an unknown community is offered to join, by its verified origin, and nothing is sent", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc });
  const r = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.deepEqual(r, { kind: "join-community", host: "members.example.org", portalOrigin: PORTAL });
  assert.equal(w.sent.length, 0, "nothing goes to the community before the person continues");
  assert.equal(w.vtaCalls.some((c) => c.what === "personas" || c.what === "bind"), false);
  // The DID hosting step is not this flow's.
  assert.equal((await step(w, { step: "join", did: PERSONAS[0]!.did })).kind, "failed");
  assert.equal(w.sent.length, 0);
});

test("a community whose DID document does not verify is refused, with no offer", async () => {
  const w = world({ known: UNKNOWN, doc: { ...communityDoc, id: "did:web:someone-else.example" } });
  const r = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal(r.kind, "refused");
  assert.equal((await step(w, { step: "join-manifest" })).kind, "failed");
  assert.equal(w.sent.length, 0);
});

test("declining or closing the join offer sends nothing; after the manifest, nothing about the person", async () => {
  for (const at of ["offer", "apply"] as const) {
    for (const decline of ["cancel", "abort"] as const) {
      const w = world({ known: UNKNOWN, doc: communityDoc });
      await step(w, { step: "prepare", link: LINK, origin: PORTAL });
      if (at === "apply") assert.equal((await step(w, { step: "join-manifest" })).kind, "join-apply");
      if (decline === "cancel") await step(w, { step: "cancel" });
      else await w.flows.abort("f1");
      assert.deepEqual(w.sent.map((s) => s.type), at === "offer" ? [] : ["join-manifest"], `${at}/${decline}`);
      assert.equal(w.binds.length, 0, "nothing recorded");
      assert.equal(w.signed.length, 0, "nothing signed as the person");
      assert.equal(w.flows.has("f1"), false);
      assert.equal((await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: false })).kind, "failed");
      assert.equal(w.binds.length, 0);
    }
  }
});

test("the manifest is asked for as a throwaway key, and shows what the community asks", async () => {
  const known: SignInVaultEntry[] = [
    ...UNKNOWN,
    { id: "e-bob", label: "Other Community", secretKind: "didSelfIssued", principalDid: PERSONAS[0]!.did, targets: [{ kind: "did", did: "did:web:other-vtc.example" }] },
  ];
  const w = world({ known, doc: communityDoc });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join-manifest" });
  assert.deepEqual(r, {
    kind: "join-apply",
    host: "members.example.org",
    portalOrigin: PORTAL,
    displayName: "Example Community",
    admission: "review",
    attributes: [
      { type: "name.display", required: true, purpose: "So members know who you are" },
      { type: "address.country", required: false },
    ],
    identities: [
      { ...PERSONAS[0]!, usedAt: ["Other Community"] },
      PERSONAS[1]!,
    ],
  });
  const manifest = w.sent[0]!.doc as { issuer: string; recipient: string; payload: unknown; proof?: unknown };
  assert.match(manifest.issuer, /^did:key:z6Mk/);
  assert.equal(PERSONAS.some((p) => p.did === manifest.issuer), false, "not the person's identity");
  assert.equal(manifest.recipient, VTC);
  assert.deepEqual(manifest.payload, {});
  assert.equal(w.binds.length, 0, "nothing recorded yet");
});

// The specification's example statement (vtc/join-requests/manifest/0.4).
const STATEMENT = {
  fields: [
    { key: "displayName", label: "Name", type: "text", source: "member", ceiling: "members", defaultVisibility: "members", searchable: true },
    { key: "role", label: "Role", type: "text", source: "derived", ceiling: "members", defaultVisibility: "members", searchable: false },
  ],
  newCard: { listing: "listed", search: "byName" },
  membershipIdentifiers: "admins",
  adminNotes: false,
  externalCards: false,
  statementDigest: "zQmStatement",
};

test("the manifest is asked for at 0.4, and what the directory would show is on the join screen", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, manifest: { ...MANIFEST, directoryDisclosure: STATEMENT } });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join-manifest" });
  assert.equal(r.kind, "join-apply");
  assert.match(String((w.sent[0]!.doc as { type: string }).type), /\/manifest\/0\.4$/);
  assert.deepEqual((r as { directory?: unknown }).directory, {
    lines: [
      "Your Name and Role will be seen by the community's other members.",
      "Anything else you add is seen by the administrators only, until you choose otherwise.",
      "You may choose to show your Name and Role to the community's other members, and no further.",
      "Members browsing the directory will find you; you can hide yourself.",
      "The DID you join with is seen by the administrators only.",
      "The administrators keep no notes about members.",
      "Your card is never published outside the community.",
    ],
    statementDigest: "zQmStatement",
  });
});

test("a statement the wallet cannot show stops the join before anything about the person is sent", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, manifest: { ...MANIFEST, directoryDisclosure: { ...STATEMENT, adminNotes: undefined } } });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal((await step(w, { step: "join-manifest" })).kind, "failed");
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
  assert.equal(w.binds.length, 0);
});

test("a pending request: the request-sent screen, the entry kept, and no sign-in document", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = await step(w, {
    step: "join-submit",
    did: PERSONAS[1]!.did,
    attributes: [...NAME, { type: "address.country", value: "  " }],
    registryConsent: false,
  });
  assert.deepEqual(r, { kind: "join-pending", host: "members.example.org", portalOrigin: PORTAL });
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest", "join-submit"]);
  // The entry every member's sign-in finds: the portal origin and the VTC.
  assert.deepEqual(w.binds, [{ origin: PORTAL, did: PERSONAS[1]!.did, rpDid: VTC }]);
  assert.deepEqual(w.unbinds, [], "the request is open under that identity");
  // Signed as the chosen identity, by its vault entry.
  assert.equal(w.signed[0]!.entryId, "e-new");
  const submit = w.sent[1]!.doc as { issuer: string; recipient: string; payload: Record<string, unknown> };
  assert.equal(submit.issuer, PERSONAS[1]!.did);
  assert.equal(submit.recipient, VTC);
  assert.deepEqual(submit.payload, {
    vp: { "@context": ["https://www.w3.org/ns/credentials/v2"], type: ["VerifiablePresentation"], holder: PERSONAS[1]!.did },
    criterion: "zReview",
    registryConsent: false,
    attributes: NAME,
  });
  // Spent: nothing more goes out.
  assert.equal(w.flows.has("f1"), false);
  assert.equal((await step(w, { step: "claim", entryId: "e-new" })).kind, "failed");
  assert.equal(w.sent.length, 2);
  assert.equal(w.vtaCalls.some((c) => c.what === "identify" || c.what === "grant"), false);
});

test("a community asking for more evidence: pending, with what it asks", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, submit: { requestId: "jr-1", verdict: { effect: "requestMore", with: { needs: ["proof of personhood"] } } } });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: true });
  assert.deepEqual(r, { kind: "join-pending", host: "members.example.org", portalOrigin: PORTAL, needs: ["proof of personhood"] });
  assert.equal((w.sent[1]!.doc as { payload: { registryConsent: boolean } }).payload.registryConsent, true);
});

test("admitted on the spot: straight on to confirm, and the same link signs in as the new member", async () => {
  const w = world({
    known: UNKNOWN,
    doc: communityDoc,
    manifest: OPEN_MANIFEST,
    submit: { requestId: "jr-1", verdict: { effect: "allow", with: { role: "member", vmc: {}, roleVac: {} } } },
  });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const apply = await step(w, { step: "join-manifest" });
  assert.equal(apply.kind, "join-apply");
  assert.equal((apply as { admission: string }).admission, "automatic");
  const confirm = await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: [], registryConsent: false });
  assert.deepEqual(confirm, {
    kind: "confirm",
    communityName: "members.example.org",
    portalOrigin: PORTAL,
    identities: [{ entryId: "e-new", did: PERSONAS[0]!.did, label: "members.example.org" }],
  });
  assert.equal((w.sent[1]!.doc as { payload: { criterion: string; attributes?: unknown } }).payload.criterion, "zOpen");
  assert.equal("attributes" in (w.sent[1]!.doc as { payload: object }).payload, false, "none asked, none sent");
  const enter = await step(w, { step: "claim", entryId: "e-new" });
  assert.equal(enter.kind, "enter-number");
  await step(w, { step: "prove", enteredNumber: "47" });
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest", "join-submit", "claim", "prove"]);
  assert.equal((w.sent[3]!.doc as { payload: { identify: { issuer: string } } }).payload.identify.issuer, PERSONAS[0]!.did);
  assert.deepEqual(w.unbinds, []);
});

test("a community asking for evidence the wallet cannot send: said plainly, and nothing about the person is sent", async () => {
  const manifest = { ...MANIFEST, criteria: MANIFEST.criteria.slice(0, 2) };
  const w = world({ known: UNKNOWN, doc: communityDoc, manifest });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join-manifest" });
  assert.deepEqual(r, {
    kind: "join-elsewhere",
    host: "members.example.org",
    portalOrigin: PORTAL,
    reason: "needs-more",
    needs: ["an invitation from the community", "a credential"],
    displayName: "Example Community",
  });
  assert.equal(w.flows.has("f1"), false);
  assert.equal(w.binds.length, 0);
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
});

test("a submission is held to what the community asked, and to the agent's own DIDs", async () => {
  const bad = [
    { did: "did:web:not-mine.example", attributes: NAME },
    { did: PERSONAS[0]!.did, attributes: [] },
    { did: PERSONAS[0]!.did, attributes: [{ type: "name.display", value: "  " }] },
    { did: PERSONAS[0]!.did, attributes: [...NAME, { type: "phone.mobile", value: "1" }] },
  ];
  for (const b of bad) {
    const w = world({ known: UNKNOWN, doc: communityDoc });
    await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    await step(w, { step: "join-manifest" });
    const r = await step(w, { step: "join-submit", ...b, registryConsent: false });
    assert.equal(r.kind, "failed");
    assert.equal(w.binds.length, 0);
    assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
  }
});

test("a community refusing the request: its reason, plainly, and the entry is removed", async () => {
  const cases: Array<[Parameters<typeof world>[0], string, RegExp]> = [
    [{ submit: { refuse: "vtc/join-requests/submit:notAccepting" } }, "vtc/join-requests/submit:notAccepting", /isn't accepting new members/],
    [{ submit: { refuse: "vtc/join-requests/submit:attributesMissing" } }, "vtc/join-requests/submit:attributesMissing", /needs details/],
    [{ submit: { refuse: "rateLimited" } }, "rateLimited", /didn't take the request\. It answered rateLimited/],
    [{ unreachableOn: "join-submit" }, "network", /couldn't be reached/],
  ];
  for (const [opts, code, message] of cases) {
    const w = world({ known: UNKNOWN, doc: communityDoc, ...opts });
    await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    await step(w, { step: "join-manifest" });
    const r = (await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: false })) as {
      kind: string;
      code: string;
      message: string;
      stage?: string;
    };
    assert.equal(r.kind, "failed", code);
    assert.equal(r.code, code);
    assert.match(r.message, message);
    assert.equal(r.stage, "join-submit");
    assert.deepEqual(w.unbinds, ["e-new"], "the entry is removed again");
    assert.equal(w.flows.has("f1"), false);
  }
});

test("a declined request says so, with the community's reason", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, submit: { requestId: "jr-1", verdict: { effect: "deny", with: { code: "policy", reason: "Members only by referral" } } } });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: false });
  assert.deepEqual(r, {
    kind: "failed",
    code: SIGN_IN_JOIN_DECLINED,
    message: "members.example.org declined your request to join: Members only by referral",
    stage: "join-submit",
    party: "community",
    cause: "policy",
  });
  assert.deepEqual(w.unbinds, ["e-new"]);
});

test("a request already open under that identity is pending, and its entry stays", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, submit: { refuse: "vtc/join-requests/submit:requestAlreadyOpen" } });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: false });
  assert.deepEqual(r, { kind: "join-pending", host: "members.example.org", portalOrigin: PORTAL });
  assert.deepEqual(w.unbinds, []);
});

test("the agent refusing to sign the request: nothing goes to the community, and the entry is removed", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, signTaskError: vtaRefusal("notSignable") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = (await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: false })) as {
    code: string;
    stage: string;
    party: string;
  };
  assert.equal(r.code, "notSignable");
  assert.equal(r.stage, "join-sign");
  assert.equal(r.party, "vta");
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
  assert.deepEqual(w.unbinds, ["e-new"]);
});

test("a vault that will not record the identity: nothing is sent as the person", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, bindError: new Error("no signing key could be derived") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = (await step(w, { step: "join-submit", did: PERSONAS[0]!.did, attributes: NAME, registryConsent: false })) as { code: string; message: string };
  assert.equal(r.code, SIGN_IN_JOIN_FAILED);
  assert.match(r.message, /nothing was sent to it: no signing key could be derived/);
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
});

test("a manifest the community did not sign is not believed", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, manifestUnsigned: true });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = (await step(w, { step: "join-manifest" })) as { kind: string; code: string; party?: string };
  assert.equal(r.kind, "failed");
  assert.equal(r.code, "auth/oob/reply-invalid");
  assert.equal(r.party, "wallet");
  assert.equal(w.vtaCalls.some((c) => c.what === "personas"), false);
});

test("a manifest the community would not share is said plainly", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, manifest: { refuse: "permissionDenied" } as unknown as Record<string, unknown> });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = (await step(w, { step: "join-manifest" })) as { kind: string; message: string; stage: string };
  assert.equal(r.kind, "failed");
  assert.match(r.message, /doesn't share how to join/);
  assert.equal(r.stage, "join-manifest");
});

// ── auth/oob 0.2: delegated signing ─────────────────────────────────────────

test("a scope the community offers is shown at review and copied into the grant", async () => {
  const w = world({ signingScope: ["vtc/directory"] });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const review = await step(w, { step: "prove", enteredNumber: "47" });
  assert.deepEqual((review as { signingScope?: string[] }).signingScope, ["vtc/directory"]);
  // One version per step, what the community serves (claim 0.2, prove 0.3,
  // respond 0.3 carrying grant 0.3): nothing is tried first or fallen back to.
  assert.match(String(w.sent[0]!.doc.type), /\/auth\/oob\/claim\/0\.2$/);
  assert.match(String(w.sent[1]!.doc.type), /\/auth\/oob\/prove\/0\.3$/);
  await step(w, { step: "grant-digest" });
  await step(w, { step: "respond", decision: "approve", prfOutputB64u: PRF_B64U });
  const respond = w.sent[2]!.doc as { type: string; payload: { grant: { type: string; payload: Record<string, unknown> } } };
  assert.match(respond.type, /\/auth\/oob\/respond\/0\.3$/);
  assert.match(respond.payload.grant.type, /\/auth\/oob\/grant\/0\.3$/);
  assert.deepEqual(respond.payload.grant.payload.signingScope, ["vtc/directory"]);
});

test("with no scope offered, nothing is delegated", async () => {
  const w = world();
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  const review = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal("signingScope" in review, false);
  await step(w, { step: "grant-digest" });
  await step(w, { step: "respond", decision: "approve", prfOutputB64u: PRF_B64U });
  const grant = (w.sent[2]!.doc as { payload: { grant: { payload: Record<string, unknown> } } }).payload.grant.payload;
  assert.equal("signingScope" in grant, false);
});

test("a scope naming sign-in, access control or consent is refused, whatever the community offers", async () => {
  for (const family of ["auth", "acl", "task-consent/decision"]) {
    const w = world({ signingScope: ["vtc/directory", family] });
    await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    await step(w, { step: "claim", entryId: "e-alice" });
    const r = await step(w, { step: "prove", enteredNumber: "47" });
    assert.equal(r.kind, "failed", family);
  }
});


// ── Approving without a PRF passkey: a PIN, or the person's phone ───────────

async function toReview(w: World) {
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "claim", entryId: "e-alice" });
  return step(w, { step: "prove", enteredNumber: "47" });
}

const uvRefusal = (details: Record<string, unknown>) =>
  Object.assign(new Error(`vault/sign-trust-task:${details.code}`), { details: { code: "taskFailed", details } });

test("the review says how this browser approves at the agent, and says nothing when it is not set up", async () => {
  assert.equal(((await toReview(world({ uvMethod: "vtaPin" }))) as { uvMethod?: string }).uvMethod, "vtaPin");
  assert.equal("uvMethod" in (await toReview(world())), false);
});

test("vtaPin: a wrong PIN keeps the flow open with the tries left; a lock says until when; the right PIN signs", async () => {
  const w = world({
    uvMethod: "vtaPin",
    grantAnswers: [
      uvRefusal({ code: "oobUvPinWrong", attemptsRemaining: 2 }),
      uvRefusal({ code: "oobUvLocked", lockedUntil: 1_791_461_800 }),
      undefined,
    ],
  });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const wrong = await step(w, { step: "respond", decision: "approve", pin: "000000" });
  assert.deepEqual(wrong, { kind: "uv-pin", attemptsRemaining: 2 });
  assert.equal(w.flows.has("f1"), true);
  assert.deepEqual(w.sent.map((s) => s.type), ["claim", "prove"], "nothing goes to the community on a wrong PIN");

  await step(w, { step: "grant-digest" });
  const locked = await step(w, { step: "respond", decision: "approve", pin: "000000" });
  assert.deepEqual(locked, { kind: "uv-pin", lockedUntil: 1_791_461_800_000 }, "epoch s on the wire, ms to the window");

  const challenge = await step(w, { step: "grant-digest" });
  const done = await step(w, { step: "respond", decision: "approve", pin: "246810" });
  assert.deepEqual(done, { kind: "done", decision: "approve", status: "approved" });
  const grants = w.vtaCalls.filter((c) => c.what === "grant");
  const last = grants.at(-1)!.decision as { payloadDigest: string; pin: string };
  assert.equal(last.pin, "246810");
  assert.equal(
    bytesToBase64url(new TextEncoder().encode(last.payloadDigest)),
    (challenge as { challenge: string }).challenge,
    "the PIN's proof is over the digest of the grant then sent",
  );
  assert.equal(w.vtaCalls.some((c) => c.what === "enrol-method"), false, "an existing PIN is not enrolled again");
});

test("vtaPin, first time: the PIN is enrolled before the grant is signed", async () => {
  const w = world();
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const done = await step(w, { step: "respond", decision: "approve", pin: "correct horse", setPin: true });
  assert.equal(done.kind, "done");
  const whats = w.vtaCalls.map((c) => c.what);
  assert.ok(whats.indexOf("enrol-method") < whats.indexOf("grant"));
  assert.deepEqual(w.vtaCalls.find((c) => c.what === "enrol-method")!.decision, { kind: "vtaPin", pin: "correct horse" });
  // K from the enrolment reaches the first proof (derived once), and is wiped
  // once the grant is signed.
  const grant = w.vtaCalls.find((c) => c.what === "grant")!.decision as { pin: string; pinKey: Uint8Array };
  assert.equal(grant.pin, "correct horse");
  assert.ok(grant.pinKey instanceof Uint8Array);
  assert.ok(grant.pinKey.every((b) => b === 0), "wiped");
});

test("vtaPin: the wrong PIN that imposes the lock is shown as the lock", async () => {
  const w = world({
    uvMethod: "vtaPin",
    grantAnswers: [uvRefusal({ code: "oobUvPinWrong", attemptsRemaining: 0, lockedUntil: 1_791_461_800 })],
  });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  assert.deepEqual(await step(w, { step: "respond", decision: "approve", pin: "000000" }), {
    kind: "uv-pin",
    attemptsRemaining: 0,
    lockedUntil: 1_791_461_800_000,
  });
});

test("a phone the agent will not let approve for this browser is said plainly", async () => {
  const w = world({
    enrolError: Object.assign(new Error("device/heartbeat refused: uvApproverNotPermitted"), {
      details: { code: "taskFailed", details: {} },
    }),
  });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const r = await step(w, { step: "respond", decision: "approve", remote: true, approver: "did:key:z6MkPhone" });
  assert.deepEqual(r, {
    kind: "failed",
    code: "uvApproverNotPermitted",
    message: UV_APPROVER_HELP,
    stage: "enrol-uv",
    party: "vta",
  });
});

test("a PIN the agent will not enrol stops the approval at enrol-uv, before any grant", async () => {
  const w = world({ enrolError: new Error("refused") });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const res = await step(w, { step: "respond", decision: "approve", pin: "123456", setPin: true });
  assert.equal(res.kind, "failed");
  assert.equal((res as { stage?: string }).stage, "enrol-uv");
  assert.equal(w.vtaCalls.some((c) => c.what === "grant"), false);
});

test("remoteApprover: pending with the phone's code, polled with the same grant, then signed", async () => {
  const pending = uvRefusal({ code: "oobUvPending", matchCode: "42", expiresAt: 1_791_461_020 });
  const w = world({ grantAnswers: [pending, pending, undefined] });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const first = await step(w, { step: "respond", decision: "approve", remote: true, approver: "did:key:z6MkPhone" });
  assert.deepEqual(first, { kind: "uv-pending", matchCode: "42", expiresAt: 1_791_461_020_000 });
  assert.deepEqual(w.vtaCalls.find((c) => c.what === "enrol-method")!.decision, {
    kind: "remoteApprover",
    approver: "did:key:z6MkPhone",
  });
  const again = await step(w, { step: "respond", decision: "approve", remote: true });
  assert.equal(again.kind, "uv-pending");
  const done = await step(w, { step: "respond", decision: "approve", remote: true });
  assert.deepEqual(done, { kind: "done", decision: "approve", status: "approved" });

  const grants = w.vtaCalls.filter((c) => c.what === "grant").map((c) => c.decision as { payloadDigest: string; remote: true });
  assert.equal(grants.length, 3);
  assert.ok(grants.every((g) => g.remote === true && g.payloadDigest === grants[0]!.payloadDigest), "the same grant, each time");
  assert.equal(w.vtaCalls.filter((c) => c.what === "enrol-method").length, 1, "the phone is enrolled once");
  assert.deepEqual(w.sent.map((s) => s.type), ["claim", "prove", "respond"]);
});

test("remoteApprover: a decline on the phone ends the sign-in, and the portal stops waiting", async () => {
  const w = world({ uvMethod: "remoteApprover", grantAnswers: [uvRefusal({ code: "oobUvDeclined" })] });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const r = await step(w, { step: "respond", decision: "approve", remote: true });
  assert.deepEqual(r, { kind: "failed", code: "oobUvDeclined", message: VTA_REFUSAL_MESSAGES.oobUvDeclined, stage: "grant", party: "vta" });
  assert.deepEqual(w.sent.map((s) => s.type), ["claim", "prove", "cancel"]);
});

test("remoteApprover: a phone that never answered is expired", async () => {
  const w = world({ uvMethod: "remoteApprover", grantAnswers: [uvRefusal({ code: "oobUvExpired" })] });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  const r = await step(w, { step: "respond", decision: "approve", remote: true });
  assert.equal((r as { code: string }).code, "oobUvExpired");
  assert.equal((r as { message: string }).message, VTA_REFUSAL_MESSAGES.oobUvExpired);
});

test("remoteApprover: cancelling while the phone is asked stops everything; a later poll is refused unsent", async () => {
  const w = world({ uvMethod: "remoteApprover", grantAnswers: [uvRefusal({ code: "oobUvPending", matchCode: "07" })] });
  await toReview(w);
  await step(w, { step: "grant-digest" });
  assert.equal((await step(w, { step: "respond", decision: "approve", remote: true })).kind, "uv-pending");
  await step(w, { step: "cancel" });
  const grants = w.vtaCalls.filter((c) => c.what === "grant").length;
  const late = await step(w, { step: "respond", decision: "approve", remote: true });
  assert.equal(late.kind, "failed");
  assert.equal(w.vtaCalls.filter((c) => c.what === "grant").length, grants, "no grant is signed after the cancel");
  assert.deepEqual(w.sent.map((s) => s.type), ["claim", "prove", "cancel"]);
});

test("the phones to approve on come from the agent; a listing it refuses is empty, with why, and the flow goes on", async () => {
  const w = world({ approvers: [{ did: "did:key:z6MkPhone", displayName: "Alice's iPhone" }] });
  await toReview(w);
  assert.deepEqual(await step(w, { step: "uv-approvers" }), {
    kind: "uv-approvers",
    approvers: [{ did: "did:key:z6MkPhone", displayName: "Alice's iPhone" }],
  });
  const w2 = world({ approvers: new Error("unsupportedType") });
  await toReview(w2);
  assert.deepEqual(await step(w2, { step: "uv-approvers" }), { kind: "uv-approvers", approvers: [], error: "unsupportedType" });
  assert.equal(w2.flows.has("f1"), true);
});

// ── A new identity for the community ────────────────────────────────────────

test("a community's context id is its verified host, in the characters an agent takes", () => {
  assert.equal(communityContextId("members.example.org"), "vtc-members.example.org");
  assert.equal(communityContextId("Members.Example.ORG"), "vtc-members.example.org");
  assert.equal(communityContextId("xn--bcher-kva.example"), "vtc-xn--bcher-kva.example");
  assert.equal(communityContextId(""), "vtc-community");
  const long = communityContextId(`${"a".repeat(70)}.example`);
  assert.ok(long.length <= 64 && /^[a-z0-9.-]+$/.test(long) && !/[-.]$/.test(long));
});

test("the join screen offers a new identity, in a context of the community's own", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, servers: [{ id: "host-1", label: "My host" }] });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join-manifest" });
  assert.equal(r.kind, "join-apply");
  assert.deepEqual((r as { newIdentity?: unknown }).newIdentity, {
    contextId: "vtc-members.example.org",
    servers: [{ id: "host-1", label: "My host" }],
  });
  assert.equal(w.vtaCalls.some((c) => c.what === "create-identity"), false, "nothing made until asked");
});

test("an agent that won't list its hosting servers gets no offer", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, servers: new Error("forbidden") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "join-manifest" });
  assert.equal(r.kind, "join-apply");
  assert.equal("newIdentity" in r, false);
});

test("joining as a new identity: it is made first, then recorded, signed and sent as that identity", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, servers: [{ id: "host-1" }, { id: "host-2" }] });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = await step(w, { step: "join-submit", newIdentity: { serverId: "host-2" }, attributes: NAME, registryConsent: false });
  assert.deepEqual(r, { kind: "join-pending", host: "members.example.org", portalOrigin: PORTAL });
  const made = w.vtaCalls.filter((c) => c.what === "create-identity");
  assert.deepEqual(made.map((c) => c.decision), [
    { contextId: "vtc-members.example.org", name: "members.example.org", serverId: "host-2" },
  ]);
  const order = w.vtaCalls.map((c) => c.what).filter((x) => ["create-identity", "bind", "sign-task"].includes(x));
  assert.deepEqual(order, ["create-identity", "bind", "sign-task"]);
  assert.deepEqual(w.binds, [{ origin: PORTAL, did: NEW_DID, rpDid: VTC }]);
  assert.equal((w.sent[1]!.doc as { issuer: string }).issuer, NEW_DID);
});

test("a new identity the agent couldn't make: said so, and nothing about the person is sent", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, servers: [{ id: "host-1" }], createIdentityError: new Error("contexts/create: forbidden") });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = (await step(w, { step: "join-submit", newIdentity: { serverId: "host-1" }, attributes: NAME, registryConsent: false })) as {
    kind: string;
    stage?: string;
    message: string;
  };
  assert.equal(r.kind, "failed");
  assert.equal(r.stage, "join-identity");
  assert.match(r.message, /couldn't set up an identity for members\.example\.org/);
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
  assert.equal(w.binds.length, 0);
});

test("a new identity on a server the wallet didn't offer is out of order", async () => {
  const w = world({ known: UNKNOWN, doc: communityDoc, servers: [{ id: "host-1" }] });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  await step(w, { step: "join-manifest" });
  const r = await step(w, { step: "join-submit", newIdentity: { serverId: "elsewhere" }, attributes: NAME, registryConsent: false });
  assert.equal(r.kind, "failed");
  assert.equal(w.vtaCalls.some((c) => c.what === "create-identity"), false);
  assert.deepEqual(w.sent.map((s) => s.type), ["join-manifest"]);
});
