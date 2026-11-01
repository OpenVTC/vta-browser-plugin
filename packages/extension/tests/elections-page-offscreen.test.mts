// The offscreen half of `window.vtaWallet.elections`: the member's VTA is asked,
// and what it signs is carried — reads and the ticket request to the community,
// the cast to the ballot box. Against a fake VTA, a community that signs its
// replies, and a ballot box that signs its receipt.
//
// What is pinned: nothing the community receives carries a ballot or a cast;
// the cast reaches the ballot box exactly as the VTA built it, after a pause;
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

function world(opts: { registerFails?: string } = {}) {
  const vtaAsked: { type: string; payload: Record<string, unknown> }[] = [];
  const toCommunity: Record<string, unknown>[] = [];
  const toBox: Record<string, unknown>[] = [];
  const slept: number[] = [];
  let cast: Record<string, unknown> | undefined;

  const sender = {
    async send(envelope: { type: string; payload: Record<string, unknown> }) {
      vtaAsked.push(envelope);
      const p = envelope.payload;
      switch (envelope.type) {
        case `${T}vta/pcs/voter/read/0.2`:
          return {
            document: memberDoc(p.read === "list" ? `${T}vtc/elections/list/0.3` : `${T}vtc/elections/show/0.2`, p.payload),
          };
        case `${T}vta/pcs/voter/register/0.2`:
          if (opts.registerFails) throw new Error(opts.registerFails);
          return {
            electionId: "agm-2027",
            manifestDigest: DIGEST,
            request: {},
            ticketDocument: memberDoc(`${T}vtc/elections/tickets/issue/0.1`, { electionId: "agm-2027" }),
          };
        case `${T}vta/pcs/voter/accept/0.1`:
          return { electionId: "agm-2027", ticketHeld: true };
        case `${T}vta/pcs/vote/0.2`:
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
    const payload = type.endsWith("list/0.3")
      ? { elections: [{ electionId: "agm-2027", state: "voting", ticketHeld: true }] }
      : type.endsWith("show/0.2")
        ? shown
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
    ["vta/pcs/voter/read/0.2", "vta/pcs/voter/register/0.2", "vta/pcs/voter/accept/0.1"],
  );
  assert.equal(w.toCommunity[1]!.type, `${T}vtc/elections/tickets/issue/0.1`);
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

test("a cast goes to the ballot box as the VTA built it, after a pause, and never to the community", async () => {
  const w = world();
  const got = await runElectionsPageOp(w.deps, VTA, { op: "cast", hostDid: VTC, member: MEMBER, electionId: "agm-2027", ballot });
  assert.deepEqual(got, { status: "counted", leafIndex: 7 });
  assert.deepEqual(w.toBox, [w.cast()]);
  assert.equal(w.slept.length, 1);
  assert.ok(w.slept[0]! >= 0 && w.slept[0]! < 20_000);
  assert.equal(
    w.toCommunity.some((d) => JSON.stringify(d).includes("ballot") || JSON.stringify(d).includes("cast")),
    false,
    "the community saw no ballot and no cast",
  );
  const vote = w.vtaAsked.find((a) => a.type === `${T}vta/pcs/vote/0.2`)!;
  assert.deepEqual(vote.payload.ballot, ballot);
  const kept = w.vtaAsked.at(-1)!;
  assert.equal(kept.type, `${T}vta/pcs/voter/receipt/0.1`);
  assert.equal((kept.payload.receipt as { issuer: string }).issuer, box.did);
});

test("a ballot that no longer fits the election is refused before the VTA builds a cast", async () => {
  const w = world();
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, {
      op: "cast",
      hostDid: VTC,
      member: MEMBER,
      electionId: "agm-2027",
      ballot: { ...ballot, manifestDigest: "uEiOld" },
    }),
    /changed the election/,
  );
  assert.equal(w.vtaAsked.some((a) => a.type === `${T}vta/pcs/vote/0.2`), false);
  assert.equal(w.toBox.length, 0);
});

test("an identity the wallet does not hold at this community is refused", async () => {
  const w = world();
  await assert.rejects(
    runElectionsPageOp(w.deps, VTA, { op: "list", hostDid: VTC, member: "did:webvh:QmEve:eve.example" }),
    /no such identity/,
  );
});
