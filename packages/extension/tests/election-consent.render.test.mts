// The wallet's ballot window, mounted.
//
// What is pinned is what the member sees and what the window sends back: Cast
// stays disabled until the ballot is one the ballot box admits, the choices go
// back as a ballot bound to the election's digest and the window stays to show
// the cast, Cancel sends none, and a window opened straight after the ticket
// warns that the two can be paired. Before the ballot the window may ask to
// reach the ballot box, or say this wallet voted already; after it, it shows
// each step of the cast as the background reports it.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { act } from "react";

import { h, render } from "./harness/dom.mjs";

const DIGEST = "uEiDigest";

const election = {
  electionId: "agm-2027",
  title: "AGM 2027",
  state: "voting",
  secrecy: "open",
  registrationOpensAt: "2026-11-01T00:00:00Z",
  votingOpensAt: "2026-11-02T00:00:00Z",
  votingClosesAt: "2026-11-03T00:00:00Z",
  binding: false,
  questions: [
    { key: "chair", type: "choice", text: "Who chairs?", options: [{ key: "ana", label: "Ana" }, { key: "bo", label: "Bo" }], optional: false, minSelections: 1, maxSelections: 1 },
    { key: "note", type: "text", text: "Anything else?", options: [], optional: true, maxLength: 100 },
  ],
  disclosure: { ballotBox: "did:webvh:QmBox:b.example", ballotBoxOperator: "Independent Ballots Ltd", sameOperator: true, boardVisibility: "public", revote: "replace", auditors: [] },
};

const manifest = {
  electionId: "agm-2027",
  questions: [
    { key: "chair", type: "choice", text: "Who chairs?", options: [{ key: "ana", label: "Ana" }, { key: "bo", label: "Bo" }], minSelections: 1, maxSelections: 1, optional: false },
    { key: "note", type: "text", text: "Anything else?", maxLength: 100, optional: true },
  ],
  secrecy: "open",
};

function view(over: Record<string, unknown> = {}) {
  return {
    kind: "ballot",
    origin: "https://members.acme.example",
    communityName: "Acme Guild",
    member: "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
    election,
    manifest,
    manifestDigest: DIGEST,
    boxOrigin: "https://b.example",
    needsReach: false,
    canRevote: true,
    ...over,
  };
}

async function mount(v: Record<string, unknown>, opts: { progress?: unknown; grant?: boolean } = {}) {
  const changed = new Set<(c: Record<string, { newValue?: unknown }>, area: string) => void>();
  const requested: unknown[] = [];
  const chrome = {
    runtime: { onMessage: { addListener() {}, removeListener() {} }, async sendMessage() {} },
    storage: {
      session: {
        get: async (k: string) =>
          k.startsWith("election-progress:") ? (opts.progress ? { [k]: opts.progress } : {}) : { [k]: v },
        remove: async () => {},
      },
      local: { get: (_k: string, cb: (i: Record<string, unknown>) => void) => cb({}) },
      onChanged: {
        addListener: (l: never) => void changed.add(l),
        removeListener: (l: never) => void changed.delete(l),
      },
    },
    permissions: {
      onAdded: { addListener() {}, removeListener() {} },
      async contains() {
        return opts.grant ?? false;
      },
      async request(r: unknown) {
        requested.push(r);
        return opts.grant ?? false;
      },
    },
  };
  Object.defineProperty(globalThis, "chrome", { value: chrome, writable: true, configurable: true });
  const decided: { approved: boolean; ballot?: unknown; keepOpen?: boolean }[] = [];
  const { ElectionConsent } = await import("../src/election-consent.js");
  const rendered = await render(h(ElectionConsent, { consentId: "c1", decide: (d: never) => decided.push(d) }), { chrome });
  await rendered.settle();
  /** The background reports a step. */
  const report = async (p: unknown) => {
    await act(async () => {
      for (const l of [...changed]) l({ "election-progress:c1": { newValue: p } }, "session");
    });
    await rendered.settle();
  };
  return { rendered, decided, requested, report };
}

test("Cast stays off until every required question is answered; the ballot is bound to the election", async () => {
  const { rendered, decided } = await mount(view());
  const text = rendered.text();
  assert.match(text, /Who chairs\?/);
  assert.match(text, /Independent Ballots Ltd/);
  assert.match(text, /same operator runs this community/, "a shared operator is said out loud");
  const cast = rendered.button("Cast my vote") as HTMLButtonElement;
  assert.equal(cast.disabled, true);
  assert.match(rendered.text(), /must be answered/);

  const ana = rendered.all('input[type="radio"]')[0] as HTMLInputElement;
  await rendered.click(ana);
  await rendered.settle();
  assert.equal((rendered.button("Cast my vote") as HTMLButtonElement).disabled, false);
  await rendered.click(rendered.button("Cast my vote"));
  assert.deepEqual(decided, [
    {
      approved: true,
      ballot: {
        electionId: "agm-2027",
        manifestDigest: DIGEST,
        answers: [
          { question: "chair", choice: ["ana"] },
          { question: "note", abstain: true },
        ],
      },
      keepOpen: true,
    },
  ]);
  await rendered.unmount();
});

test("the ballot names the ticket, not who is voting: the vote does not carry the identity", async () => {
  const { rendered } = await mount(view());
  assert.doesNotMatch(rendered.text(), /Voting as/);
  assert.match(rendered.text(), /Your ticket/);
  assert.match(rendered.text(), /it does not carry this identity, and neither Acme Guild nor the ballot box can tell it is yours/);
  await rendered.unmount();
});

test("a ballot box the wallet may not reach is asked for first, from the member's click", async () => {
  const refused = await mount(view({ needsReach: true }));
  assert.match(refused.rendered.text(), /straight to the ballot box at b\.example/);
  assert.equal(refused.rendered.all('[data-testid="ballot-cast"]').length, 0, "no ballot before the box is reachable");
  await refused.rendered.click(refused.rendered.button("Allow"));
  await refused.rendered.settle();
  assert.deepEqual(refused.requested, [{ origins: ["https://b.example/*"] }]);
  assert.match(refused.rendered.text(), /was not allowed to reach b\.example/);
  await refused.rendered.unmount();

  const granted = await mount(view({ needsReach: true }), { grant: true });
  await granted.rendered.click(granted.rendered.button("Allow"));
  await granted.rendered.settle();
  assert.ok(granted.rendered.button("Cast my vote"), "the ballot follows the grant");
  await granted.rendered.unmount();
});

test("after Cast the window stays and shows each step, counting the pause down, until the vote is in", async () => {
  const { rendered, report } = await mount(view());
  await rendered.click(rendered.all('input[type="radio"]')[0]!);
  await rendered.click(rendered.button("Cast my vote"));
  await rendered.settle();
  const states = () =>
    Object.fromEntries(rendered.all("[data-step]").map((el) => [el.getAttribute("data-step"), el.getAttribute("data-state")]));
  assert.deepEqual(states(), { check: "active", seal: "pending", wait: "pending", send: "pending", receipt: "pending" });
  assert.match(rendered.text(), /You can close this window/);

  await report({ phase: "running", step: "wait", waitMs: 9000, waitUntil: Date.now() + 9000 });
  assert.deepEqual(states(), { check: "done", seal: "done", wait: "active", send: "pending", receipt: "pending" });
  assert.match(rendered.text(), /can.t be timed to your ticket — \d+s/);
  assert.match(rendered.text(), /straight to the ballot box at b\.example/);

  await report({ phase: "running", step: "wait", waitMs: 0, waitUntil: Date.now() - 1 });
  assert.equal(states().send, "active", "a pause that is over is the post under way");

  await report({ phase: "done", at: Date.parse("2026-11-02T10:00:00Z"), status: "replaced", leafIndex: 9 });
  assert.ok(Object.values(states()).every((s) => s === "done"));
  assert.match(rendered.text(), /Your vote is in/);
  assert.match(rendered.text(), /replaced your earlier vote with it \(board entry 9\)/);
  await rendered.unmount();
});

test("a failed cast says at which step, and what to do", async () => {
  const { rendered, report } = await mount(view());
  await rendered.click(rendered.all('input[type="radio"]')[0]!);
  await rendered.click(rendered.button("Cast my vote"));
  await report({ phase: "failed", step: "send", error: "The ballot box did not answer in time." });
  const failed = rendered.all('[data-state="failed"]').map((el) => el.getAttribute("data-step"));
  assert.deepEqual(failed, ["send"]);
  assert.match(rendered.text(), /Your vote was not cast/);
  assert.match(rendered.text(), /never counts one ticket twice/);
  await rendered.unmount();
});

test("a remembered vote opens on it, and offers a change only where the election allows one", async () => {
  const voted = { at: Date.parse("2026-11-02T09:00:00Z"), status: "counted", leafIndex: 3 };
  const can = await mount(view({ voted }));
  assert.match(can.rendered.text(), /You voted on/);
  assert.match(can.rendered.text(), /counted it \(board entry 3\)/);
  assert.match(can.rendered.text(), /what this browser.s wallet remembers/);
  assert.equal(can.rendered.all('[data-testid="ballot-cast"]').length, 0);
  await can.rendered.click(can.rendered.button("Change my vote"));
  await can.rendered.settle();
  assert.ok(can.rendered.button("Cast my vote"));
  assert.match(can.rendered.text(), /This vote replaces the one you cast/);
  await can.rendered.unmount();

  const cannot = await mount(view({ voted, canRevote: false, election: { ...election, disclosure: { ...election.disclosure, revote: "reject" } } }));
  assert.match(cannot.rendered.text(), /does not let you change a vote/);
  assert.equal(cannot.rendered.all('[data-testid="election-change-vote"]').length, 0);
  await cannot.rendered.click(cannot.rendered.button("Close"));
  assert.deepEqual(cannot.decided, [{ approved: false }]);
  await cannot.rendered.unmount();
});

test("Cancel sends no ballot", async () => {
  const { rendered, decided } = await mount(view());
  await rendered.click(rendered.button("Cancel"));
  assert.deepEqual(decided, [{ approved: false }]);
  await rendered.unmount();
});

test("a ballot opened just after the ticket warns that the two can be paired by time", async () => {
  const { rendered } = await mount(view({ ticketTakenAt: Date.now() - 30_000 }));
  assert.match(rendered.text(), /You took your ticket just now/);
  await rendered.unmount();
});

// VTI-VOT-065 lets a manifest release written answers after as few as one
// counted ballot; VTI-VOT-090 has the member told so before the ticket, and the
// wallet says it again on the ballot.
const WRITTEN_WARNING = /Written answers are released once 3 ballots are counted\. Below 10, a written answer may identify who wrote it\./;

test("before the ticket, a release threshold below 10 warns that a written answer may identify who wrote it", async () => {
  const ticket = {
    kind: "ticket",
    origin: "https://members.acme.example",
    communityName: "Acme Guild",
    member: "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
    fromVote: false,
  };
  const low = await mount({ ...ticket, election: { ...election, textReleaseThreshold: 3 } });
  assert.match(low.rendered.text(), /Take your ticket/);
  assert.match(low.rendered.text(), WRITTEN_WARNING);
  await low.rendered.unmount();
  for (const e of [{ ...election, textReleaseThreshold: 10 }, election]) {
    const ok = await mount({ ...ticket, election: e });
    assert.doesNotMatch(ok.rendered.text(), /Written answers are released/);
    await ok.rendered.unmount();
  }
});

test("the ballot repeats the warning below 10, and not at or above it", async () => {
  const low = await mount(view({ election: { ...election, textReleaseThreshold: 3 } }));
  assert.match(low.rendered.text(), WRITTEN_WARNING);
  await low.rendered.unmount();
  const one = await mount(view({ election: { ...election, textReleaseThreshold: 1 } }));
  assert.match(one.rendered.text(), /released once 1 ballot is counted/);
  await one.rendered.unmount();
  const ok = await mount(view({ election: { ...election, textReleaseThreshold: 12 } }));
  assert.doesNotMatch(ok.rendered.text(), /Written answers are released/);
  await ok.rendered.unmount();
});

// ── Credential rolls (VTI-VOT-016, VTI-VOT-025, VTI-VOT-090) ────────────────

const PARTY = "did:webvh:QmParty:party.example";
const rollCredential = { memberOf: PARTY, memberOfKind: "communityGroup", memberOfName: "Engineering" };
const ticketView = {
  kind: "ticket",
  origin: "https://members.acme.example",
  communityName: "Acme Guild",
  member: "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
  fromVote: false,
};

test("vti_vot_025: the ticket window says claiming presents the membership, and the button says so too", async () => {
  const { rendered, decided } = await mount({
    ...ticketView,
    election: { ...election, disclosure: { ...election.disclosure, rollCredential } },
    presents: rollCredential,
  });
  const text = rendered.text();
  assert.match(text, /Only holders of a membership credential issued by the group Engineering take a ticket/);
  assert.match(text, /Acme Guild learns that you are a member of that party/);
  await rendered.click(rendered.button("Show my membership and take my ticket"));
  assert.deepEqual(decided, [{ approved: true }]);
  await rendered.unmount();
});

test("a ticket window under any other roll says nothing of a membership", async () => {
  const { rendered } = await mount({ ...ticketView, election });
  assert.doesNotMatch(rendered.text(), /membership credential/);
  assert.ok(rendered.button("Take my ticket"));
  await rendered.unmount();
});

test("vti_vot_090: the ballot window's disclosure names whose membership credential counts", async () => {
  const { rendered } = await mount(
    view({ election: { ...election, disclosure: { ...election.disclosure, rollCredential: { memberOf: PARTY, memberOfKind: "memberParty" } } } }),
  );
  assert.match(rendered.text(), new RegExp(`issued by ${PARTY}, a member of this community`));
  await rendered.unmount();
});

test("vti_vot_016: the disclose window says the community learns the membership before the election is seen", async () => {
  const { rendered, decided } = await mount({
    kind: "disclose",
    origin: "https://members.acme.example",
    communityName: "Acme Guild",
    member: "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
    electionId: "agm-2027",
    memberOf: PARTY,
  });
  const text = rendered.text();
  assert.match(text, /Acme Guild shows this election only to members of/);
  assert.match(text, /before you have seen what the election asks/);
  await rendered.click(rendered.button("Cancel"));
  assert.deepEqual(decided, [{ approved: false }]);
  await rendered.unmount();
});

// ── VTI-VOT-053: a vote checked after close ──────────────────────────────────

const checkView = (outcome: unknown) => ({ kind: "check", communityName: "Acme Guild", electionTitle: "AGM 2027", outcome });

test("vti_vot_053: a vote on the board is said so, with the head it was checked against", async () => {
  const { rendered, decided } = await mount(
    checkView({ ok: true, deleted: false, treeSize: 12, receipts: [{ leafIndex: 4, status: "included" }] }),
  );
  assert.match(rendered.text(), /Your vote in AGM 2027 is on the board/);
  assert.match(rendered.text(), /Board entry 4: in the board/);
  assert.match(rendered.text(), /12 entries/);
  assert.equal(rendered.all('[data-testid="election-check-missing"]').length, 0);
  await rendered.click(rendered.button("Done"));
  assert.deepEqual(decided, [{ approved: true }]);
  await rendered.unmount();
});

test("vti_vot_053: a vote the community's head omits is said plainly, first", async () => {
  const { rendered } = await mount(
    checkView({ ok: true, deleted: true, treeSize: 3, receipts: [{ leafIndex: 4, status: "notIncluded" }] }),
  );
  assert.match(rendered.text(), /Your vote is missing from AGM 2027's board/);
  const alert = rendered.all('[data-testid="election-check-missing"]');
  assert.equal(alert.length, 1);
  assert.match(alert[0]!.textContent ?? "", /board entry 4\) that the board Acme Guild kept at the close does not hold/);
  assert.match(rendered.text(), /board was deleted/);
  await rendered.unmount();
});

test("vti_vot_053: no receipt, or a failure, is said in the window", async () => {
  const none = await mount(checkView({ ok: true, none: true }));
  assert.match(none.rendered.text(), /keeps no receipt for this election/);
  await none.rendered.unmount();
  const failed = await mount(checkView({ ok: false, error: "Voting has not closed yet. Check your vote once it has." }));
  assert.match(failed.rendered.text(), /could not be checked/);
  assert.match(failed.rendered.text(), /Voting has not closed yet/);
  await failed.rendered.unmount();
});
