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
  claim: {
    kind: "enter-number",
    nameMismatch: "Totally Legit Bank",
    decisionDeadline: Date.now() + 60_000,
    audience: "member",
  },
  prove: {
    kind: "review",
    location: "Sydney, Australia",
    browser: "Chrome",
    os: "macOS",
    createdAt: new Date().toISOString(),
    network: "different",
    identifiedAs: "did:web:work.example",
    audience: "member",
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

test("a sign-in to the operator console says so on the number screen and the review", async () => {
  const results: Record<string, SignInStepResult> = {
    ...RESULTS,
    claim: { kind: "enter-number", decisionDeadline: Date.now() + 60_000, audience: "admin" },
    prove: { ...(RESULTS.prove as Extract<SignInStepResult, { kind: "review" }>), audience: "admin" },
  };
  const { send } = script(results);
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  // Screen 1 is before anything is sent: it cannot know, and does not say.
  assert.doesNotMatch(screen.text(), /operator console/);
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  assert.match(screen.text(), new RegExp(`Sign in to Example Community operator console at ${PORTAL.replace(/[.]/g, "\\.")}\\?`));
  assert.ok(screen.container.querySelector('[data-testid="operator-console"]'));
  await screen.type(screen.container.querySelector('[data-testid="number"]')!, "47");
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.match(screen.text(), /Approve this sign-in to the operator console\?/);
  assert.match(screen.text(), /to the operator console at/);
  await screen.unmount();
});

test("a member-portal sign-in reads as before", async () => {
  const { send } = script(RESULTS);
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  assert.match(screen.text(), /Type the number on the screen/);
  assert.equal(screen.container.querySelector('[data-testid="operator-console"]'), null);
  await screen.unmount();
});
