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
    /** The election's roll: the holders of a membership credential for this party. */
    rollOf?: { memberOf: string; memberOfKind: "thisCommunity" | "communityGroup" | "memberParty"; memberOfName?: string };
    /** Whether the member holds a credential from the party the roll names. */
    held?: boolean;
    /** Whether the community lists the election to the member at all. */
    listed?: boolean;
    /** The community shows the election only to a read presenting a membership. */
    unknownUnlessPresenting?: boolean;
    /** The party the member already chose to present their membership of. */
    disclosed?: string;
    /** Whether the ticket was taken by this call (false: the agent held it). */
    taken?: boolean;
    /** The election notifications the member's agent holds for this community. */
    notified?: Record<string, unknown>[];
    /** The record the console opens, as the VTA holds it (`notifiedTarget`). */
    notifiedRecord?: Record<string, unknown>;
    /** Whether the community's endpoint is reachable (the console's open). */
    reachCommunity?: boolean;
    /** Elections whose ticket request the community refuses. */
    ticketFails?: string[];
    /** The active connection, when there is none. */
    inactive?: { ok: false; error: string; code?: string };
    /** An offscreen operation that fails, as the offscreen document answers it. */
    refuse?: Partial<Record<OffscreenElectionsPageOp["op"], { ok: false; error: string; code?: string }>>;
    /** The identities the member uses at the community. */
    members?: { did: string; communityName: string }[];
    /** How many receipts the member's agent keeps for the election. */
    kept?: number;
    /** What checking them against the community's head came to. */
    checked?: { deleted: boolean; treeSize: number; receipts: { leafIndex: number; status: string }[]; title?: string };
  } = {},
) {
  const asked: OffscreenElectionsPageOp[] = [];
  const prompts: ElectionConsentView[] = [];
  const remembered: [string, number][] = [];
  const progress: [string, CastProgress][] = [];
  const votes: [string, RememberedVote][] = [];
  const disclosures: [string, string][] = [];
  const slept: number[] = [];
  let reachChecks = 0;
  let shownNow: Record<string, unknown> = opts.revote ? { ...shown, disclosure: { ...shown.disclosure, revote: opts.revote } } : shown;
  if (opts.rollOf) {
    shownNow = {
      ...shownNow,
      manifest: { ...manifest, roll: { rule: "credential", memberOf: opts.rollOf.memberOf } },
      disclosure: { ...(shownNow.disclosure as object), rollCredential: { ...opts.rollOf, presenterDisclosed: true } },
    };
  }
  const deps: ElectionsPageDeps = {
    async active() {
      return opts.inactive ?? { ok: true, vta: VTA };
    },
    async offscreen(_vta, op) {
      asked.push(op);
      const refused = opts.refuse?.[op.op];
      if (refused) return refused;
      switch (op.op) {
        case "portal":
          return { ok: true, result: { portalOrigin: PORTAL, endpoint: ENDPOINT } };
        case "members":
          return { ok: true, result: opts.members ?? [{ did: MEMBER, communityName: "Acme Guild" }] };
        case "ballotBox":
          return { ok: true, result: { endpoint: BOX_DOOR } };
        case "list":
          return {
            ok: true,
            result: {
              elections: opts.listed === false ? [] : [
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
          if (opts.unknownUnlessPresenting && !op.readAs) {
            return { ok: false, error: "Acme Guild shows you no such election", code: "electionUnknown" };
          }
          return { ok: true, result: shownNow };
        case "membership":
          return { ok: true, result: { held: opts.held ?? true } };
        case "takeTicket":
          if (opts.ticketFails?.includes(op.electionId)) return { ok: false, error: "the community is not issuing tickets" };
          return { ok: true, result: { taken: opts.taken ?? true } };
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
        case "notified":
          return { ok: true, result: opts.notified ?? [] };
        case "notifiedTarget":
          return { ok: true, result: { ...opts.notifiedRecord, endpoint: ENDPOINT } };
        case "notifiedShow":
          if (opts.unknownUnlessPresenting && !op.present) {
            return { ok: false, error: "The community shows you no such election", code: "electionUnknown" };
          }
          return { ok: true, result: shownNow };
        case "notifiedMembership":
          return { ok: true, result: { held: opts.held ?? true } };
        case "receiptsKept":
          return { ok: true, result: opts.kept ? { count: opts.kept, ballotBox: BOX } : { count: 0 } };
        case "receiptsCheck":
          return {
            ok: true,
            result: opts.checked ?? { deleted: false, treeSize: 9, receipts: [{ leafIndex: 4, status: "included" }], title: "AGM 2027" },
          };
      }
    },
    async canReach(url) {
      if (url === ENDPOINT) return opts.reachCommunity ?? true;
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
      return { approved: view.kind === "cast" || view.kind === "check" ? true : (opts.approve ?? true) };
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
    ticketSpacingMs: () => 3_000,
    async sleep(ms) {
      slept.push(ms);
    },
    async ticketTakenAt() {
      return opts.takenAt;
    },
    async rememberTicket(key, at) {
      remembered.push([key, at]);
    },
    async disclosedFor() {
      return disclosures.at(-1)?.[1] ?? opts.disclosed;
    },
    async rememberDisclosure(key, memberOf) {
      disclosures.push([key, memberOf]);
    },
    now: () => opts.now ?? 10 * TICKET_TO_VOTE_GAP_MS,
  };
  return { gates: new ElectionsPageGates(deps), asked, prompts, remembered, progress, votes, disclosures, slept };
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

// ── Credential rolls (VTI-VOT-015 – 017, 025, 090) ──────────────────────────

const PARTY = "did:webvh:QmParty:party.example";

test("vti_vot_090: show passes the roll's credential disclosure on to the page", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "memberParty", memberOfName: "Party Co-op" } });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, true);
  const view = (res as { result: { disclosure: Record<string, unknown> } }).result;
  assert.deepEqual(view.disclosure.rollCredential, { memberOf: PARTY, memberOfKind: "memberParty", memberOfName: "Party Co-op" });
});

test("vti_vot_025: a ticket under a credential roll says, first, that claiming it presents the membership", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "communityGroup", memberOfName: "Engineering" } });
  const res = await h.gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketHeld: true, taken: true } });
  const w = h.prompts[0] as Extract<ElectionConsentView, { kind: "ticket" }>;
  assert.deepEqual(w.presents, { memberOf: PARTY, memberOfKind: "communityGroup", memberOfName: "Engineering" });
  const take = h.asked.find((o) => o.op === "takeTicket") as Extract<OffscreenElectionsPageOp, { op: "takeTicket" }>;
  assert.equal(take.presentFor, PARTY, "the claim presents for exactly the party the member was told of");
  // Membership is checked before the window, and the window before the claim.
  const ops = h.asked.map((o) => o.op);
  assert.ok(ops.indexOf("membership") < ops.indexOf("takeTicket"));
});

test("a ticket the member declines under a credential roll presents nothing", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "thisCommunity" }, approve: false });
  const res = await h.gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, false);
  assert.equal(h.asked.some((o) => o.op === "takeTicket"), false);
});

test("a member holding no membership of the roll's party is told so, before any window", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "memberParty" }, held: false });
  const res = await h.gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /don't hold one, so you are not a member of that party/);
  assert.equal(h.prompts.length, 0);
});

test("a ticket under any other roll presents nothing and checks no membership", async () => {
  const h = harness();
  await h.gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(h.asked.some((o) => o.op === "membership"), false);
  const take = h.asked.find((o) => o.op === "takeTicket") as Extract<OffscreenElectionsPageOp, { op: "takeTicket" }>;
  assert.equal("presentFor" in take, false);
  assert.equal((h.prompts[0] as { presents?: unknown }).presents, undefined);
});

test("vti_vot_015/016: a member-party election is read presenting the membership only after the member chose to", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "memberParty" }, unknownUnlessPresenting: true, listed: false });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027", memberOf: PARTY });
  assert.equal(res.ok, true);
  const shows = h.asked.filter((o) => o.op === "show") as Extract<OffscreenElectionsPageOp, { op: "show" }>[];
  assert.equal(shows[0]!.readAs, undefined, "read without presenting first");
  assert.deepEqual(shows[1]!.readAs, { memberOf: PARTY });
  const w = h.prompts[0] as Extract<ElectionConsentView, { kind: "disclose" }>;
  assert.equal(w.kind, "disclose");
  assert.equal(w.memberOf, PARTY);
  assert.deepEqual(h.disclosures, [[`${HOST}\n${MEMBER}\nagm-2027`, PARTY]]);
});

test("declining to show the membership reads nothing more", async () => {
  const h = harness({ unknownUnlessPresenting: true, approve: false });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027", memberOf: PARTY });
  assert.equal(res.ok, false);
  assert.equal(h.asked.filter((o) => o.op === "show").length, 1);
  assert.deepEqual(h.disclosures, []);
});

test("an unknown election with no party named is not presented for", async () => {
  const h = harness({ unknownUnlessPresenting: true });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, false);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.asked.some((o) => o.op === "membership"), false);
});

test("a party the member holds no membership of is not asked about", async () => {
  const h = harness({ unknownUnlessPresenting: true, held: false });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027", memberOf: PARTY });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not a member of that party/);
  assert.equal(h.prompts.length, 0);
});

test("once chosen, later reads of that election present without asking again — the cast's included", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "memberParty" }, unknownUnlessPresenting: true, listed: false, disclosed: PARTY, takenAt: 1 });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
  await Promise.all([...h.gates.casting]);
  assert.equal(h.prompts.some((p) => p.kind === "disclose"), false);
  const prepare = h.asked.find((o) => o.op === "castPrepare") as Extract<OffscreenElectionsPageOp, { op: "castPrepare" }>;
  assert.deepEqual(prepare.readAs, { memberOf: PARTY });
});

test("an unlisted election this wallet holds no ticket for takes one first", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "memberParty" }, unknownUnlessPresenting: true, listed: false, disclosed: PARTY });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: true } });
  assert.deepEqual(h.prompts.map((p) => p.kind), ["ticket"]);
});

test("an unlisted election the page names no party for is refused as before", async () => {
  const h = harness({ listed: false });
  const res = await h.gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /No such election/);
});

test("memberOf must be a DID, and list takes none", () => {
  assert.equal(electionsPageParamsRefusal({ op: "show", hostDid: HOST, electionId: "agm-2027", memberOf: PARTY }), null);
  assert.match(electionsPageParamsRefusal({ op: "show", hostDid: HOST, electionId: "agm-2027", memberOf: "party" })!, /memberOf/);
  assert.match(electionsPageParamsRefusal({ op: "list", hostDid: HOST, memberOf: PARTY })!, /takes no `memberOf`/);
});

test("a page cannot drive the voter engine or the community's elections through the generic task prompt", () => {
  for (const t of [
    "https://trusttasks.org/spec/vta/pcs/vote/0.4",
    "https://trusttasks.org/spec/vta/pcs/voter/register/0.5",
    "https://trusttasks.org/spec/vta/pcs/voter/read/0.6",
    "https://trusttasks.org/spec/vtc/elections/tickets/issue/0.3",
    "https://trusttasks.org/spec/vtc/elections/show/0.6",
  ]) {
    assert.match(String(pageTaskRefusal(t)), /window\.vtaWallet\.elections/);
  }
});

// Notifications of the kind `election` (VTI-NTF-063): the member's view is both
// what the community lists and what their agent holds a notification of.

const NOTIFIED = {
  recordId: "hn-0123456789abcdef",
  contextId: "vtc-acme",
  community: HOST,
  electionId: "party-vote",
  audience: PARTY,
  addressee: MEMBER,
  originator: HOST,
  relayedBy: [PARTY],
  status: "available",
  votingOpensAt: "2026-11-02T00:00:00Z",
  votingClosesAt: "2026-11-03T00:00:00Z",
  openWith: "https://trusttasks.org/spec/vtc/elections/show/0.6",
  dismissed: false,
};

test("vti_ntf_063: list shows the elections the community lists and, only as notified, those the agent was told of", async () => {
  const listedToo = { ...NOTIFIED, electionId: "agm-2027", recordId: "hn-listed-000000000" };
  const h = harness({ notified: [NOTIFIED, listedToo] });
  const res = await h.gates.handle(PORTAL, { op: "list", hostDid: HOST });
  assert.equal(res.ok, true);
  const { elections, notified } = (res as { result: { elections: { electionId: string }[]; notified: unknown[] } }).result;
  assert.deepEqual(elections.map((e) => e.electionId), ["agm-2027"]);
  // Community, identifier, audience and period — the page's call already names
  // the community — and nothing else of the notification or the election.
  assert.deepEqual(notified, [
    { electionId: "party-vote", audience: PARTY, status: "available", votingOpensAt: NOTIFIED.votingOpensAt, votingClosesAt: NOTIFIED.votingClosesAt },
  ]);
  const ask = h.asked.find((o) => o.op === "notified");
  assert.deepEqual(ask, { op: "notified", hostDid: HOST, member: MEMBER });
});

test("vti_ntf_063: a notified election the page names no party for is opened as the notification's audience's member", async () => {
  const h = harness({ rollOf: { memberOf: PARTY, memberOfKind: "memberParty" }, unknownUnlessPresenting: true, listed: false, notified: [{ ...NOTIFIED, electionId: "agm-2027" }] });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, true);
  // Still only after the member chose to, in the wallet's window (VTI-VOT-016).
  const w = h.prompts[0] as Extract<ElectionConsentView, { kind: "disclose" }>;
  assert.equal(w.kind, "disclose");
  assert.equal(w.memberOf, PARTY);
  const shows = h.asked.filter((o) => o.op === "show") as Extract<OffscreenElectionsPageOp, { op: "show" }>[];
  assert.deepEqual(shows.map((s) => s.readAs), [undefined, { memberOf: PARTY }]);
});

test("a withdrawn notification names no party to read as", async () => {
  const h = harness({ unknownUnlessPresenting: true, listed: false, notified: [{ ...NOTIFIED, electionId: "agm-2027", status: "withdrawn" }] });
  const res = await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" });
  assert.equal(res.ok, false);
  assert.equal(h.prompts.length, 0);
});

test("vti_ntf_063: from the wallet's own view, a notified election is read without presenting first", async () => {
  const h = harness({ notifiedRecord: NOTIFIED });
  const res = await h.gates.openNotified({ contextId: "vtc-acme", recordId: NOTIFIED.recordId });
  assert.equal(res.ok, true);
  const out = (res as { result: { kind: string; presented: boolean; member: string } }).result;
  assert.equal(out.kind, "shown");
  assert.equal(out.presented, false);
  assert.equal(out.member, MEMBER, "read as the DID the notification was addressed to");
  assert.deepEqual(h.asked.map((o) => o.op), ["notifiedTarget", "notifiedShow"]);
  assert.equal((h.asked[1] as { present?: boolean }).present, undefined);
});

test("vti_vot_016: an election shown only to the audience's members asks before presenting, and presents only when told to", async () => {
  const h = harness({ notifiedRecord: NOTIFIED, unknownUnlessPresenting: true, held: true });
  const first = await h.gates.openNotified({ contextId: "vtc-acme", recordId: NOTIFIED.recordId });
  assert.deepEqual((first as { result: unknown }).result, { kind: "needsPresent", audience: PARTY, held: true, community: HOST, member: MEMBER });
  assert.deepEqual(h.disclosures, []);
  const second = await h.gates.openNotified({ contextId: "vtc-acme", recordId: NOTIFIED.recordId, present: true });
  assert.equal((second as { result: { kind: string; presented: boolean } }).result.presented, true);
  assert.deepEqual(h.disclosures, [[`${HOST}\n${MEMBER}\nparty-vote`, PARTY]]);
  const presented = h.asked.filter((o) => o.op === "notifiedShow" && (o as { present?: boolean }).present === true);
  assert.equal(presented.length, 1);
});

test("a community the wallet may not reach yet is asked for before anything is read", async () => {
  const h = harness({ notifiedRecord: NOTIFIED, reachCommunity: false });
  const res = await h.gates.openNotified({ contextId: "vtc-acme", recordId: NOTIFIED.recordId });
  assert.deepEqual((res as { result: unknown }).result, { kind: "needsReach", origin: new URL(ENDPOINT).origin, community: HOST });
  assert.deepEqual(h.asked.map((o) => o.op), ["notifiedTarget"]);
});

test("a page cannot read, dismiss or deposit the member's notifications through the generic task prompt", () => {
  for (const verb of ["list", "show", "dismiss", "deposit"]) {
    assert.match(String(pageTaskRefusal(`https://trusttasks.org/spec/vta/notifications/${verb}/0.1`)), /which communities and parties/);
  }
});

// ── takeTickets: several tickets, one decision (VTI-BRD-034) ───────────────

const batch = (electionIds: string[], extra: Record<string, unknown> = {}) => ({ op: "takeTickets", hostDid: HOST, electionIds, ...extra });

test("takeTickets takes 1 to 50 distinct election ids and nothing else", () => {
  assert.equal(electionsPageParamsRefusal(batch(["agm-2027", "b-2"])), null);
  assert.match(electionsPageParamsRefusal(batch([]))!, /1 to 50/);
  assert.match(electionsPageParamsRefusal(batch(Array.from({ length: 51 }, (_, i) => `e${i}`)))!, /1 to 50/);
  assert.match(electionsPageParamsRefusal(batch(["agm-2027", "agm-2027"]))!, /repeat/);
  assert.match(electionsPageParamsRefusal(batch(["../x"]))!, /election identifiers/);
  assert.match(electionsPageParamsRefusal(batch(["agm-2027"], { memberOf: HOST }))!, /takes no `memberOf`/);
  assert.match(electionsPageParamsRefusal({ op: "takeTickets", hostDid: HOST, electionId: "agm-2027" })!, /takes no `electionId`/);
});

test("vti_brd_034: one window for every ticket, then each asked for alone, a pause apart", async () => {
  const h = harness({ ticketHeld: false, now: 77 });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027", "b-2", "c-3"]));
  assert.deepEqual(res, {
    ok: true,
    result: {
      tickets: [
        { electionId: "agm-2027", outcome: "taken" },
        { electionId: "b-2", outcome: "taken" },
        { electionId: "c-3", outcome: "taken" },
      ],
    },
  });
  assert.deepEqual(h.prompts.map((p) => p.kind), ["tickets"]);
  assert.equal((h.prompts[0] as Extract<ElectionConsentView, { kind: "tickets" }>).elections.length, 3);
  const takes = h.asked.filter((o) => o.op === "takeTicket");
  assert.deepEqual(takes.map((o) => (o as { electionId: string }).electionId), ["agm-2027", "b-2", "c-3"]);
  // A pause before every request but the first.
  assert.deepEqual(h.slept, [3_000, 3_000]);
  assert.equal(h.remembered.length, 3);
  assert.deepEqual(h.remembered[0], [`${HOST}\n${MEMBER}\nagm-2027`, 77]);
});

test("a ticket the member already holds is not asked for, and needs no window", async () => {
  const h = harness({ ticketHeld: true });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027"]));
  assert.deepEqual(res, { ok: true, result: { tickets: [{ electionId: "agm-2027", outcome: "held" }] } });
  assert.equal(h.prompts.length, 0);
  assert.equal(h.asked.some((o) => o.op === "takeTicket" || o.op === "show"), false);
});

test("declining the window takes no ticket at all", async () => {
  const h = harness({ ticketHeld: false, approve: false });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027", "b-2"]));
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /did not take your tickets/);
  assert.equal(h.asked.some((o) => o.op === "takeTicket"), false);
});

test("an election shown only to a party's members is unavailable here: nothing is presented to read it", async () => {
  const h = harness({ ticketHeld: false, unknownUnlessPresenting: true });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027"]));
  assert.deepEqual(res, { ok: true, result: { tickets: [{ electionId: "agm-2027", outcome: "unavailable" }] } });
  assert.equal(h.prompts.length, 0, "no disclose window, and no tickets window for nothing");
  assert.equal(h.asked.some((o) => o.op === "show" && "readAs" in o), false);
  assert.equal(h.asked.some((o) => o.op === "membership"), false);
});

test("vti_vot_025: under a credential roll the window says what each claim presents, and the claim presents it", async () => {
  const rollOf = { memberOf: "did:webvh:QmGroup:acme.example", memberOfKind: "communityGroup" as const, memberOfName: "Identity WG" };
  const h = harness({ ticketHeld: false, rollOf });
  await h.gates.handle(PORTAL, batch(["agm-2027"]));
  const view = h.prompts[0] as Extract<ElectionConsentView, { kind: "tickets" }>;
  assert.equal(view.elections[0]!.presents?.memberOf, rollOf.memberOf);
  const take = h.asked.find((o) => o.op === "takeTicket") as { presentFor?: string };
  assert.equal(take.presentFor, rollOf.memberOf);
});

test("a roll the member holds no membership for is notEligible, and asks nothing", async () => {
  const rollOf = { memberOf: "did:webvh:QmGroup:acme.example", memberOfKind: "communityGroup" as const };
  const h = harness({ ticketHeld: false, rollOf, held: false });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027"]));
  assert.deepEqual(res, { ok: true, result: { tickets: [{ electionId: "agm-2027", outcome: "notEligible" }] } });
  assert.equal(h.prompts.length, 0);
});

test("one refused ticket does not stop the rest, and the page is told which", async () => {
  const h = harness({ ticketHeld: false, ticketFails: ["b-2"] });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027", "b-2", "c-3"]));
  const tickets = (res as { result: { tickets: { electionId: string; outcome: string; error?: string }[] } }).result.tickets;
  assert.deepEqual(tickets.map((t) => t.outcome), ["taken", "failed", "taken"]);
  assert.match(tickets[1]!.error!, /not issuing tickets/);
  assert.equal(h.remembered.length, 2);
});

test("the page learns nothing from takeTickets that list would not tell it", async () => {
  const h = harness({ ticketHeld: false });
  const res = await h.gates.handle(PORTAL, batch(["agm-2027"]));
  const text = JSON.stringify(res);
  for (const k of ["manifest", "ballot", "receipt", "voted", "presentation", "credential"]) {
    assert.equal(text.includes(k), false, `${k} stays with the wallet`);
  }
});

// ── The code every refusal carries to the page (docs/page-bridge-errors.md) ──
//
// A portal tells one refusal from another by `code`, never by the message,
// which the wallet rewords freely. Each gate's refusal names its own.

const OTHER_MEMBER = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const failure = (res: unknown) => res as { ok: false; error: string; code: string };

test("page code: a malformed call is invalidCall, and nothing is asked", async () => {
  const h = harness();
  const res = failure(await h.gates.handle(PORTAL, { op: "cast", hostDid: HOST }));
  assert.equal(res.code, "invalidCall");
  assert.equal(h.asked.length, 0);
});

test("page code: no agent connection is notConnected", async () => {
  const h = harness({ inactive: { ok: false, error: "no active VTA connection — connect first" } });
  const res = failure(await h.gates.handle(PORTAL, { op: "list", hostDid: HOST }));
  assert.deepEqual(res, { ok: false, error: "no active VTA connection — connect first", code: "notConnected" });
});

test("page code: a page that is not the portal is originNotPermitted; an endpoint not allowed, hostPermissionRequired", async () => {
  assert.equal(failure(await harness().gates.handle("https://evil.example", { op: "list", hostDid: HOST })).code, "originNotPermitted");
  const unreachable = failure(await harness({ reachCommunity: false }).gates.handle(PORTAL, { op: "list", hostDid: HOST }));
  assert.equal(unreachable.code, "hostPermissionRequired");
});

test("page code: an identity the wallet does not hold is identityUnknown; two and none named, identityAmbiguous", async () => {
  const unknown = failure(await harness().gates.handle(PORTAL, { op: "list", hostDid: HOST, member: OTHER_MEMBER }));
  assert.equal(unknown.code, "identityUnknown");
  const none = failure(await harness({ members: [] }).gates.handle(PORTAL, { op: "list", hostDid: HOST }));
  assert.equal(none.code, "identityUnknown");
  const two = harness({
    members: [
      { did: MEMBER, communityName: "Acme Guild" },
      { did: OTHER_MEMBER, communityName: "Acme Guild" },
    ],
  });
  assert.equal(failure(await two.gates.handle(PORTAL, { op: "list", hostDid: HOST })).code, "identityAmbiguous");
});

test("page code: every no in the wallet's window is declined", async () => {
  const ticket = failure(await harness({ approve: false }).gates.handle(PORTAL, { op: "takeTicket", hostDid: HOST, electionId: "agm-2027" }));
  assert.equal(ticket.code, "declined");

  const tickets = failure(
    await harness({ approve: false, ticketHeld: false }).gates.handle(PORTAL, { op: "takeTickets", hostDid: HOST, electionIds: ["agm-2027"] }),
  );
  assert.equal(tickets.code, "declined");

  const party = "did:webvh:QmParty:party.example";
  const shown = failure(
    await harness({ approve: false, unknownUnlessPresenting: true }).gates.handle(PORTAL, {
      op: "show",
      hostDid: HOST,
      electionId: "agm-2027",
      memberOf: party,
    }),
  );
  assert.equal(shown.code, "declined");
  assert.match(shown.error, /chose not to show your membership/, "the message is unchanged");
});

test("page code: a vote the member declines in the ballot window is not an error at all", async () => {
  const res = await harness({ approve: false }).gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" });
  assert.deepEqual(res, { ok: true, result: { ticketTaken: false } });
});

test("page code: the community's electionUnknown reaches the page by that name, as does the wallet's reading of its list", async () => {
  const shown = failure(
    await harness({ unknownUnlessPresenting: true }).gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" }),
  );
  assert.equal(shown.code, "electionUnknown");
  const voted = failure(
    await harness({ listed: false }).gates.handle(PORTAL, { op: "vote", hostDid: HOST, electionId: "agm-2027" }),
  );
  assert.equal(voted.code, "electionUnknown");
});

test("page code: no credential of the party an election is put to is membershipNotHeld", async () => {
  const res = failure(
    await harness({ unknownUnlessPresenting: true, held: false }).gates.handle(PORTAL, {
      op: "show",
      hostDid: HOST,
      electionId: "agm-2027",
      memberOf: "did:webvh:QmParty:party.example",
    }),
  );
  assert.equal(res.code, "membershipNotHeld");
});

test("page code: a Trust Task code and a wallet code from the offscreen document are carried as they came", async () => {
  const indeterminate = harness({
    refuse: { show: { ok: false, error: "Acme Guild could not check your membership credential just now.", code: "indeterminate" } },
  });
  const res = failure(await indeterminate.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" }));
  assert.deepEqual(res, { ok: false, error: "Acme Guild could not check your membership credential just now.", code: "indeterminate" });

  const locked = harness({ refuse: { members: { ok: false, error: "wallet is locked: unlock via popup before retrying", code: "walletLocked" } } });
  assert.equal(failure(await locked.gates.handle(PORTAL, { op: "list", hostDid: HOST })).code, "walletLocked");

  const gone = harness({ refuse: { portal: { ok: false, error: "the offscreen document did not answer", code: "walletUnavailable" } } });
  assert.equal(failure(await gone.gates.handle(PORTAL, { op: "list", hostDid: HOST })).code, "walletUnavailable");
});

test("page code: a code that is not one name never reaches the page", async () => {
  for (const code of ["e.p.msg.forbidden", "<img src=x>", "a credential: eyJhbGciOi", undefined]) {
    const h = harness({ refuse: { show: { ok: false, error: "refused", ...(code !== undefined ? { code } : {}) } } });
    const res = failure(await h.gates.handle(PORTAL, { op: "show", hostDid: HOST, electionId: "agm-2027" }));
    assert.equal(res.code, "unclassified", String(code));
  }
});

test("page code: one ticket of several that failed carries its code in its entry", async () => {
  const h = harness({ ticketHeld: false, refuse: { takeTicket: { ok: false, error: "Tickets for this election are not being issued now.", code: "notOpen" } } });
  const res = await h.gates.handle(PORTAL, { op: "takeTickets", hostDid: HOST, electionIds: ["agm-2027"] });
  assert.equal(res.ok, true);
  assert.deepEqual((res as { result: { tickets: unknown[] } }).result.tickets, [
    { electionId: "agm-2027", outcome: "failed", error: "Tickets for this election are not being issued now.", code: "notOpen" },
  ]);
});

// ── VTI-VOT-053: checking a vote after close ─────────────────────────────────

const CHECK = { op: "checkVote", hostDid: HOST, electionId: "agm-2027", member: MEMBER };

test("vti_vot_053: checkVote is a call, taking what vote takes", () => {
  assert.equal(electionsPageParamsRefusal(CHECK), null);
  assert.match(electionsPageParamsRefusal({ ...CHECK, receipt: {} })!, /takes no `receipt`/);
});

test("vti_vot_053: a vote is checked against the community's head, and the answer is the wallet's window's alone", async () => {
  const h = harness({ kept: 1 });
  const res = await h.gates.handle(PORTAL, CHECK);
  assert.deepEqual(res, { ok: true, result: {} });
  const check = h.asked.find((o) => o.op === "receiptsCheck");
  assert.deepEqual(check, { op: "receiptsCheck", hostDid: HOST, member: MEMBER, electionId: "agm-2027", endpoint: BOX_DOOR });
  const view = h.prompts.at(-1) as Extract<ElectionConsentView, { kind: "check" }>;
  assert.equal(view.kind, "check");
  assert.equal(view.electionTitle, "AGM 2027");
  assert.deepEqual(view.outcome, { ok: true, deleted: false, treeSize: 9, receipts: [{ leafIndex: 4, status: "included" }] });
});

test("vti_vot_053: no receipt, a missing cast and a failure all answer the page the same", async () => {
  const none = harness({ kept: 0 });
  assert.deepEqual(await none.gates.handle(PORTAL, CHECK), { ok: true, result: {} });
  assert.deepEqual((none.prompts.at(-1) as { outcome: unknown }).outcome, { ok: true, none: true });
  assert.ok(!none.asked.some((o) => o.op === "receiptsCheck"), "nothing is asked of the ballot box");

  const missing = harness({ kept: 1, checked: { deleted: true, treeSize: 3, receipts: [{ leafIndex: 4, status: "notIncluded" }] } });
  assert.deepEqual(await missing.gates.handle(PORTAL, CHECK), { ok: true, result: {} });
  const o = (missing.prompts.at(-1) as { outcome: { receipts: { status: string }[]; deleted: boolean } }).outcome;
  assert.equal(o.receipts[0]!.status, "notIncluded");
  assert.equal(o.deleted, true);

  const failed = harness({ kept: 1, refuse: { receiptsCheck: { ok: false, error: "Voting has not closed yet." } } });
  assert.deepEqual(await failed.gates.handle(PORTAL, CHECK), { ok: true, result: {} });
  assert.deepEqual((failed.prompts.at(-1) as { outcome: unknown }).outcome, { ok: false, error: "Voting has not closed yet." });
});

test("vti_vot_053: a ballot box out of reach is asked nothing, and the window says to allow it", async () => {
  const h = harness({ kept: 1, reachBox: false });
  assert.deepEqual(await h.gates.handle(PORTAL, CHECK), { ok: true, result: {} });
  assert.ok(!h.asked.some((o) => o.op === "receiptsCheck"));
  assert.match((h.prompts.at(-1) as { outcome: { error: string } }).outcome.error, /may not reach the ballot box/);
});

test("vti_vot_053: a membership already presented for the election is presented again to read it; none newly", async () => {
  const h = harness({ kept: 1, disclosed: PARTY });
  await h.gates.handle(PORTAL, CHECK);
  assert.deepEqual((h.asked.find((o) => o.op === "receiptsCheck") as { readAs?: unknown }).readAs, { memberOf: PARTY });
  const fresh = harness({ kept: 1 });
  await fresh.gates.handle(PORTAL, { ...CHECK, memberOf: PARTY });
  assert.equal((fresh.asked.find((o) => o.op === "receiptsCheck") as { readAs?: unknown }).readAs, undefined);
});
