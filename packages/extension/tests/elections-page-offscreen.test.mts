// The offscreen half of `window.vtaWallet.elections`: the member's VTA is asked,
// and what it signs is carried — reads and the ticket request to the community,
// the cast to the ballot box. Against a fake VTA, a community that signs its
// replies, and a ballot box that signs its receipt.
//
// What is pinned: nothing the community receives carries a ballot or a cast;
// the cast reaches the ballot box exactly as the VTA built it, after the pause
// the background chose (capped);
// the receipt goes back to the VTA; the community's ticket answer reaches the
// VTA without its `ext`.

import test from "node:test";
import assert from "node:assert/strict";

import { generateSigningIdentity, signTrustTask } from "@openvtc/pnm-core";

import { runElectionsPageOp, type ElectionsPageDeps } from "../src/elections-page-offscreen.ts";

const VTC = "did:webvh:QmCommunity:acme.example";
const PORTAL = "https://members.acme.example";
const ENDPOINT = "https://vtc.acme.example/v1/trust-tasks";
const BOX_BASE = "https://ballots.example";
const BOX_DOOR = `${BOX_BASE}/trust-tasks`;
const MEMBER = "did:webvh:QmAlice:people.example";
const VTA = { vtaDid: "did:webvh:QmVta:vta.example" };
const DIGEST = "uEiDigest";
const T = "https://trusttasks.org/spec/";

const vtcKey = generateSigningIdentity();
const VM = `${VTC}#key-1`;
const vtcSigner = { ...vtcKey, did: VTC, kid: VM };
const vtcDoc = {
  id: VTC,
  verificationMethod: [{ id: VM, type: "Multikey", controller: VTC, publicKeyMultibase: vtcKey.did.slice("did:key:".length) }],
  assertionMethod: [VM],
  authentication: [VM],
};
const box = generateSigningIdentity();
const voterKey = generateSigningIdentity();

const manifest = {
  electionId: "agm-2027",
  community: VTC,
  questions: [{ key: "chair", type: "choice", options: [{ key: "ana" }, { key: "bo" }], minSelections: 1, maxSelections: 1, optional: false }],
  secrecy: "open",
  ballotBox: box.did,
};
const shown = { manifest, manifestDigest: DIGEST, state: "voting", parameters: { suite: "s" }, disclosure: {}, checkpoints: [] };
const ballot = { electionId: "agm-2027", manifestDigest: DIGEST, answers: [{ question: "chair", choice: ["ana"] }] };

const memberDoc = (type: string, payload: unknown) => ({
  id: crypto.randomUUID(),
  type,
  issuer: MEMBER,
  recipient: VTC,
  issuedAt: new Date().toISOString(),
  payload,
  proof: { type: "DataIntegrityProof" },
});

const PARTY = "did:webvh:QmParty:party.example";
const VMC = { id: "cred-party", types: ["VerifiableCredential", "MembershipCredential"], issuerDid: PARTY, status: "valid" };

interface WorldOpts {
  registerFails?: string;
  /** The election's roll: the holders of a membership credential for this DID. */
  memberOf?: string;
  /** The member's vault, as `vault/credentials/query` answers it. */
  vault?: Record<string, unknown>[];
  /** The community refuses the n-th document it receives (0-based) with this code. */
  refuse?: { at: number; code: string; retryable?: boolean }[];
}

function world(opts: WorldOpts = {}) {
  const vtaAsked: { type: string; payload: Record<string, unknown> }[] = [];
  const toCommunity: Record<string, unknown>[] = [];
  const toBox: Record<string, unknown>[] = [];
  const slept: number[] = [];
  let cast: Record<string, unknown> | undefined;
  const election = opts.memberOf
    ? {
        ...shown,
        manifest: { ...manifest, roll: { rule: "credential", memberOf: opts.memberOf } },
        disclosure: { rollCredential: { memberOf: opts.memberOf, memberOfKind: "memberParty", presenterDisclosed: true } },
      }
    : shown;

  const sender = {
    async send(envelope: { type: string; payload: Record<string, unknown> }) {
      vtaAsked.push(envelope);
      const p = envelope.payload;
      switch (envelope.type) {
        case `${T}vta/pcs/voter/read/0.6`:
          return {
            document: memberDoc(
              p.read === "list" ? `${T}vtc/elections/list/0.5` : `${T}vtc/elections/show/0.6`,
              p.membershipCredential ? { ...(p.payload as object), presentation: { holder: MEMBER, of: p.membershipCredential } } : p.payload,
            ),
          };
        case `${T}vault/credentials/query/0.1`:
          return { credentials: (opts.vault ?? []).filter((c) => c.issuerDid === p.issuerDid) };
        case `${T}vta/pcs/voter/register/0.5`:
          if (opts.registerFails) throw new Error(opts.registerFails);
          return {
            electionId: "agm-2027",
            manifestDigest: DIGEST,
            request: {},
            ticketDocument: memberDoc(`${T}vtc/elections/tickets/issue/0.3`, {
              electionId: "agm-2027",
              ...(p.membershipCredential ? { presentation: { holder: MEMBER, of: p.membershipCredential } } : {}),
            }),
          };
        case `${T}vta/pcs/voter/accept/0.1`:
          return { electionId: "agm-2027", ticketHeld: true };
        case `${T}vta/pcs/vote/0.4`:
          cast = {
            id: crypto.randomUUID(),
            type: `${T}voting/ballot/cast/0.1#request`,
            issuer: voterKey.did,
            recipient: box.did,
            issuedAt: new Date().toISOString(),
            payload: { sealed: "…" },
            proof: { type: "DataIntegrityProof" },
          };
          return { castDocument: cast, tag: "zTag" };
        case `${T}vta/pcs/voter/receipt/0.1`:
          return { electionId: "agm-2027", status: "included", leafIndex: 7 };
      }
      throw new Error(`unexpected ${envelope.type}`);
    },
  };

  const fetch = async (url: string, init: RequestInit) => {
    const doc = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url === BOX_DOOR) {
      toBox.push(doc);
      const r = {
        id: crypto.randomUUID(),
        type: `${T}voting/ballot/cast/0.1#response`,
        issuer: box.did,
        recipient: doc.issuer,
        threadId: doc.id,
        issuedAt: new Date().toISOString(),
        payload: { outcome: "counted", leafIndex: 7 },
      };
      await signTrustTask({ envelope: r, signing: box, proofPurpose: "assertionMethod" });
      return new Response(JSON.stringify(r), { status: 200 });
    }
    toCommunity.push(doc);
    const type = String(doc.type);
    const refusal = opts.refuse?.find((x) => x.at === toCommunity.length - 1);
    if (refusal) {
      const err = {
        id: crypto.randomUUID(),
        type: `${T}trust-task-error/0.2`,
        issuer: VTC,
        recipient: doc.issuer,
        threadId: doc.id,
        issuedAt: new Date().toISOString(),
        payload: { code: refusal.code, retryable: refusal.retryable ?? false },
      };
      return new Response(JSON.stringify(err), { status: 400 });
    }
    const payload = type.endsWith("list/0.5")
      ? { elections: [{ electionId: "agm-2027", state: "voting", ticketHeld: true }] }
      : type.endsWith("show/0.6")
        ? election
        : { electionId: "agm-2027", label: "voter/agm-2027", preCredential: "zPre", ext: { "org.example": { x: 1 } } };
    const res = {
      id: crypto.randomUUID(),
      type: `${type}#response`,
      issuer: VTC,
      recipient: doc.issuer,
      threadId: doc.id,
      issuedAt: new Date().toISOString(),
      payload,
    };
    await signTrustTask({ envelope: res, signing: vtcSigner, proofPurpose: "authentication" });
    return new Response(JSON.stringify(res), { status: 200 });
  };

  const deps: ElectionsPageDeps = {
    async agent() {
      return { sender: sender as never, holder: { did: "did:key:zWallet" }, service: { did: VTA.vtaDid } };
    },
    async identities() {
      return [{ id: "e1", label: "Acme Guild", principalDid: MEMBER, targets: [{ kind: "did", did: VTC }] }] as never;
    },
    async contextOf() {
      return "vtc-acme";
    },
    community: async () => ({ portalOrigin: PORTAL, endpoint: ENDPOINT, document: vtcDoc }),
    resolve: async () => ({ id: box.did, service: [{ id: "#tt", type: "TrustTaskHTTPS", serviceEndpoint: BOX_BASE }] }),
    fetch: fetch as typeof globalThis.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { deps, vtaAsked, toCommunity, toBox, slept, cast: () => cast };
}

test("a list is read as the member, through their VTA, from the context their identity lives in", async () => {
  const w = world();
  const got = (await runElectionsPageOp(w.deps, VTA, { op: "list", hostDid: VTC, member: MEMBER })) as { elections: unknown[] };
  assert.equal(got.elections.length, 1);
  assert.deepEqual(w.vtaAsked[0]!.payload, { contextId: "vtc-acme", community: VTC, member: MEMBER, read: "list", payload: {} });
  assert.equal(w.toCommunity[0]!.issuer, MEMBER, "the community gets the document the VTA signed as the member");
});

test("a ticket: register as the member, the community issues it, the VTA accepts the answer without its ext", async () => {
  const w = world();
  const got = await runElectionsPageOp(w.deps, VTA, { op: "takeTicket", hostDid: VTC, member: MEMBER, electionId: "agm-2027" });
  assert.deepEqual(got, { taken: true });
  assert.deepEqual(
    w.vtaAsked.map((a) => a.type.slice(T.length)),
    ["vta/pcs/voter/read/0.6", "vta/pcs/voter/register/0.5", "vta/pcs/voter/accept/0.1"],
  );
  assert.equal(w.toCommunity[1]!.type, `${T}vtc/elections/tickets/issue/0.3`);
  assert.deepEqual(w.vtaAsked[2]!.payload.response, { electionId: "agm-2027", label: "voter/agm-2027", preCredential: "zPre" });
});

test("a ticket the agent already holds is not taken again", async () => {
  const w = world({ registerFails: "vta/pcs/voter/register:ticketHeld" });
  assert.deepEqual(
    await runElectionsPageOp(w.deps, VTA, { op: "takeTicket", hostDid: VTC, member: MEMBER, electionId: "agm-2027" }),
    { taken: false },
  );
  assert.equal(w.toCommunity.length, 1, "only the read reached the community");
});

async function castInSteps(w: ReturnType<typeof world>, delayMs: number) {
  const prepared = (await runElectionsPageOp(w.deps, VTA, {
    op: "castPrepare",
    hostDid: VTC,
    member: MEMBER,
    electionId: "agm-2027",
    ballot,
  })) as { castDocument: Record<string, unknown>; endpoint: string; ballotBox: string };
  const posted = (await runElectionsPageOp(w.deps, VTA, { op: "castPost", ...prepared, delayMs })) as {
    receipt: Record<string, unknown>;
  };
  const kept = await runElectionsPageOp(w.deps, VTA, {
    op: "castKeep",
    hostDid: VTC,
    member: MEMBER,
    electionId: "agm-2027",
    receipt: posted.receipt,
  });
  return { prepared, posted, kept };
}

test("a cast goes to the ballot box as the VTA built it, after the pause it is given, and never to the community", async () => {
  const w = world();
  const { prepared, posted, kept } = await castInSteps(w, 7_000);
  assert.equal(prepared.endpoint, BOX_DOOR);
  assert.equal(prepared.ballotBox, box.did);
  assert.deepEqual(prepared.castDocument, w.cast());
  assert.equal((posted.receipt.payload as { outcome: string }).outcome, "counted");
  assert.deepEqual(kept, { status: "included", leafIndex: 7 });
  assert.deepEqual(w.toBox, [w.cast()]);
  assert.deepEqual(w.slept, [7_000]);
  assert.equal(
    w.toCommunity.some((d) => JSON.stringify(d).includes("ballot") || JSON.stringify(d).includes("cast")),
    false,
    "the community saw no ballot and no cast",
  );
  const vote = w.vtaAsked.find((a) => a.type === `${T}vta/pcs/vote/0.4`)!;
  assert.deepEqual(vote.payload.ballot, ballot);
  const receipt = w.vtaAsked.at(-1)!;
  assert.equal(receipt.type, `${T}vta/pcs/voter/receipt/0.1`);
  assert.equal((receipt.payload.receipt as { issuer: string }).issuer, box.did);
});

test("the pause is capped at the longest the wallet waits, and never negative", async () => {
  const long = world();
  await castInSteps(long, 10 * 60_000);
  assert.deepEqual(long.slept, [20_000]);
  const negative = world();
  await castInSteps(negative, -5);
  assert.deepEqual(negative.slept, [0]);
});

test("a cast addressed to another ballot box is never posted", async () => {
  const w = world();
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, {
      op: "castPost",
      castDocument: { id: "c", recipient: "did:webvh:QmOther:other.example" },
      ballotBox: box.did,
      endpoint: BOX_DOOR,
      delayMs: 0,
    }),
    /another ballot box/,
  );
  assert.equal(w.toBox.length, 0);
});

test("a ballot that no longer fits the election is refused before the VTA builds a cast", async () => {
  const w = world();
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, {
      op: "castPrepare",
      hostDid: VTC,
      member: MEMBER,
      electionId: "agm-2027",
      ballot: { ...ballot, manifestDigest: "uEiOld" },
    }),
    /changed the election/,
  );
  assert.equal(w.vtaAsked.some((a) => a.type === `${T}vta/pcs/vote/0.4`), false);
  assert.equal(w.toBox.length, 0);
});

test("an identity the wallet does not hold at this community is refused", async () => {
  const w = world();
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, { op: "list", hostDid: VTC, member: "did:webvh:QmEve:eve.example" }),
    /no such identity/,
  );
});

// ── Credential rolls (VTI-VOT-015 – 018, 025) ───────────────────────────────

test("vti_vot_025: under a credential roll the claim presents the member's credential issued by exactly roll.memberOf", async () => {
  const other = { ...VMC, id: "cred-group", issuerDid: `${PARTY}:groups:g1` };
  const w = world({ memberOf: PARTY, vault: [other, VMC] });
  const got = await runElectionsPageOp(w.deps, VTA, {
    op: "takeTicket",
    hostDid: VTC,
    member: MEMBER,
    electionId: "agm-2027",
    presentFor: PARTY,
  });
  assert.deepEqual(got, { taken: true });
  const query = w.vtaAsked.find((a) => a.type === `${T}vault/credentials/query/0.1`)!;
  assert.deepEqual(query.payload, { issuerDid: PARTY, status: "valid", subjectDid: MEMBER });
  const register = w.vtaAsked.find((a) => a.type === `${T}vta/pcs/voter/register/0.5`)!;
  assert.equal(register.payload.membershipCredential, "cred-party", "the credential the party itself issued");
  assert.deepEqual((w.toCommunity[1]!.payload as { presentation: unknown }).presentation, { holder: MEMBER, of: "cred-party" });
});

test("vti_vot_016: a credential roll the member did not choose to present for is refused before anything is presented", async () => {
  const w = world({ memberOf: PARTY, vault: [VMC] });
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, { op: "takeTicket", hostDid: VTC, member: MEMBER, electionId: "agm-2027" }),
    /changed whose membership/,
  );
  assert.equal(w.vtaAsked.some((a) => a.type === `${T}vta/pcs/voter/register/0.5`), false);
  assert.equal(w.toCommunity.length, 1, "only the read, which presented nothing");
});

test("a member holding no credential from the roll's party is told so, and nothing is registered", async () => {
  const w = world({ memberOf: PARTY, vault: [{ ...VMC, issuerDid: "did:webvh:QmElse:else.example" }] });
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, { op: "takeTicket", hostDid: VTC, member: MEMBER, electionId: "agm-2027", presentFor: PARTY }),
    /don't hold a membership credential issued by did:webvh:QmParty/,
  );
  assert.equal(w.vtaAsked.some((a) => a.type === `${T}vta/pcs/voter/register/0.5`), false);
});

test("vti_vot_015: a read asked to present for a party carries the credential that party issued, with memberOf", async () => {
  const w = world({ memberOf: PARTY, vault: [VMC] });
  await runElectionsPageOp(w.deps, VTA, { op: "show", hostDid: VTC, member: MEMBER, electionId: "agm-2027", readAs: { memberOf: PARTY } });
  const read = w.vtaAsked.find((a) => a.type === `${T}vta/pcs/voter/read/0.6`)!;
  assert.equal(read.payload.membershipCredential, "cred-party");
  assert.equal(read.payload.memberOf, PARTY);
  assert.ok((w.toCommunity[0]!.payload as { presentation?: unknown }).presentation);
});

test("a read that presents nothing names no credential", async () => {
  const w = world({ memberOf: PARTY, vault: [VMC] });
  await runElectionsPageOp(w.deps, VTA, { op: "show", hostDid: VTC, member: MEMBER, electionId: "agm-2027" });
  const read = w.vtaAsked.find((a) => a.type === `${T}vta/pcs/voter/read/0.6`)!;
  assert.equal("membershipCredential" in read.payload, false);
  assert.equal("memberOf" in read.payload, false);
  assert.equal(w.vtaAsked.some((a) => a.type === `${T}vault/credentials/query/0.1`), false, "the vault is not even looked at");
});

test("membership answers whether the member holds a credential issued by exactly that party", async () => {
  const w = world({ vault: [VMC] });
  assert.deepEqual(await runElectionsPageOp(w.deps, VTA, { op: "membership", hostDid: VTC, member: MEMBER, memberOf: PARTY }), { held: true });
  assert.deepEqual(
    await runElectionsPageOp(w.deps, VTA, { op: "membership", hostDid: VTC, member: MEMBER, memberOf: "did:webvh:QmNone:none.example" }),
    { held: false },
  );
});

test("vti_vot_018: an indeterminate answer is resent as the same document, with backoff, and then succeeds", async () => {
  const w = world({
    memberOf: PARTY,
    vault: [VMC],
    refuse: [
      { at: 1, code: "indeterminate", retryable: true },
      { at: 2, code: "indeterminate", retryable: true },
    ],
  });
  const got = await runElectionsPageOp(w.deps, VTA, {
    op: "takeTicket",
    hostDid: VTC,
    member: MEMBER,
    electionId: "agm-2027",
    presentFor: PARTY,
  });
  assert.deepEqual(got, { taken: true });
  assert.equal(w.toCommunity.length, 4, "the read, then the claim three times");
  assert.deepEqual(w.toCommunity[1], w.toCommunity[2]);
  assert.deepEqual(w.toCommunity[2], w.toCommunity[3]);
  assert.deepEqual(w.slept, [2000, 4000]);
  assert.equal(w.vtaAsked.filter((a) => a.type === `${T}vta/pcs/voter/register/0.5`).length, 1, "the VTA was asked once");
});

test("an indeterminate answer that persists is said to be worth trying later, with its code", async () => {
  const refuse = [1, 2, 3, 4].map((at) => ({ at, code: "indeterminate", retryable: true }));
  const w = world({ memberOf: PARTY, vault: [VMC], refuse });
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, { op: "takeTicket", hostDid: VTC, member: MEMBER, electionId: "agm-2027", presentFor: PARTY }),
    (e: Error & { code?: string }) => e.code === "indeterminate" && /Nothing was recorded/.test(e.message),
  );
  assert.equal(w.toCommunity.length, 5, "the read, and the claim sent four times in all");
});

test("an electionUnknown refusal reaches the background with its code", async () => {
  const w = world({ refuse: [{ at: 0, code: "vtc/elections/show:electionUnknown" }] });
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, { op: "show", hostDid: VTC, member: MEMBER, electionId: "agm-2027" }),
    (e: Error & { code?: string }) => e.code === "electionUnknown",
  );
});
