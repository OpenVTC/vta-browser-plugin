// The wallet's ballot window, mounted.
//
// What is pinned is what the member sees and what the window sends back: Cast
// stays disabled until the ballot is one the ballot box admits, the choices go
// back as a ballot bound to the election's digest, Cancel sends none, and a
// window opened straight after the ticket warns that the two can be paired.

import { strict as assert } from "node:assert";
import { test } from "node:test";

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
    ...over,
  };
}

async function mount(v: Record<string, unknown>) {
  const chrome = {
    runtime: { onMessage: { addListener() {}, removeListener() {} }, async sendMessage() {} },
    storage: {
      session: { get: async (k: string) => ({ [k]: v }), remove: async () => {} },
      local: { get: (_k: string, cb: (i: Record<string, unknown>) => void) => cb({}) },
    },
  };
  Object.defineProperty(globalThis, "chrome", { value: chrome, writable: true, configurable: true });
  const decided: { approved: boolean; ballot?: unknown }[] = [];
  const { ElectionConsent } = await import("../src/election-consent.js");
  const rendered = await render(h(ElectionConsent, { consentId: "c1", decide: (d: never) => decided.push(d) }), { chrome });
  await rendered.settle();
  return { rendered, decided };
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
    },
  ]);
  await rendered.unmount();
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
