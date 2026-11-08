// A step-up handed to the person by a `step-up` trigger link (VTI-LNK-125 –
// 131), against a fake community and a fake agent.
//
// Pinned: nothing is sent to a community the wallet holds no identity at; the
// read goes from a fresh key with the handle; what comes back is the
// community's signed request to the subject, bound to the returned operation;
// a subject the wallet holds no identity for there stops the flow; the answer
// is signed by the agent as the subject and sent to the community, never
// anywhere else; a spent handle reads as an expired code.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateSigningIdentity, signTrustTask, vtcStepUpBoundTo } from "@openvtc/pnm-core";
import { StepUpFlows, STEP_UP_NOT_FOUND } from "../src/step-up-flows.ts";
import type { SignInVaultEntry } from "../src/sign-in-flows.ts";

const VTC = "did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org";
const PORTAL = "https://members.example.org";
const BASE = "https://members.example.org/v1";
const ENDPOINT = `${BASE}/trust-tasks`;
const HANDLE = "Hk2pQ9xV4mT7rW1sZ8yN3A";
const NOW = Date.now();
const LINK = `https://link.trustoverip.org/t#_from=${VTC}&_id=${HANDLE}&_exp=${Math.floor(NOW / 1000) + 200}&_type=/vti/flow/step-up/0.1`;
const ALICE = "did:webvh:QmAlice:members.example.org:alice";
const SHOW = "https://trusttasks.org/spec/auth/step-up/requests/show/0.1";
const APPROVE_REQUEST = "https://trusttasks.org/spec/auth/step-up/approve-request/0.5";
const APPROVE_RESPONSE = "https://trusttasks.org/spec/auth/step-up/approve-response/0.7";
const OP = {
  type: "https://trusttasks.org/spec/auth/step-up/approver/invite/0.2",
  payload: { subject: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" },
};

const vtcKey = generateSigningIdentity();
const VM = `${VTC}#key-1`;
const vtcSigner = { ...vtcKey, did: VTC, kid: VM };
const vtcDoc = {
  id: VTC,
  verificationMethod: [{ id: VM, type: "Multikey", controller: VTC, publicKeyMultibase: vtcKey.did.slice(8) }],
  assertionMethod: [VM],
  authentication: [VM],
  service: [
    { id: `${VTC}#sign-in-portal`, type: "SignInPortal", serviceEndpoint: `${PORTAL}/members/` },
    { id: `${VTC}#tt`, type: "TrustTaskHTTPS", serviceEndpoint: BASE },
  ],
};

const aliceEntry: SignInVaultEntry = {
  id: "e-alice",
  label: "Alice at Example Community",
  secretKind: "didSelfIssued",
  principalDid: ALICE,
  targets: [{ kind: "did", did: VTC }],
};

async function inline(subject = ALICE) {
  const challenge = "q3XKtZJ0p8m4Ud2vWcH7Rs1aLyN6bEf9";
  return {
    subject,
    challenge,
    boundTo: await vtcStepUpBoundTo(OP.type, OP.payload, challenge),
    reason: "Invite an approver",
    accepts: ["approverSigned"],
    approvers: ["did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"],
  };
}

async function signed(doc: Record<string, unknown>): Promise<Record<string, unknown>> {
  await signTrustTask({ envelope: doc, signing: vtcSigner, proofPurpose: "authentication" });
  return doc;
}

interface World {
  flows: StepUpFlows;
  sent: Array<{ url: string; doc: Record<string, unknown> }>;
  signedByAgent: Array<{ entryId: string; doc: Record<string, unknown> }>;
}

function world(
  opts: {
    entries?: SignInVaultEntry[];
    subject?: string;
    operation?: typeof OP;
    show?: "notFound";
    answerStatus?: string;
  } = {},
): World {
  const sent: World["sent"] = [];
  const signedByAgent: World["signedByAgent"] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const doc = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({ url, doc });
    if (doc.type === SHOW && opts.show === "notFound") {
      return new Response(
        JSON.stringify({
          type: "https://trusttasks.org/spec/trust-task-error/0.3",
          payload: { code: STEP_UP_NOT_FOUND, retryable: false },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    let payload: unknown;
    if (doc.type === SHOW) {
      const request = await signed({
        id: crypto.randomUUID(),
        type: APPROVE_REQUEST,
        issuer: VTC,
        recipient: opts.subject ?? ALICE,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
        payload: await inline(opts.subject ?? ALICE),
      });
      payload = { request, operation: opts.operation ?? OP };
    } else {
      payload = { status: opts.answerStatus ?? "recorded" };
    }
    const res = await signed({
      id: crypto.randomUUID(),
      type: `${String(doc.type)}#response`,
      issuer: VTC,
      recipient: doc.issuer,
      threadId: doc.id,
      issuedAt: new Date().toISOString(),
      payload,
    });
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const flows = new StepUpFlows({
    now: () => Date.now(),
    fetch,
    resolveDid: async (did) => {
      assert.equal(did, VTC);
      return { didDocument: vtcDoc };
    },
    vta: () => ({
      listIdentities: async () => opts.entries ?? [aliceEntry],
      signTask: async (entryId, unsigned) => {
        signedByAgent.push({ entryId, doc: unsigned as unknown as Record<string, unknown> });
        return { ...(unsigned as object), proof: { proofPurpose: "assertionMethod" } };
      },
    }),
  });
  return { flows, sent, signedByAgent };
}

test("VTI-LNK-128: a community the wallet holds no identity at is sent nothing", async () => {
  const w = world({ entries: [] });
  const r = await w.flows.read(LINK, "did:web:vta.example");
  assert.deepEqual(r, { ok: false, reason: "not-in-records" });
  assert.equal(w.sent.length, 0);
});

test("VTI-LNK-128: a link on another flow is not a step-up", async () => {
  const w = world();
  const r = await w.flows.read(LINK.replace("step-up", "sign-in"), "did:web:vta.example");
  assert.deepEqual(r, { ok: false, reason: "unknown-flow" });
  assert.equal(w.sent.length, 0);
});

test("VTI-LNK-129 – 131: read from a fresh key, shown from the community's own request, answered as the subject", async () => {
  const w = world();
  const r = await w.flows.read(LINK, "did:web:vta.example");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [read] = w.sent;
  assert.equal(read!.url, ENDPOINT);
  assert.equal(read!.doc.type, SHOW);
  assert.match(String(read!.doc.issuer), /^did:key:z6Mk/);
  assert.equal(read!.doc.parentThreadId, HANDLE);
  assert.deepEqual(read!.doc.payload, { handle: HANDLE });

  assert.equal(r.view.vtcDid, VTC);
  assert.equal(r.view.identityLabel, "Alice at Example Community", "the wallet's own record");
  assert.equal(r.view.portalOrigin, PORTAL);
  assert.equal(r.view.request.subject, ALICE);
  assert.deepEqual(r.view.operation, OP);

  const answer = await w.flows.answer(r.view.flowId, { id: "urn:uuid:statement" });
  assert.deepEqual(answer, { ok: true });
  const [agent] = w.signedByAgent;
  assert.equal(agent!.entryId, "e-alice");
  assert.equal(agent!.doc.type, APPROVE_RESPONSE);
  assert.equal(agent!.doc.issuer, ALICE);
  const posted = w.sent[1]!;
  assert.equal(posted.url, ENDPOINT, "to the community, and nowhere else");
  assert.deepEqual((posted.doc.payload as Record<string, unknown>).evidence, {
    kind: "approverSigned",
    statement: { id: "urn:uuid:statement" },
  });
  assert.equal(w.sent.length, 2);

  // A flow answers once.
  assert.deepEqual(await w.flows.answer(r.view.flowId, {}), { ok: false, reason: "step-up-gone" });
});

test("VTI-LNK-130: a subject the wallet holds no identity for there stops the flow", async () => {
  const w = world({ subject: "did:webvh:QmBob:members.example.org:bob" });
  const r = await w.flows.read(LINK, "did:web:vta.example");
  assert.deepEqual(r, { ok: false, reason: "not-the-subject" });
});

test("VTI-LNK-130: an operation that is not the bound one is binding-mismatch", async () => {
  const w = world({ operation: { ...OP, payload: { subject: "did:key:z6MkSomeoneElse" } } });
  const r = await w.flows.read(LINK, "did:web:vta.example");
  assert.deepEqual(r, { ok: false, reason: "binding-mismatch" });
});

test("VTI-LNK-129: a spent handle reads as an expired code", async () => {
  const w = world({ show: "notFound" });
  const r = await w.flows.read(LINK, "did:web:vta.example");
  assert.deepEqual(r, { ok: false, reason: "step-up-gone" });
});

test("a declined flow is forgotten: nothing more is sent", async () => {
  const w = world();
  const r = await w.flows.read(LINK, "did:web:vta.example");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  w.flows.end(r.view.flowId);
  assert.deepEqual(await w.flows.answer(r.view.flowId, {}), { ok: false, reason: "step-up-gone" });
  assert.equal(w.sent.length, 1);
});
