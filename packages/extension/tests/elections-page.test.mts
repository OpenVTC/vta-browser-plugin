// A portal page's `window.vtaWallet.elections`.
//
// The gates run here as they run in the background, against fakes for the
// browser and the offscreen document: the page must be the community's portal
// by its DID document, the member must be one of the wallet's own identities
// there, and a ticket or a vote is decided in the wallet's window. The page
// never sees a choice, and from `vote` learns only whether a ticket had to be
// taken first — not whether a vote was cast. The cast's steps go to the ballot
// window, and a vote that went in is remembered by the wallet alone.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ElectionsPageGates,
  TICKET_TO_VOTE_GAP_MS,
  electionsPageParamsRefusal,
  pageElectionViewOf,
  type CastProgress,
  type ElectionConsentView,
  type ElectionsPageDeps,
  type RememberedVote,
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
    postFails?: string;
    keepFails?: string;
    voted?: RememberedVote;
    revote?: string;
    windowClosed?: boolean;
    reachAtCast?: boolean;
  } = {},
) {
  const asked: OffscreenElectionsPageOp[] = [];
  const prompts: ElectionConsentView[] = [];
  const remembered: [string, number][] = [];
  const progress: [string, CastProgress][] = [];
  const votes: [string, RememberedVote][] = [];
  let reachChecks = 0;
  const shownNow = opts.revote ? { ...shown, disclosure: { ...shown.disclosure, revote: opts.revote } } : shown;
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
          return { ok: true, result: shownNow };
        case "takeTicket":
          return { ok: true, result: { taken: true } };
        case "castPrepare":
          return opts.castFails
            ? { ok: false, error: opts.castFails }
            : { ok: true, result: { castDocument: { id: "cast-1", recipient: BOX }, endpoint: BOX_DOOR, ballotBox: BOX } };
        case "castPost":
          return opts.postFails
            ? { ok: false, error: opts.postFails }
            : { ok: true, result: { receipt: { issuer: BOX, payload: { outcome: "counted", leafIndex: 4 } } } };
        case "castKeep":
          return opts.keepFails ? { ok: false, error: opts.keepFails } : { ok: true, result: { status: "included", leafIndex: 4 } };
      }
    },
    async canReach(url) {
      if (url !== BOX_DOOR) return true;
      // The first check is before the window opens; the next is at the cast.
      return reachChecks++ === 0 ? (opts.reachBox ?? true) : (opts.reachAtCast ?? opts.reachBox ?? true);
    },
    async prompt(view) {
      prompts.push(view);
      if (view.kind === "ballot") {
        const approved = opts.approve ?? true;
        return approved ? { approved, ballot: "ballot" in opts ? opts.ballot : ballot, window: "w1" } : { approved };
      }
      return { approved: view.kind === "cast" ? true : (opts.approve ?? true) };
    },
    async progress(window, state) {
      progress.push([window, state]);
      return !opts.windowClosed;
    },
    async votedAt() {
      return opts.voted;
    },
    async rememberVote(key, vote) {
      votes.push([key, vote]);
    },
    castDelayMs: () => 7_000,
    async ticketTakenAt() {
      return opts.takenAt;
    },
    async rememberTicket(key, at) {
      remembered.push([key, at]);
    },
    now: () => opts.now ?? 10 * TICKET_TO_VOTE_GAP_MS,
  };
  return { gates: new ElectionsPageGates(deps), asked, prompts, remembered, progress, votes };
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

test("the page sees the manifest's textReleaseThreshold, as low as 1 (VTI-VOT-065)", () => {
  assert.equal(pageElectionViewOf(shown as never).textReleaseThreshold, 10);
  const low = structuredClone(shown) as { manifest: { textReleaseThreshold: number } };
  low.manifest.textReleaseThreshold = 1;
  assert.equal(pageElectionViewOf(low as never).textReleaseThreshold, 1);
});

test("an empty title is no title: the election is named by its id", () => {
  const untitled = structuredClone(shown) as { manifest: { title?: string } };
  untitled.manifest.title = "  ";
  assert.equal("title" in pageElectionViewOf(untitled as never), false);
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
  assert.equal(h.asked.some((o) => o.op.startsWith("cast")), false);
});

const KEY = `${HOST}\n${MEMBER}\nagm-2027`;
const NOW = 10 * TICKET_TO_VOTE_GAP_MS;

test("a vote: the ballot is the wallet's, the cast runs after the page is answered, and the page learns nothing of it", async () => {
  const h = harness();
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
  assert.equal(JSON.stringify(res).includes("ana"), false, "no choice reaches the page");
  const ballotWindow = h.prompts.find((p) => p.kind === "ballot") as Extract<ElectionConsentView, { kind: "ballot" }>;
  assert.equal(ballotWindow.manifestDigest, DIGEST);
  assert.equal(ballotWindow.ticketTakenAt, undefined);
  assert.equal(ballotWindow.boxOrigin, "https://ballots.example");
  assert.equal(ballotWindow.needsReach, false);
  assert.equal(ballotWindow.canRevote, true);
  await Promise.all([...h.gates.casting]);
  const prepared = h.asked.find((o) => o.op === "castPrepare") as Extract<OffscreenElectionsPageOp, { op: "castPrepare" }>;
  assert.deepEqual(prepared.ballot, ballot);
  const posted = h.asked.find((o) => o.op === "castPost") as Extract<OffscreenElectionsPageOp, { op: "castPost" }>;
  assert.deepEqual(posted, { op: "castPost", castDocument: { id: "cast-1", recipient: BOX }, ballotBox: BOX, endpoint: BOX_DOOR, delayMs: 7_000 });
  assert.deepEqual(h.prompts.map((p) => p.kind), ["ballot"], "one window: no separate outcome window");
});

test("the ballot window is shown each step of the cast, in order, with the pause it waits", async () => {
  const h = harness();
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...h.gates.casting]);
  assert.ok(h.progress.every(([w]) => w === "w1"));
  assert.deepEqual(
    h.progress.map(([, p]) => p),
    [
      { phase: "running", step: "check" },
      { phase: "running", step: "seal" },
      { phase: "running", step: "wait", waitMs: 7_000, waitUntil: NOW + 7_000 },
      { phase: "running", step: "receipt" },
      { phase: "done", at: NOW, status: "counted", leafIndex: 4 },
    ],
  );
  assert.deepEqual(
    h.asked.filter((o) => o.op.startsWith("cast")).map((o) => o.op),
    ["castPrepare", "castPost", "castKeep"],
  );
});

test("a vote that went in is remembered by the wallet — when and how it counted, never a choice", async () => {
  const h = harness();
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...h.gates.casting]);
  assert.deepEqual(h.votes, [[KEY, { at: NOW, status: "counted", leafIndex: 4 }]]);
  assert.equal(JSON.stringify(h.votes).includes("ana"), false);
});

test("a vote is remembered only once the ballot box counted it", async () => {
  for (const fail of [{ castFails: "Your agent refused." }, { postFails: "The ballot box did not answer in time." }]) {
    const h = harness(fail);
    await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
    await Promise.all([...h.gates.casting]);
    assert.deepEqual(h.votes, []);
  }
  // The ballot box counted it, but the agent could not keep the receipt: it is in.
  const h = harness({ keepFails: "Your agent is offline." });
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...h.gates.casting]);
  assert.deepEqual(h.votes, [[KEY, { at: NOW, status: "counted", leafIndex: 4 }]]);
  assert.deepEqual(h.progress.at(-1)![1], { phase: "done", at: NOW, status: "counted", leafIndex: 4, receiptNotKept: "Your agent is offline." });
});

test("a declined ballot and a cast one look the same to the page", async () => {
  const declined = harness({ approve: false });
  const a = await declined.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const cast = harness();
  const b = await cast.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const failed = harness({ postFails: "The ballot box did not answer in time." });
  const c = await failed.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const voted = harness({ voted: { at: 5, status: "counted", leafIndex: 1 }, approve: false });
  const d = await voted.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const unreachable = harness({ reachBox: false });
  const e = await unreachable.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  for (const r of [b, c, d, e]) assert.deepEqual(r, a);
  assert.equal(declined.asked.some((o) => o.op.startsWith("cast")), false);
  await Promise.all([...cast.gates.casting, ...failed.gates.casting, ...unreachable.gates.casting]);
});

test("a ballot that breaks the election's rules is never cast, and the window says why", async () => {
  const h = harness({ ballot: { ...ballot, answers: [{ question: "chair", choice: ["ana", "bo"] }] } });
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...h.gates.casting]);
  assert.equal(h.asked.some((o) => o.op.startsWith("cast")), false);
  const last = h.progress.at(-1)![1];
  assert.equal(last.phase, "failed");
  assert.equal((last as { step: string }).step, "check");
});

test("a failed cast is shown in the ballot window at the step it failed, not to the page", async () => {
  const h = harness({ postFails: "The ballot box did not answer in time." });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
  await Promise.all([...h.gates.casting]);
  assert.deepEqual(h.progress.at(-1)![1], { phase: "failed", step: "send", error: "The ballot box did not answer in time." });
  assert.deepEqual(h.prompts.map((p) => p.kind), ["ballot"]);
});

test("a ballot window closed early does not stop the cast; a failure it cannot show opens a window", async () => {
  const ok = harness({ windowClosed: true });
  await ok.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...ok.gates.casting]);
  assert.deepEqual(ok.asked.filter((o) => o.op.startsWith("cast")).map((o) => o.op), ["castPrepare", "castPost", "castKeep"]);
  assert.equal(ok.progress.length, 1, "nothing more is written once the window is gone");
  assert.equal(ok.votes.length, 1, "the vote is still remembered");
  assert.deepEqual(ok.prompts.map((p) => p.kind), ["ballot"]);

  const failed = harness({ windowClosed: true, postFails: "The ballot box did not answer in time." });
  await failed.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...failed.gates.casting]);
  const last = failed.prompts.at(-1) as Extract<ElectionConsentView, { kind: "cast" }>;
  assert.deepEqual(last.outcome, { ok: false, error: "The ballot box did not answer in time." });
});

test("a ballot box the wallet may not reach yet opens the window, which asks for it", async () => {
  const h = harness({ reachBox: false, reachAtCast: true });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
  const w = h.prompts[0] as Extract<ElectionConsentView, { kind: "ballot" }>;
  assert.equal(w.kind, "ballot");
  assert.equal(w.needsReach, true);
  assert.equal(w.boxOrigin, "https://ballots.example");
  await Promise.all([...h.gates.casting]);
  assert.equal(h.progress.at(-1)![1].phase, "done");
});

test("a ballot box still out of reach at the cast sends nothing, and the window says so", async () => {
  const h = harness({ reachBox: false });
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  await Promise.all([...h.gates.casting]);
  assert.equal(h.asked.some((o) => o.op.startsWith("cast")), false);
  const last = h.progress.at(-1)![1] as Extract<CastProgress, { phase: "failed" }>;
  assert.equal(last.step, "check");
  assert.match(last.error, /ballots\.example/);
});

test("a remembered vote opens the window on it; a revote is offered only when the election allows it and voting is open", async () => {
  const voted = { at: 1234, status: "counted", leafIndex: 2 };
  const h = harness({ voted, approve: false });
  await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  const w = h.prompts[0] as Extract<ElectionConsentView, { kind: "ballot" }>;
  assert.deepEqual(w.voted, voted);
  assert.equal(w.canRevote, true);

  const once = harness({ voted, revote: "reject", approve: false });
  await once.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.equal((once.prompts[0] as Extract<ElectionConsentView, { kind: "ballot" }>).canRevote, false);
  assert.equal(once.asked.some((o) => o.op.startsWith("cast")), false);
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
