// The sign-in window, rendered: the words a person decides on.
//
// Pinned: the confirm screen names the community from the wallet's record and
// the portal from the verified document; Continue sends only the chosen entry;
// a different self-given name is flagged on the number screen; the review
// shows browser, location and the network line; Approve runs the passkey over
// the challenge it was handed and only then responds; a cancelled passkey
// leaves the review open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { SignInView } from "../src/sign-in-view.js";
import type { SignInStep, SignInStepResult } from "../src/bridge-protocol.js";
import { PrfUnlockError } from "../src/webauthn-prf-unlock.js";

const PORTAL = "https://members.example.org";

function script(results: Record<string, SignInStepResult>) {
  const steps: SignInStep[] = [];
  const send = async (s: SignInStep) => {
    steps.push(s);
    const key = s.step === "respond" ? `respond:${s.decision}` : s.step;
    return { ok: true as const, result: results[key]! };
  };
  return { steps, send };
}

const RESULTS: Record<string, SignInStepResult> = {
  prepare: {
    kind: "confirm",
    communityName: "Example Community",
    portalOrigin: PORTAL,
    identities: [
      { entryId: "e1", did: "did:web:alice.example", label: "Alice" },
      { entryId: "e2", did: "did:web:work.example", label: "Work" },
    ],
  },
  claim: { kind: "enter-number", nameMismatch: "Totally Legit Bank", decisionDeadline: Date.now() + 60_000 },
  prove: {
    kind: "review",
    location: "Sydney, Australia",
    browser: "Chrome",
    os: "macOS",
    createdAt: new Date().toISOString(),
    network: "different",
    identifiedAs: "did:web:work.example",
  },
  "grant-digest": { kind: "uv-challenge", challenge: "Q0hBTExFTkdF" },
  "respond:approve": { kind: "done", decision: "approve", status: "approved" },
  "enrol-uv": { kind: "uv-enrolled" },
};

const ENROLMENT = {
  kind: "webauthn" as const,
  credentialId: "Y3JlZA",
  publicKeyMultibase: "zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169",
  rpId: "ext",
  origin: "chrome-extension://ext",
  hardwareBacked: false,
  biometricGated: false,
};
const ASSERTION = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key" as const,
  response: { clientDataJSON: "j", authenticatorData: "a", signature: "s" },
};

type Enrolment = typeof ENROLMENT;

test("confirm → number → review → approve with the passkey", async () => {
  const { steps, send } = script(RESULTS);
  const challenges: string[] = [];
  const remembered: Enrolment[] = [];
  const uv = {
    stored: async () => remembered[0],
    create: async () => ENROLMENT,
    remember: async (e: Enrolment) => void remembered.push(e),
    assert: async (id: string, c: string) => {
      challenges.push(`${id}:${c}`);
      return ASSERTION;
    },
  };
  const screen = await render(h(SignInView, { flowId: "f", send, uv, close: () => {} }));
  await screen.settle();
  assert.match(screen.text(), /Sign in to Example Community\?/);
  assert.match(screen.text(), new RegExp(PORTAL.replace(/[.]/g, "\\.")));

  const radios = screen.container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  await screen.click(radios[1]!);
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  assert.deepEqual(steps[1], { step: "claim", entryId: "e2" });

  assert.match(screen.container.querySelector('[data-testid="name-mismatch"]')!.textContent!, /Totally Legit Bank/);
  await screen.type(screen.container.querySelector('[data-testid="number"]')!, "47");
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.deepEqual(steps[2], { step: "prove", enteredNumber: "47" });

  assert.match(screen.text(), /Chrome on macOS · near Sydney, Australia/);
  assert.match(screen.text(), /Not on this browser's network/);
  await screen.click(screen.container.querySelector('[data-testid="approve"]')!);
  await screen.settle();
  // First approval on this browser: the VTA holds no passkey for it, so
  // create, enrol, remember, then assert over a fresh grant.
  assert.deepEqual(steps.slice(3).map((s) => s.step), ["grant-digest", "enrol-uv", "grant-digest", "respond"]);
  assert.deepEqual(remembered, [ENROLMENT]);
  assert.deepEqual(challenges, [`${ENROLMENT.credentialId}:Q0hBTExFTkdF`]);
  assert.match(screen.text(), /Approved/);
  await screen.unmount();
});

/** The VTA already holds this browser's passkey. */
const ENROLLED: Record<string, SignInStepResult> = {
  ...RESULTS,
  "grant-digest": { kind: "uv-challenge", challenge: "Q0hBTExFTkdF", uvCredentialId: ENROLMENT.credentialId },
};

async function approveOnReview(uv: Parameters<typeof SignInView>[0]["uv"], results: Record<string, SignInStepResult>) {
  const { steps, send } = script(results);
  const screen = await render(h(SignInView, { flowId: "f", send, uv, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  await screen.type(screen.container.querySelector('[data-testid="number"]')!, "47");
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  await screen.click(screen.container.querySelector('[data-testid="approve"]')!);
  await screen.settle();
  return { steps, screen };
}

test("a passkey the VTA already holds is asserted without enrolling again", async () => {
  let created = 0;
  const challenges: string[] = [];
  const { steps, screen } = await approveOnReview(
    {
      stored: async () => ENROLMENT,
      create: async () => (created++, ENROLMENT),
      remember: async () => {},
      assert: async (id: string, c: string) => (challenges.push(`${id}:${c}`), ASSERTION),
    },
    ENROLLED,
  );
  assert.deepEqual(steps.slice(3).map((s) => s.step), ["grant-digest", "respond"]);
  assert.equal(created, 0);
  assert.deepEqual(challenges, [`${ENROLMENT.credentialId}:Q0hBTExFTkdF`]);
  assert.match(screen.text(), /Approved/);
  await screen.unmount();
});

test("this browser's passkey is enrolled at an agent that does not hold it, without making another", async () => {
  // A second agent, or a holder onboarded again: the window has its passkey,
  // the VTA does not.
  let created = 0;
  const { steps, screen } = await approveOnReview(
    {
      stored: async () => ENROLMENT,
      create: async () => (created++, ENROLMENT),
      remember: async () => {},
      assert: async () => ASSERTION,
    },
    RESULTS,
  );
  assert.equal(created, 0);
  assert.deepEqual(steps.slice(3).map((s) => s.step), ["grant-digest", "enrol-uv", "grant-digest", "respond"]);
  assert.deepEqual((steps[4] as { enrolment: unknown }).enrolment, ENROLMENT);
  await screen.unmount();
});

test("a cancelled passkey prompt is not a decision", async () => {
  const { steps, send } = script(ENROLLED);
  const uv = {
    stored: async () => ENROLMENT,
    create: async () => ENROLMENT,
    remember: async () => {},
    assert: async () => {
      throw new PrfUnlockError("cancelled", "cancelled");
    },
  };
  const screen = await render(h(SignInView, { flowId: "f", send, uv, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  await screen.type(screen.container.querySelector('[data-testid="number"]')!, "47");
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  await screen.click(screen.container.querySelector('[data-testid="approve"]')!);
  await screen.settle();
  assert.equal(steps.some((s) => s.step === "respond"), false);
  assert.match(screen.text(), /Approval cancelled/);
  assert.ok(screen.container.querySelector('[data-testid="approve"]'));
  await screen.unmount();
});

test("a refused link shows only the message", async () => {
  const { send } = script({ prepare: { kind: "refused", outcome: "update", message: "This code needs a newer version of the app." } });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  assert.equal(screen.container.querySelector('[data-testid="message"]')!.textContent, "This code needs a newer version of the app.");
  await screen.unmount();
});

// ── Layout, keyboard, and the words around a failure ─────────────────────────

const NOW = 1_791_460_900_000;

test("every screen after the first is headed by the community and the portal, host first", async () => {
  const { send } = script(RESULTS);
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  await screen.settle();
  assert.equal(screen.container.querySelector('[data-testid="community"]')!.textContent, "Example Community");
  const portal = screen.container.querySelector('[data-testid="portal"]')!;
  assert.equal(portal.textContent, PORTAL, "the origin reads back whole");
  assert.equal(portal.getAttribute("title"), PORTAL);
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  assert.equal(screen.container.querySelector('[data-testid="community"]')!.textContent, "Example Community");
  await screen.unmount();
});

test("Enter continues and proves; the number field is numeric and focused", async () => {
  const { steps, send } = script(RESULTS);
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  await screen.settle();
  await screen.key("Enter");
  assert.deepEqual(steps[1], { step: "claim", entryId: "e1" });
  const input = screen.container.querySelector<HTMLInputElement>('[data-testid="number"]')!;
  assert.equal(input.getAttribute("inputmode"), "numeric");
  await screen.key("Enter");
  assert.equal(steps.length, 2, "Enter does nothing until two digits are typed");
  await screen.type(input, "4");
  await screen.key("Enter");
  assert.equal(steps.length, 2, "nor after one: no auto-advance on a half-typed number");
  await screen.type(input, "47");
  assert.equal(steps.length, 2, "two digits do not submit by themselves");
  await screen.key("Enter");
  assert.deepEqual(steps[2], { step: "prove", enteredNumber: "47" });
  await screen.unmount();
});

test("Escape declines: the held claim is cancelled and the window closes", async () => {
  const { steps, send } = script({ ...RESULTS, cancel: { kind: "done", decision: "decline", status: "cancelled" } });
  let closed = 0;
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => void closed++, now: () => NOW }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  await screen.key("Escape");
  await screen.settle();
  assert.deepEqual(steps.at(-1), { step: "cancel" });
  assert.equal(closed, 1);
  await screen.unmount();
});

test("the number screen counts down to the decision deadline", async () => {
  const { send } = script({ ...RESULTS, claim: { kind: "enter-number", decisionDeadline: NOW + 107_000 } });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  assert.match(screen.container.querySelector('[data-testid="countdown"]')!.textContent!, /1:47/);
  assert.equal(screen.container.querySelector('[data-testid="name-mismatch"]'), null, "no mismatch, no warning");
  await screen.unmount();
});

test("a mismatched name that is a DID is shortened, with the whole value one click away", async () => {
  const did = "did:webvh:QmNvAiYMwoZMWGfY62gqNJuedQgH224FMpHenzJTK1wJrG:webvh.storm.ws:test-vtc";
  const { send } = script({ ...RESULTS, claim: { kind: "enter-number", nameMismatch: did, decisionDeadline: NOW + 60_000 } });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  const box = screen.container.querySelector('[data-testid="name-mismatch"]')!;
  assert.equal(box.textContent!.includes(did), false, "shortened");
  assert.match(box.textContent!, /webvh\.storm\.ws/, "the host survives");
  assert.ok(box.querySelector(`[title="${did}"]`), "the whole value is in the tooltip");
  await screen.click(screen.button("Show full"));
  assert.equal(box.textContent!.includes(did), true);
  await screen.unmount();
});

test("a failure keeps its plain message and says where, who and which code under Details", async () => {
  const message = "This code can't be used. Refresh the code on the website and try again.";
  const { send } = script({
    ...RESULTS,
    prove: { kind: "failed", code: "sign-in/failed", message, stage: "identify", party: "vta", cause: "oobSomethingNew" },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  await screen.type(screen.container.querySelector('[data-testid="number"]')!, "47");
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.equal(screen.container.querySelector('[data-testid="message"]')!.textContent, message);
  const details = screen.container.querySelector('[data-testid="failure-details"]')!.textContent!.replace(/\s+/g, " ");
  assert.match(details, /sign-in\/failed/);
  assert.match(details, /oobSomethingNew/);
  assert.match(details, /identify/);
  assert.match(details, /your agent/);
  await screen.unmount();
});
