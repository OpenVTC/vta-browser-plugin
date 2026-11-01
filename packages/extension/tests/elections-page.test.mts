// A portal page's `window.vtaWallet.elections`.
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the member must be one of the wallet's own identities
// there, and a ticket or a vote is decided in the wallet's window. The page
// never sees a choice, and from `vote` learns only whether a ticket had to be
// taken first — not whether a vote was cast.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ElectionsPageGates,
  TICKET_TO_VOTE_GAP_MS,
  electionsPageParamsRefusal,
  pageElectionViewOf,
  type ElectionConsentView,
  type ElectionsPageDeps,
} from "../src/elections-page.ts";
import type { OffscreenElectionsPageOp } from "../src/bridge-protocol.ts";
import { pageTaskRefusal } from "../src/page-task-policy.ts";

const HOST = "did:webvh:QmHost:acme.example";
const PORTAL = "https://members.acme.example";
const ENDPOINT = "https://vtc.acme.example/v1/trust-tasks";
const BOX = "did:webvh:QmBox:ballots.example";
const BOX_DOOR = "https://ballots.example/trust-tasks";
const MEMBER = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";
const VTA = { vtaDid: "did:webvh:QmVta:vta.example" };
const DIGEST = "uEiDigest";

const manifest = {
  electionId: "agm-2027",
  community: HOST,
  title: "AGM 2027",
  questions: [
    { key: "chair", type: "choice", text: "Chair", options: [{ key: "ana", label: "Ana" }, { key: "bo" }], minSelections: 1, maxSelections: 1, optional: false },
  ],
  secrecy: "open",
  roll: { rule: "members" },
  registrationOpensAt: "2026-11-01T00:00:00Z",
  votingOpensAt: "2026-11-02T00:00:00Z",
  votingClosesAt: "2026-11-03T00:00:00Z",
  revote: "replace",
  board: { visibility: "public", auditors: [] },
  ballotBox: BOX,
  binding: false,
  allowEarlyClose: false,
  resultsBeforeClose: false,
  textReleaseThreshold: 10,
};

const shown = {
  manifest,
  manifestDigest: DIGEST,
  state: "voting",
  parameters: { suite: "x", votingKey: "secret-ish" },
  disclosure: {
    ballotBox: BOX,
    ballotBoxOperator: "Independent Ballots Ltd",
    sameOperator: false,
    boardVisibility: "public",
    auditors: [],
    revote: "replace",
    coercionResistance: false,
  },
  checkpoints: [{ head: {}, document: {} }],
  ceremony: { steps: [] },
};

const ballot = { electionId: "agm-2027", manifestDigest: DIGEST, answers: [{ question: "chair", choice: ["ana"] }] };

function harness(
  opts: {
    ticketHeld?: boolean;
    approve?: boolean;
    ballot?: unknown;
    reachBox?: boolean;
    takenAt?: number;
    now?: number;
    castFails?: string;
  } = {},
) {
  const asked: OffscreenElectionsPageOp[] = [];
  const prompts: ElectionConsentView[] = [];
  const remembered: [string, number][] = [];
  const deps: ElectionsPageDeps = {
    async active() {
      return { ok: true, vta: VTA };
    },
    async offscreen(_vta, op) {
      asked.push(op);
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: ENDPOINT } };
        case "members":
          return { ok: true, result: [{ did: MEMBER, communityName: "Acme Guild" }] };
        case "ballotBox":
          return { ok: true, result: { endpoint: BOX_DOOR } };
        case "list":
          return {
            ok: true,
            result: {
              elections: [
                {
                  electionId: "agm-2027",
                  title: "AGM 2027",
                  state: "voting",
                  votingOpensAt: manifest.votingOpensAt,
                  votingClosesAt: manifest.votingClosesAt,
                  binding: false,
                  ticketHeld: opts.ticketHeld ?? true,
                },
              ],
            },
          };
        case "show":
          return { ok: true, result: shown };
        case "takeTicket":
          return { ok: true, result: { taken: true } };
        case "cast":
          return opts.castFails ? { ok: false, error: opts.castFails } : { ok: true, result: { status: "counted", leafIndex: 4 } };
      }
    },
    async canReach(url) {
      return url === BOX_DOOR ? (opts.reachBox ?? true) : true;
    },
    async prompt(view) {
      prompts.push(view);
      if (view.kind === "ballot") {
        const approved = opts.approve ?? true;
        return approved ? { approved, ballot: "ballot" in opts ? opts.ballot : ballot } : { approved };
      }
      return { approved: view.kind === "cast" ? true : (opts.approve ?? true) };
    },
    async ticketTakenAt() {
      return opts.takenAt;
    },
    async rememberTicket(key, at) {
      remembered.push([key, at]);
    },
    now: () => opts.now ?? 10 * TICKET_TO_VOTE_GAP_MS,
  };
  return { gates: new ElectionsPageGates(deps), asked, prompts, remembered };
}

test("only list, show, takeTicket and vote, with a DID and an election id, are calls", () => {
  assert.equal(electionsPageParamsRefusal({ op: "list", hostDid: HOST }), null);
  assert.equal(electionsPageParamsRefusal({ op: "vote", hostDid: HOST, electionId: "agm-2027", member: MEMBER }), null);
  assert.match(electionsPageParamsRefusal({ op: "cast", hostDid: HOST })!, /unknown/);
  assert.match(electionsPageParamsRefusal({ op: "vote", hostDid: HOST, electionId: "agm-2027", ballot: {} })!, /takes no `ballot`/);
  assert.match(electionsPageParamsRefusal({ op: "show", hostDid: HOST, electionId: "../x" })!, /election identifier/);
  assert.match(electionsPageParamsRefusal({ op: "list", hostDid: "acme" })!, /DID/);
});

test("a page that is not the community's portal is refused before the agent is asked", async () => {
  const h = harness();
  const res = await h.gates.handle("https://evil.example", { op: "list", hostDid: HOST });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not .* portal/);
  assert.deepEqual(h.asked.map((o) => o.op), ["portal"]);
});

test("show gives the page what is asked and how it is run — not the parameters, ceremony or checkpoints", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, true);
  const view = (res as { result: Record<string, unknown> }).result;
  assert.equal(view.title, "AGM 2027");
  assert.deepEqual((view.questions as { options: unknown[] }[])[0]!.options, [{ key: "ana", label: "Ana" }, { key: "bo" }]);
  for (const k of ["parameters", "ceremony", "checkpoints", "manifest", "manifestDigest"]) {
    assert.equal(k in view, false, `${k} stays with the wallet`);
  }
  assert.deepEqual(pageElectionViewOf(shown as never).disclosure.ballotBoxOperator, "Independent Ballots Ltd");
});

test("a ticket is taken only after the member agrees in the wallet's window, and its time is remembered", async () => {
  const declined = harness({ approve: false });
  const no = await declined.gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(no.ok, false);
  assert.equal(declined.asked.some((o) => o.op === "takeTicket"), false);

  const h = harness({ now: 1234 });
  const res = await h.gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketHeld: true, taken: true } });
  assert.equal(h.prompts[0]!.kind, "ticket");
  assert.deepEqual(h.remembered, [[`${HOST}\n${MEMBER}\nagm-2027`, 1234]]);
});

test("voting with no ticket takes one and stops: no ballot is opened", async () => {
  const h = harness({ ticketHeld: false });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: true } });
  assert.deepEqual(h.prompts.map((p) => p.kind), ["ticket"]);
  assert.equal((h.prompts[0] as { fromVote: boolean }).fromVote, true);
  assert.equal(h.asked.some((o) => o.op === "cast"), false);
});

test("a vote: the ballot is the wallet's, the cast runs after the page is answered, and the page learns nothing of it", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
  assert.equal(JSON.stringify(res).includes("ana"), false, "no choice reaches the page");
  const ballotWindow = h.prompts.find((p) => p.kind === "ballot") as Extract<ElectionConsentView, { kind: "ballot" }>;
  assert.equal(ballotWindow.manifestDigest, DIGEST);
  assert.equal(ballotWindow.ticketTakenAt, undefined);
  await Promise.all([...h.gates.casting]);
  const cast = h.asked.find((o) => o.op === "cast") as Extract<OffscreenElectionsPageOp, { op: "cast" }>;
  assert.deepEqual(cast.ballot, ballot);
  const outcome = h.prompts.at(-1) as Extract<ElectionConsentView, { kind: "cast" }>;
  assert.deepEqual(outcome.outcome, { ok: true, status: "counted", leafIndex: 4 });
});

test("a declined ballot and a cast one look the same to the page", async () => {
  const declined = harness({ approve: false });
  const a = await declined.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const cast = harness();
  const b = await cast.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(a, b);
  assert.equal(declined.asked.some((o) => o.op === "cast"), false);
});

test("a ballot that breaks the election's rules is never cast, and the wallet says why", async () => {
  const h = harness({ ballot: { ...ballot, answers: [{ question: "chair", choice: ["ana", "bo"] }] } });
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...h.gates.casting]);
  assert.equal(h.asked.some((o) => o.op === "cast"), false);
  const last = h.prompts.at(-1) as Extract<ElectionConsentView, { kind: "cast" }>;
  assert.equal(last.outcome.ok, false);
});

test("a failed cast is shown in the wallet's window, not to the page", async () => {
  const h = harness({ castFails: "The ballot box did not answer in time." });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
  await Promise.all([...h.gates.casting]);
  const last = h.prompts.at(-1) as Extract<ElectionConsentView, { kind: "cast" }>;
  assert.deepEqual(last.outcome, { ok: false, error: "The ballot box did not answer in time." });
});

test("the wallet must be allowed to reach the ballot box before a ballot opens", async () => {
  const h = harness({ reachBox: false });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /ballots\.example/);
  assert.equal(h.prompts.length, 0);
});

test("a ballot opened soon after the ticket says so", async () => {
  const h = harness({ takenAt: 1000, now: 1000 + 60_000 });
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const w = h.prompts.find((p) => p.kind === "ballot") as Extract<ElectionConsentView, { kind: "ballot" }>;
  assert.equal(w.ticketTakenAt, 1000);
  await Promise.all([...h.gates.casting]);
});

test("a page cannot drive the voter engine or the community's elections through the generic task prompt", () => {
  for (const t of [
    "https://trusttasks.org/spec/vta/pcs/vote/0.2",
    "https://trusttasks.org/spec/vta/pcs/voter/register/0.2",
    "https://trusttasks.org/spec/vtc/elections/tickets/issue/0.1",
  ]) {
    assert.match(String(pageTaskRefusal(t)), /window\.vtaWallet\.elections/);
  }
});
