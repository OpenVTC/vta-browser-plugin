// Route B, end to end (dtgwg-vti-spec #58): a contact whose DID names no host
// is held to the portal's DIF DID Configuration after the person continues
// and before the claim. No method is domain-linked today, so the flow is
// driven with a test-only method registered in a fresh registry — which is
// also the proof that adding one needs nothing but registering it.
//
// Pinned: nothing reaches the portal before Continue; the configuration is
// fetched after it and before the claim; the claim follows only a valid
// linkage; a failure is `domain-not-linked` with nothing sent; and the join
// path (an unknown DID hosting service) checks before it records anything.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSigningIdentity, signTrustTask, defaultContactMethods } from "@openvtc/pnm-core";
import {
  SignInFlows,
  SIGN_IN_DOMAIN_NOT_LINKED,
  DOMAIN_NOT_LINKED_MESSAGE,
  type SignInVaultEntry,
} from "../src/sign-in-flows.ts";
import { failureDetails } from "../src/sign-in-failure.ts";

const VTC = "did:test:QmCommunity";
const PORTAL = "https://portal.example.org";
const BASE = "https://api.example.org/v1";
const ENDPOINT = `${BASE}/trust-tasks`;
const CONFIG_URL = `${PORTAL}/.well-known/did-configuration.json`;
const ID = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const NOW = 1_791_460_900_000;
const DAY = 86_400_000;
const LINK = `https://link.trustoverip.org/t#_from=${VTC}&_id=${ID}&_exp=${Math.floor(NOW / 1000) + 100}&_type=/vti/flow/sign-in/0.1`;
const ALICE = "did:webvh:QmAlice:members.example.org:alice";

const vtcKey = generateSigningIdentity();
const VM = `${VTC}#key-1`;
const signing = { ...vtcKey, did: VTC, kid: VM };
const services = [
  { id: `${VTC}#sign-in-portal`, type: "SignInPortal", serviceEndpoint: `${PORTAL}/members/` },
  { id: `${VTC}#tt`, type: "TrustTaskHTTPS", serviceEndpoint: BASE },
];
const vtcDoc = {
  id: VTC,
  verificationMethod: [{ id: VM, type: "Multikey", controller: VTC, publicKeyMultibase: vtcKey.did.slice(8) }],
  assertionMethod: [VM],
  service: services,
};
const hostingDoc = {
  ...vtcDoc,
  service: [...services, { id: `${VTC}#webvh-hosting`, type: "WebVHHosting", serviceEndpoint: { uri: PORTAL } }],
};

const entries: SignInVaultEntry[] = [
  { id: "e-alice", label: "Example Community", secretKind: "didSelfIssued", principalDid: ALICE, targets: [{ kind: "did", did: VTC }] },
];

/** The Domain Linkage Credential the community publishes, JSON-LD with an
 *  `eddsa-jcs-2022` proof. */
async function linkage(origin = PORTAL) {
  const cred: Record<string, unknown> = {
    "@context": ["https://www.w3.org/2018/credentials/v1", "https://identity.foundation/.well-known/did-configuration/v1"],
    type: ["VerifiableCredential", "DomainLinkageCredential"],
    issuer: VTC,
    issuanceDate: new Date(NOW - DAY).toISOString(),
    expirationDate: new Date(NOW + DAY).toISOString(),
    credentialSubject: { id: VTC, origin },
  };
  await signTrustTask({ envelope: cred, signing, proofPurpose: "assertionMethod" });
  return { "@context": "https://identity.foundation/.well-known/did-configuration/v1", linked_dids: [cred] };
}

interface World {
  flows: SignInFlows;
  /** Every request, in order: `GET <url>` or the task posted. */
  log: string[];
  binds: number;
}

function world(opts: { config?: unknown; configStatus?: number; doc?: Record<string, unknown>; known?: SignInVaultEntry[] } = {}): World {
  const w: World = { flows: undefined as unknown as SignInFlows, log: [], binds: 0 };
  const sessionKey = generateSigningIdentity().did;
  const step1 = {
    requestId: ID,
    service: { did: VTC, name: "Example Community" },
    origin: PORTAL,
    purpose: "login",
    decisionDeadline: Math.floor(NOW / 1000) + 120,
  };
  const fetch = (async (url: string, init: RequestInit) => {
    if (url === CONFIG_URL) {
      w.log.push(`GET ${url}`);
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      return new Response(JSON.stringify(opts.config ?? (await linkage())), { status: opts.configStatus ?? 200 });
    }
    assert.equal(url, ENDPOINT);
    const doc = JSON.parse(String(init.body));
    const type = String(doc.type).replace("https://trusttasks.org/spec/auth/oob/", "").replace(/\/0\.[12]$/, "");
    w.log.push(type);
    const payload =
      type === "claim"
        ? step1
        : type === "prove"
          ? {
              ...step1,
              sessionKey,
              requester: { location: "Sydney", browser: "Chrome", os: "macOS", createdAt: new Date(NOW).toISOString(), sameNetwork: true },
              identifiedAs: doc.payload.identify.issuer,
            }
          : { status: "cancelled" };
    const res = { id: crypto.randomUUID(), type: `${doc.type}#response`, issuer: VTC, recipient: doc.issuer, threadId: doc.id, issuedAt: new Date().toISOString(), payload };
    await signTrustTask({ envelope: res, signing, proofPurpose: "assertionMethod" });
    return new Response(JSON.stringify(res), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  // The test-only method: route B, resolving to the fixture document.
  const contactMethods = defaultContactMethods().register({
    kind: "did:test",
    route: "domain-linked",
    listsServices: true,
    verified: true,
    resolve: async (did) => ({ ok: true, doc: { ...(opts.doc ?? vtcDoc), id: did } }),
  });

  w.flows = new SignInFlows({
    now: () => NOW,
    grantLifetimeMs: 3_600_000,
    fetch,
    contactMethods,
    vta: () => ({
      listIdentities: async () => opts.known ?? entries,
      listPersonas: async () => [{ did: "did:webvh:QmBob:dids.example.net:bob", contextId: "personal" }],
      bindIdentity: async (binding) => {
        w.binds++;
        return { entryId: "e-new", label: new URL(binding.origin).hostname };
      },
      signIdentify: async (_e, unsigned) => ({ ...(unsigned as object), proof: { proofPurpose: "authentication" } }),
      signGrant: async (_e, unsigned) => ({ ...(unsigned as object), proof: { proofPurpose: "assertionMethod" } }),
      enrolUvKey: async () => {},
    }),
  });
  return w;
}

const step = (w: World, s: Record<string, unknown>, flowId = "f1") =>
  w.flows.step({ flowId, vtaDid: "did:webvh:vta", ...s } as Parameters<SignInFlows["step"]>[0]);

test("a domain-linked contact is unsupported-vid with the shared registry", async () => {
  // Same link, the wallet's own registry: no method is domain-linked yet.
  const flows = new SignInFlows({
    now: () => NOW,
    grantLifetimeMs: 1,
    fetch: (async () => assert.fail("nothing is fetched")) as unknown as typeof fetch,
    vta: () => ({ listIdentities: async () => entries }) as never,
  });
  const r = await flows.step({ flowId: "f", vtaDid: "did:webvh:vta", step: "prepare", link: LINK, origin: PORTAL } as never);
  assert.deepEqual(r, { kind: "refused", outcome: "update", message: "This code needs a newer version of the app." });
});

test("nothing reaches the portal before Continue; the linkage is fetched after it, then the claim", async () => {
  const w = world();
  const prepared = await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal(prepared.kind, "confirm");
  assert.deepEqual(w.log, [], "no request of any kind before Continue");

  const claimed = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(claimed.kind, "enter-number");
  assert.deepEqual(w.log, [`GET ${CONFIG_URL}`, "claim"]);

  // Checked once: proving does not fetch it again.
  const proved = await step(w, { step: "prove", enteredNumber: "47" });
  assert.equal(proved.kind, "review");
  assert.deepEqual(w.log, [`GET ${CONFIG_URL}`, "claim", "prove"]);
});

test("a portal not linked to the DID: domain-not-linked, and nothing is sent", async () => {
  for (const config of [await linkage("https://other.example.org"), { "@context": "https://example.org/x", linked_dids: [] }]) {
    const w = world({ config });
    await step(w, { step: "prepare", link: LINK, origin: PORTAL });
    const r = await step(w, { step: "claim", entryId: "e-alice" });
    assert.deepEqual(r, {
      kind: "failed",
      code: SIGN_IN_DOMAIN_NOT_LINKED,
      message: DOMAIN_NOT_LINKED_MESSAGE,
      stage: "domain-linkage",
      detail: { reason: "domain-not-linked", did: VTC, portalOrigin: PORTAL },
    });
    assert.deepEqual(w.log, [`GET ${CONFIG_URL}`], "nothing was posted to the community");
    assert.equal(w.flows.has("f1"), false, "the flow ended");
    // Closing the window afterwards sends nothing either.
    await w.flows.abort("f1");
    assert.deepEqual(w.log, [`GET ${CONFIG_URL}`]);
    const rows = Object.fromEntries(failureDetails(r as Extract<typeof r, { kind: "failed" }>));
    assert.equal(rows.Code, "domain-not-linked");
    assert.match(rows.Meaning!, /DID Configuration/);
    assert.ok(rows.Meaning!.includes(PORTAL), "names the origin that was checked");
    assert.equal(rows.DID, VTC);
    assert.match(rows.Step!, /website belongs to the community/);
  }
});

test("a configuration the portal does not serve is domain-not-linked", async () => {
  const w = world({ configStatus: 404 });
  await step(w, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(w, { step: "claim", entryId: "e-alice" });
  assert.equal(r.kind === "failed" && r.code, SIGN_IN_DOMAIN_NOT_LINKED);
  assert.deepEqual(w.log, [`GET ${CONFIG_URL}`]);
});

test("join (an unknown DID hosting service): the linkage is checked before anything is recorded or sent", async () => {
  const ok = world({ doc: hostingDoc, known: [] });
  const offer = await step(ok, { step: "prepare", link: LINK, origin: PORTAL });
  assert.equal(offer.kind, "join-hosting");
  assert.deepEqual(ok.log, []);
  const confirm = await step(ok, { step: "join", did: "did:webvh:QmBob:dids.example.net:bob" });
  assert.equal(confirm.kind, "confirm");
  assert.equal(ok.binds, 1);
  assert.deepEqual(ok.log, [`GET ${CONFIG_URL}`]);
  // The claim does not fetch it again.
  await step(ok, { step: "claim", entryId: "e-new" });
  assert.deepEqual(ok.log, [`GET ${CONFIG_URL}`, "claim"]);

  const bad = world({ doc: hostingDoc, known: [], config: await linkage("https://other.example.org") });
  await step(bad, { step: "prepare", link: LINK, origin: PORTAL });
  const r = await step(bad, { step: "join", did: "did:webvh:QmBob:dids.example.net:bob" });
  assert.equal(r.kind === "failed" && r.code, SIGN_IN_DOMAIN_NOT_LINKED);
  assert.equal(bad.binds, 0, "nothing recorded");
  assert.deepEqual(bad.log, [`GET ${CONFIG_URL}`], "nothing sent");
});
