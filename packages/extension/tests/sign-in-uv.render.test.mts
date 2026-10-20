// The sign-in window approving without a PRF passkey: a PIN, or the phone.
//
// Pinned: the review says which way this browser approves; with none set up a
// "Use a PIN or my phone instead" opens the chooser, and so does Approve when
// the browser says it has no PRF or the passkey turns out to lack it; setting
// a PIN asks twice and sends it once with `setPin`; a PIN approval shows the
// tries left after a wrong one and the lock; a phone approval shows the code
// and asks again until it is answered, and Cancel stops the asking; no phone
// known says how to pair one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { SignInView } from "../src/sign-in-view.js";
import type { SignInStep, SignInStepResult } from "../src/bridge-protocol.js";
import { PrfUnavailableError, PRF_UNSUPPORTED_MESSAGE } from "../src/webauthn-prf-wrap.js";

const PORTAL = "https://members.example.org";

const REVIEW: Extract<SignInStepResult, { kind: "review" }> = {
  kind: "review",
  location: "Sydney, Australia",
  browser: "Chrome",
  os: "Linux",
  createdAt: new Date().toISOString(),
  network: "same",
  identifiedAs: "did:web:alice.example",
  audience: "member",
  decisionDeadline: Date.now() + 60_000,
};

/** A flow that answers each step from `results`, taking the next of a list
 *  each time (the last one repeats). Starts on the review. */
function script(results: Record<string, SignInStepResult | SignInStepResult[]>) {
  const steps: SignInStep[] = [];
  const send = async (s: SignInStep) => {
    steps.push(s);
    const key = s.step === "respond" ? `respond:${s.decision}` : s.step;
    const r = results[key];
    const result = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]!) : r!;
    return { ok: true as const, result };
  };
  return { steps, send };
}

function flow(review: Partial<typeof REVIEW>, more: Record<string, SignInStepResult | SignInStepResult[]> = {}) {
  return script({
    prepare: {
      kind: "confirm",
      communityName: "Example Community",
      portalOrigin: PORTAL,
      identities: [{ entryId: "e1", did: "did:web:alice.example", label: "Alice" }],
    },
    // One identity, the page's number: straight to the review.
    claim: { ...REVIEW, ...review },
    "grant-digest": { kind: "uv-challenge", challenge: "Q0hBTExFTkdF", vtaDid: "did:webvh:vta" },
    "respond:approve": { kind: "done", decision: "approve", status: "approved" },
    ...more,
  });
}

const NO_PASSKEY = {
  enrolled: async () => false,
  enrol: async () => {
    throw new Error("must not make a passkey");
  },
  unlock: async () => new Uint8Array([1]),
};

const $ = (screen: Awaited<ReturnType<typeof render>>, id: string) =>
  screen.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function open(send: ReturnType<typeof script>["send"], uv = NO_PASSKEY, pollMs = 2000) {
  const screen = await render(h(SignInView, { flowId: "f", send, uv, close: () => {}, pollMs, approvedCloseMs: 60_000 }));
  await screen.settle();
  return screen;
}

async function waitFor(screen: Awaited<ReturnType<typeof render>>, ok: () => boolean, ms = 500) {
  const until = Date.now() + ms;
  while (!ok() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5));
    await screen.settle();
  }
}

test("nothing set up: the review offers a PIN or the phone, and the chooser has both", async () => {
  const { send } = flow({});
  const screen = await open(send);
  assert.match(screen.text(), /Approving asks for your passkey/);
  await screen.click($(screen, "uv-other")!);
  assert.match(screen.text(), /How should this browser approve sign-ins\?/);
  assert.ok($(screen, "choose-pin"));
  assert.ok($(screen, "choose-phone"));
  assert.equal($(screen, "no-prf"), null, "asked for, not forced");
  await screen.click($(screen, "back")!);
  assert.match(screen.text(), /Approve this sign-in\?/);
  await screen.unmount();
});

test("a browser that says it has no PRF goes straight to the chooser, and no passkey is made", async () => {
  const { steps, send } = flow({});
  const screen = await open(send, { ...NO_PASSKEY, offersPrf: async () => false });
  await screen.click($(screen, "approve")!);
  await screen.settle();
  assert.match(screen.text(), /How should this browser approve sign-ins\?/);
  assert.match($(screen, "no-prf")!.textContent!, /can't keep a passkey/);
  assert.equal(steps.some((s) => s.step === "grant-digest"), false);
  await screen.unmount();
});

test("a passkey that turns out to have no PRF opens the chooser instead of an error", async () => {
  const { send } = flow({});
  const screen = await open(send, {
    ...NO_PASSKEY,
    enrol: async () => {
      throw new PrfUnavailableError(PRF_UNSUPPORTED_MESSAGE);
    },
  });
  await screen.click($(screen, "approve")!);
  await screen.settle();
  assert.ok($(screen, "no-prf"));
  await screen.unmount();
});

test("setting a PIN: 6 or more, entered twice, sent once with setPin; then approved", async () => {
  const { steps, send } = flow({});
  const screen = await open(send);
  await screen.click($(screen, "uv-other")!);
  await screen.click($(screen, "choose-pin")!);
  assert.match(screen.text(), /Set a PIN/);
  const setPin = () => $(screen, "set-pin") as HTMLButtonElement;
  await screen.type($(screen, "pin")!, "12345");
  await screen.type($(screen, "pin-again")!, "12345");
  assert.equal(setPin().disabled, true, "too short");
  await screen.type($(screen, "pin")!, "246810");
  await screen.type($(screen, "pin-again")!, "246811");
  assert.ok($(screen, "pin-mismatch"));
  assert.equal(setPin().disabled, true);
  await screen.type($(screen, "pin-again")!, "246810");
  assert.equal(setPin().disabled, false);
  await screen.click(setPin());
  await screen.settle();
  assert.deepEqual(steps.slice(-2), [
    { step: "grant-digest" },
    { step: "respond", decision: "approve", pin: "246810", setPin: true },
  ]);
  assert.match(screen.text(), /Approved/);
  await screen.unmount();
});

test("PIN approval: a wrong PIN shows the tries left, a lock says until when and holds the PIN back", async () => {
  const lockedUntil = Date.now() + 15 * 60_000;
  const { steps, send } = flow(
    { uvMethod: "vtaPin" },
    {
      "respond:approve": [
        { kind: "uv-pin", attemptsRemaining: 2 },
        { kind: "uv-pin", lockedUntil },
      ],
    },
  );
  const screen = await open(send);
  assert.match(screen.text(), /Approving asks for your PIN/);
  assert.equal($(screen, "uv-other"), null, "a method is set up");
  await screen.click($(screen, "approve")!);
  assert.match(screen.text(), /Enter your PIN/);
  assert.equal(steps.some((s) => s.step === "grant-digest"), false, "nothing is sent before the PIN");
  await screen.type($(screen, "pin")!, "000000");
  await screen.click($(screen, "approve-pin")!);
  await screen.settle();
  assert.deepEqual(steps.at(-1), { step: "respond", decision: "approve", pin: "000000" });
  assert.match($(screen, "pin-wrong")!.textContent!, /Wrong PIN\. 2 tries left before it locks\./);
  assert.equal(($(screen, "pin") as HTMLInputElement).value, "", "the PIN is not kept on screen");

  await screen.type($(screen, "pin")!, "111111");
  await screen.click($(screen, "approve-pin")!);
  await screen.settle();
  assert.match($(screen, "pin-locked")!.textContent!, /Locked until/);
  assert.equal(($(screen, "approve-pin") as HTMLButtonElement).disabled, true);
  assert.equal(($(screen, "pin") as HTMLInputElement).disabled, true);
  await screen.unmount();
});

test("phone approval: the code is shown, the same request is sent again until approved", async () => {
  const pending: SignInStepResult = { kind: "uv-pending", matchCode: "42" };
  const { steps, send } = flow(
    { uvMethod: "remoteApprover" },
    { "respond:approve": [pending, pending, { kind: "done", decision: "approve", status: "approved" }] },
  );
  const screen = await open(send, NO_PASSKEY, 5);
  assert.match(screen.text(), /Approving asks your phone/);
  await screen.click($(screen, "approve")!);
  await screen.settle();
  assert.match(screen.text(), /Approve on your phone/);
  assert.equal($(screen, "match-code")!.textContent, "42");
  await waitFor(screen, () => /Approved/.test(screen.text()));
  assert.match(screen.text(), /Approved/);
  const responds = steps.filter((s) => s.step === "respond");
  assert.equal(responds.length, 3);
  assert.ok(responds.every((s) => JSON.stringify(s) === JSON.stringify({ step: "respond", decision: "approve", remote: true })));
  assert.equal(steps.filter((s) => s.step === "grant-digest").length, 1, "one grant, asked about again");
  await screen.unmount();
});

test("phone approval: Cancel stops the asking and goes back to the review", async () => {
  const { steps, send } = flow({ uvMethod: "remoteApprover" }, { "respond:approve": { kind: "uv-pending", matchCode: "07" } });
  const screen = await open(send, NO_PASSKEY, 5);
  await screen.click($(screen, "approve")!);
  await screen.settle();
  await waitFor(screen, () => steps.filter((s) => s.step === "respond").length >= 2);
  await screen.click($(screen, "cancel-phone")!);
  const sent = steps.length;
  await new Promise((r) => setTimeout(r, 40));
  await screen.settle();
  assert.equal(steps.length, sent, "nothing more is sent");
  assert.match(screen.text(), /Approve this sign-in\?/);
  assert.match(screen.text(), /Approval cancelled/);
  await screen.unmount();
});

test("phone approval: the time to decide running out stops the asking", async () => {
  const { steps, send } = flow(
    { uvMethod: "remoteApprover", decisionDeadline: Date.now() + 20 },
    { "respond:approve": { kind: "uv-pending", matchCode: "07" } },
  );
  const screen = await open(send, NO_PASSKEY, 10);
  await screen.click($(screen, "approve")!);
  await waitFor(screen, () => /didn't approve this sign-in in time/.test(screen.text()));
  assert.match(screen.text(), /didn't approve this sign-in in time/);
  assert.deepEqual(steps.at(-1), { step: "cancel" });
  await screen.unmount();
});

test("choosing the phone: the agent's phones to pick from, then the request goes to the one picked", async () => {
  const { steps, send } = flow(
    {},
    {
      "uv-approvers": { kind: "uv-approvers", approvers: [{ did: "did:key:z6MkPhone", displayName: "Alice's iPhone" }] },
      "respond:approve": { kind: "uv-pending", matchCode: "42" },
    },
  );
  const screen = await open(send, NO_PASSKEY, 60_000);
  await screen.click($(screen, "uv-other")!);
  await screen.click($(screen, "choose-phone")!);
  await screen.settle();
  assert.match(screen.text(), /Alice's iPhone/);
  await screen.click($(screen, "use-phone")!);
  await screen.settle();
  assert.deepEqual(steps.at(-1), { step: "respond", decision: "approve", remote: true, approver: "did:key:z6MkPhone" });
  assert.equal($(screen, "match-code")!.textContent, "42");
  await screen.unmount();
});

test("no phone known: says how to connect one, and nothing can be sent", async () => {
  const { send } = flow({}, { "uv-approvers": { kind: "uv-approvers", approvers: [] } });
  const screen = await open(send);
  await screen.click($(screen, "uv-other")!);
  await screen.click($(screen, "choose-phone")!);
  await screen.settle();
  assert.match($(screen, "no-phones")!.textContent!, /Open the OpenVTC app on your phone and connect it/);
  assert.equal(($(screen, "use-phone") as HTMLButtonElement).disabled, true);
  await screen.unmount();
});
