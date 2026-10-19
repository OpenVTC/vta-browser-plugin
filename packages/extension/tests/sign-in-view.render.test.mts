// The sign-in window, rendered: the words a person decides on.
//
// Pinned: the confirm screen names the community from the wallet's record and
// the portal from the verified document; Continue sends only the chosen entry;
// a different self-given name is flagged on the number screen; the review
// shows browser, location and the network line; Approve runs the passkey
// ceremony over the challenge it was handed (creating the wallet's passkey
// first when there is none) and only then responds with its PRF output; a
// cancelled passkey leaves the review open.

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
  "grant-digest": { kind: "uv-challenge", challenge: "Q0hBTExFTkdF", vtaDid: "did:webvh:vta" },
  "respond:approve": { kind: "done", decision: "approve", status: "approved" },
};

/** The PRF output of the ceremony, and its base64url on the wire. */
const PRF = new Uint8Array([1, 2, 3, 4]);
const PRF_B64U = "AQIDBA";

/** A wallet that has its passkey already. */
const ENROLLED_UV = {
  enrolled: async () => true,
  enrol: async () => {
    throw new Error("must not create a second passkey");
  },
  unlock: async () => PRF,
};

test("confirm → number → review → approve with the passkey", async () => {
  const { steps, send } = script(RESULTS);
  const calls: string[] = [];
  let has = false;
  const uv = {
    enrolled: async () => has,
    enrol: async (vtaDid: string) => {
      calls.push(`enrol:${vtaDid}`);
      has = true;
    },
    unlock: async (c: string) => {
      calls.push(`unlock:${c}`);
      return PRF;
    },
  };
  const screen = await render(
    h(SignInView, { flowId: "f", send, uv, close: () => {} }),
  );
  await screen.settle();
  assert.match(screen.text(), /Sign in to Example Community\?/);
  assert.match(screen.text(), new RegExp(PORTAL.replace(/[.]/g, "\\.")));

  const radios = screen.container.querySelectorAll<HTMLInputElement>(
    'input[type="radio"]',
  );
  await screen.click(radios[1]!);
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  assert.deepEqual(steps[1], { step: "claim", entryId: "e2" });

  assert.match(
    screen.container.querySelector('[data-testid="name-mismatch"]')!
      .textContent!,
    /Totally Legit Bank/,
  );
  await screen.type(
    screen.container.querySelector('[data-testid="number"]')!,
    "47",
  );
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.deepEqual(steps[2], { step: "prove", enteredNumber: "47" });

  assert.match(screen.text(), /Chrome on macOS · near Sydney, Australia/);
  assert.match(screen.text(), /Not on this browser's network/);
  await screen.click(
    screen.container.querySelector('[data-testid="approve"]')!,
  );
  await screen.settle();
  // First approval in a wallet with no passkey: create it (encrypting this
  // agent's record), then the ceremony bound to the grant, then respond with
  // its PRF output. Enrolling the key at the VTA is the offscreen's, inside
  // the respond.
  assert.deepEqual(calls, ["enrol:did:webvh:vta", "unlock:Q0hBTExFTkdF"]);
  assert.deepEqual(
    steps.slice(3).map((s) => s.step),
    ["grant-digest", "respond"],
  );
  assert.deepEqual(steps[4], { step: "respond", decision: "approve", prfOutputB64u: PRF_B64U });
  assert.match(screen.text(), /Approved/);
  await screen.unmount();
});

const ENROLLED = RESULTS;

async function approveOnReview(
  uv: Parameters<typeof SignInView>[0]["uv"],
  results: Record<string, SignInStepResult>,
) {
  const { steps, send } = script(results);
  const screen = await render(
    h(SignInView, { flowId: "f", send, uv, close: () => {} }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  await screen.type(
    screen.container.querySelector('[data-testid="number"]')!,
    "47",
  );
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  await screen.click(
    screen.container.querySelector('[data-testid="approve"]')!,
  );
  await screen.settle();
  return { steps, screen };
}

test("a wallet that has its passkey runs only the ceremony bound to the grant", async () => {
  const challenges: string[] = [];
  const { steps, screen } = await approveOnReview(
    {
      ...ENROLLED_UV,
      unlock: async (c: string) => (challenges.push(c), PRF),
    },
    ENROLLED,
  );
  assert.deepEqual(
    steps.slice(3).map((s) => s.step),
    ["grant-digest", "respond"],
  );
  assert.deepEqual(challenges, ["Q0hBTExFTkdF"]);
  assert.match(screen.text(), /Approved/);
  await screen.unmount();
});

test("a cancelled passkey creation is not a decision either", async () => {
  const { steps, screen } = await approveOnReview(
    {
      enrolled: async () => false,
      enrol: async () => {
        throw new PrfUnlockError("cancelled", "cancelled");
      },
      unlock: async () => PRF,
    },
    ENROLLED,
  );
  assert.equal(steps.some((s) => s.step === "respond"), false);
  assert.match(screen.text(), /Approval cancelled/);
  await screen.unmount();
});

test("a cancelled passkey prompt is not a decision", async () => {
  const { steps, send } = script(ENROLLED);
  const uv = {
    ...ENROLLED_UV,
    unlock: async (): Promise<Uint8Array> => {
      throw new PrfUnlockError("cancelled", "cancelled");
    },
  };
  const screen = await render(
    h(SignInView, { flowId: "f", send, uv, close: () => {} }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  await screen.type(
    screen.container.querySelector('[data-testid="number"]')!,
    "47",
  );
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  await screen.click(
    screen.container.querySelector('[data-testid="approve"]')!,
  );
  await screen.settle();
  assert.equal(
    steps.some((s) => s.step === "respond"),
    false,
  );
  assert.match(screen.text(), /Approval cancelled/);
  assert.ok(screen.container.querySelector('[data-testid="approve"]'));
  await screen.unmount();
});

test("a refused link shows only the message", async () => {
  const { send } = script({
    prepare: {
      kind: "refused",
      outcome: "update",
      message: "This code needs a newer version of the app.",
    },
  });
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {} }),
  );
  await screen.settle();
  assert.equal(
    screen.container.querySelector('[data-testid="message"]')!.textContent,
    "This code needs a newer version of the app.",
  );
  await screen.unmount();
});

test("a refused link field shows no Details", async () => {
  const { send } = script({
    prepare: { kind: "refused", outcome: "invalid", message: "This code can't be used." },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  assert.match(screen.text(), /Code not accepted/);
  assert.equal(screen.container.querySelector('[data-testid="failure-details"]'), null);
  await screen.unmount();
});

const SERVICE_DID = "did:webvh:QmService:members.example.org";
const INVALID = "This code can't be used.";

/** Each refusal about the service's DID document or the page: the headline and
 *  message stay the outcome's, and Details says what is wrong, with the DID. */
const DOCUMENT_REFUSALS: Array<{
  name: string;
  result: SignInStepResult;
  title: RegExp;
  details: string[];
  did?: string;
}> = [
  {
    name: "no SignInPortal service",
    result: {
      kind: "refused",
      outcome: "invalid",
      message: INVALID,
      detail: { reason: "no-portal-service", did: SERVICE_DID, service: "SignInPortal" },
    },
    title: /Code not accepted/,
    details: [
      "no-portal-service",
      "This service's DID document doesn't list a sign-in portal (a SignInPortal service). Ask its operator to add one.",
    ],
    did: SERVICE_DID,
  },
  {
    name: "a SignInPortal service with an unusable endpoint",
    result: {
      kind: "refused",
      outcome: "invalid",
      message: INVALID,
      detail: { reason: "no-portal-service", did: SERVICE_DID, service: "SignInPortal", unusable: true },
    },
    title: /Code not accepted/,
    details: ["lists a sign-in portal (a SignInPortal service), but its endpoint isn't usable", "Ask its operator to fix it."],
    did: SERVICE_DID,
  },
  {
    name: "no TrustTaskHTTPS service",
    result: {
      kind: "refused",
      outcome: "unreachable",
      message: "This service can't be reached from your wallet.",
      detail: { reason: "no-common-transport", did: SERVICE_DID, service: "TrustTaskHTTPS" },
    },
    title: /Community unreachable/,
    details: [
      "no-common-transport",
      "doesn't list a Trust-Task endpoint (a TrustTaskHTTPS service), so the wallet has nowhere to send the sign-in. Ask its operator to add one.",
    ],
    did: SERVICE_DID,
  },
  {
    name: "wrong origin",
    result: {
      kind: "refused",
      outcome: "invalid",
      message: INVALID,
      detail: { reason: "wrong-origin", did: SERVICE_DID, pageOrigin: "https://a.example", portalOrigin: "https://b.example" },
    },
    title: /Code not accepted/,
    details: ["wrong-origin", "This page (https://a.example) isn't the service's sign-in page (https://b.example)."],
    did: SERVICE_DID,
  },
  {
    name: "a DID document that did not verify",
    result: {
      kind: "refused",
      outcome: "invalid",
      message: INVALID,
      detail: { reason: "did-document-unverified", did: SERVICE_DID },
    },
    title: /Code not accepted/,
    details: ["did-document-unverified", "The wallet couldn't fetch or verify this service's DID document."],
    did: SERVICE_DID,
  },
  {
    name: "a contact method sign-in does not accept",
    result: {
      kind: "refused",
      outcome: "invalid",
      message: INVALID,
      detail: { reason: "from-not-allowed", method: "did:key" },
    },
    title: /Code not accepted/,
    details: ["from-not-allowed", "Sign-in doesn't accept a did:key DID as the service's identifier."],
  },
  {
    name: "a DID method this wallet cannot resolve",
    result: {
      kind: "refused",
      outcome: "update",
      message: "This code needs a newer version of the app.",
      detail: { reason: "unsupported-vid", method: "did:example" },
    },
    title: /Update needed/,
    details: ["This wallet can't resolve did:example DIDs yet"],
  },
  {
    name: "a website not linked to the DID",
    result: {
      kind: "failed",
      code: "domain-not-linked",
      message: "This code can't be used. Your wallet couldn't confirm that this website belongs to the community that made the code.",
      stage: "domain-linkage",
      detail: { reason: "domain-not-linked", did: SERVICE_DID, portalOrigin: "https://portal.example.org" },
    },
    title: /Sign-in stopped/,
    details: ["The website (https://portal.example.org) doesn't publish a DID Configuration", "/.well-known/did-configuration.json"],
    did: SERVICE_DID,
  },
];

for (const c of DOCUMENT_REFUSALS) {
  test(`Details for ${c.name} say what is wrong, under the unchanged message`, async () => {
    const { send } = script({ prepare: c.result });
    const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
    await screen.settle();
    assert.match(screen.text(), c.title);
    assert.equal(
      screen.container.querySelector('[data-testid="message"]')!.textContent,
      (c.result as { message: string }).message,
    );
    const details = screen.container.querySelector('[data-testid="failure-details"]')!.textContent!.replace(/\s+/g, " ");
    for (const text of c.details) assert.ok(details.includes(text), `Details has ${JSON.stringify(text)}: ${details}`);
    const did = screen.container.querySelector('[data-testid="details-did"]');
    if (c.did) assert.equal(did!.textContent, c.did, "the DID is shown whole, as selectable text");
    else assert.equal(did, null);
    await screen.unmount();
  });
}

// ── Layout, keyboard, and the words around a failure ─────────────────────────

const NOW = 1_791_460_900_000;

test("every screen after the first is headed by the community and the portal, host first", async () => {
  const { send } = script(RESULTS);
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  assert.equal(
    screen.container.querySelector('[data-testid="community"]')!.textContent,
    "Example Community",
  );
  const portal = screen.container.querySelector('[data-testid="portal"]')!;
  assert.equal(portal.textContent, PORTAL, "the origin reads back whole");
  assert.equal(portal.getAttribute("title"), PORTAL);
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  assert.equal(
    screen.container.querySelector('[data-testid="community"]')!.textContent,
    "Example Community",
  );
  await screen.unmount();
});

test("Enter continues and proves; the number field is numeric and focused", async () => {
  const { steps, send } = script(RESULTS);
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  await screen.key("Enter");
  assert.deepEqual(steps[1], { step: "claim", entryId: "e1" });
  const input = screen.container.querySelector<HTMLInputElement>(
    '[data-testid="number"]',
  )!;
  assert.equal(input.getAttribute("inputmode"), "numeric");
  await screen.key("Enter");
  assert.equal(
    steps.length,
    2,
    "Enter does nothing until two digits are typed",
  );
  await screen.type(input, "4");
  await screen.key("Enter");
  assert.equal(
    steps.length,
    2,
    "nor after one: no auto-advance on a half-typed number",
  );
  await screen.type(input, "47");
  assert.equal(steps.length, 2, "two digits do not submit by themselves");
  await screen.key("Enter");
  assert.deepEqual(steps[2], { step: "prove", enteredNumber: "47" });
  await screen.unmount();
});

test("Escape declines: the held claim is cancelled and the window closes", async () => {
  const { steps, send } = script({
    ...RESULTS,
    cancel: { kind: "done", decision: "decline", status: "cancelled" },
  });
  let closed = 0;
  const screen = await render(
    h(SignInView, {
      flowId: "f",
      send,
      close: () => void closed++,
      now: () => NOW,
    }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  await screen.key("Escape");
  await screen.settle();
  assert.deepEqual(steps.at(-1), { step: "cancel" });
  assert.equal(closed, 1);
  await screen.unmount();
});

test("the number screen counts down to the decision deadline", async () => {
  const { send } = script({
    ...RESULTS,
    claim: { kind: "enter-number", decisionDeadline: NOW + 107_000 },
  });
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  assert.match(
    screen.container.querySelector('[data-testid="countdown"]')!.textContent!,
    /1:47/,
  );
  assert.equal(
    screen.container.querySelector('[data-testid="name-mismatch"]'),
    null,
    "no mismatch, no warning",
  );
  await screen.unmount();
});

test("a mismatched name that is a DID is shortened, with the whole value one click away", async () => {
  const did =
    "did:webvh:QmNvAiYMwoZMWGfY62gqNJuedQgH224FMpHenzJTK1wJrG:webvh.storm.ws:test-vtc";
  const { send } = script({
    ...RESULTS,
    claim: {
      kind: "enter-number",
      nameMismatch: did,
      decisionDeadline: NOW + 60_000,
    },
  });
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  const box = screen.container.querySelector('[data-testid="name-mismatch"]')!;
  assert.equal(box.textContent!.includes(did), false, "shortened");
  assert.match(box.textContent!, /webvh\.storm\.ws/, "the host survives");
  assert.ok(
    box.querySelector(`[title="${did}"]`),
    "the whole value is in the tooltip",
  );
  await screen.click(screen.button("Show full"));
  assert.equal(box.textContent!.includes(did), true);
  await screen.unmount();
});

test("a failure keeps its plain message and says where, who and which code under Details", async () => {
  const message =
    "This code can't be used. Refresh the code on the website and try again.";
  const { send } = script({
    ...RESULTS,
    prove: {
      kind: "failed",
      code: "sign-in/failed",
      message,
      stage: "identify",
      party: "vta",
      cause: "oobSomethingNew",
    },
  });
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  await screen.type(
    screen.container.querySelector('[data-testid="number"]')!,
    "47",
  );
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.equal(
    screen.container.querySelector('[data-testid="message"]')!.textContent,
    message,
  );
  const details = screen.container
    .querySelector('[data-testid="failure-details"]')!
    .textContent!.replace(/\s+/g, " ");
  assert.match(details, /sign-in\/failed/);
  assert.match(details, /oobSomethingNew/);
  assert.match(details, /identify/);
  assert.match(details, /your agent/);
  await screen.unmount();
});

test("a sign-in to the operator console says so on the number screen and the review", async () => {
  const results: Record<string, SignInStepResult> = {
    ...RESULTS,
    claim: {
      kind: "enter-number",
      decisionDeadline: NOW + 60_000,
      audience: "admin",
    },
    prove: {
      ...(RESULTS.prove as Extract<SignInStepResult, { kind: "review" }>),
      audience: "admin",
    },
  };
  const { send } = script(results);
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  // Screen 1 is before anything is sent: it cannot know, and does not say.
  assert.doesNotMatch(screen.text(), /operator console/);
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  assert.equal(
    screen.container.querySelector('[data-testid="subtitle"]')!.textContent,
    "Operator console",
  );
  assert.ok(screen.container.querySelector('[data-testid="operator-console"]'));
  await screen.type(
    screen.container.querySelector('[data-testid="number"]')!,
    "47",
  );
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.match(screen.text(), /Approve this sign-in to the operator console\?/);
  assert.match(screen.text(), /to the operator console at/);
  await screen.unmount();
});

test("a member-portal sign-in reads as before", async () => {
  const { send } = script(RESULTS);
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  assert.match(screen.text(), /Type the number on the screen/);
  assert.equal(
    screen.container.querySelector('[data-testid="operator-console"]'),
    null,
  );
  assert.equal(
    screen.container.querySelector('[data-testid="subtitle"]'),
    null,
  );
  await screen.unmount();
});

// ── A site the wallet does not know ──────────────────────────────────────────

const HOSTING = "https://dids.example.net";
const BOB = "did:webvh:QmBob:dids.example.net:bob";
const WORK = "did:webvh:QmWork:dids.example.net:work";

const JOIN: Record<string, SignInStepResult> = {
  prepare: {
    kind: "join-hosting",
    host: "dids.example.net",
    portalOrigin: HOSTING,
    identities: [
      { did: BOB, contextId: "personal" },
      { did: WORK, contextId: "work" },
    ],
  },
  join: {
    kind: "confirm",
    communityName: "dids.example.net",
    portalOrigin: HOSTING,
    identities: [{ entryId: "e-new", did: WORK, label: "dids.example.net" }],
  },
  cancel: { kind: "done", decision: "decline", status: "cancelled" },
};

test("an unknown DID hosting service is offered by its verified origin; yes records the choice and goes on to confirm", async () => {
  const { steps, send } = script(JOIN);
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }),
  );
  await screen.settle();
  assert.match(screen.text(), /Use dids\.example\.net to host your DIDs\?/);
  assert.equal(
    screen.container.querySelector('[data-testid="portal"]')!.textContent,
    HOSTING,
  );
  const join = screen.container.querySelector<HTMLButtonElement>(
    '[data-testid="join"]',
  )!;
  assert.equal(join.disabled, true, "two identities: the person picks one");
  const radios = screen.container.querySelectorAll<HTMLInputElement>(
    'input[type="radio"]',
  );
  await screen.click(radios[1]!);
  await screen.click(join);
  assert.deepEqual(steps[1], { step: "join", did: WORK });
  assert.match(screen.text(), /Sign in to dids\.example\.net\?/);
  assert.ok(screen.container.querySelector('[data-testid="continue"]'));
  await screen.unmount();
});

test("Not now on the DID hosting offer cancels and closes", async () => {
  const { steps, send } = script(JOIN);
  let closed = 0;
  const screen = await render(
    h(SignInView, { flowId: "f", send, close: () => void closed++ }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="decline"]')!,
  );
  await screen.settle();
  assert.deepEqual(
    steps.map((s) => s.step),
    ["prepare", "cancel"],
  );
  assert.equal(closed, 1);
  await screen.unmount();
});

test("an agent with no DIDs cannot join, and is told why", async () => {
  const { send } = script({
    prepare: { kind: "join-hosting", host: "dids.example.net", portalOrigin: HOSTING, identities: [] },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  assert.ok(screen.container.querySelector('[data-testid="no-identities"]'));
  assert.equal(
    screen.container.querySelector<HTMLButtonElement>('[data-testid="join"]')!.disabled,
    true,
  );
  await screen.unmount();
});

test("a site that is neither a community nor a DID host: not one of your communities, at its verified sign-in page", async () => {
  const { send } = script({
    prepare: { kind: "not-member", contactLabel: "members.example.org", portalOrigin: PORTAL },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  assert.match(screen.text(), /Not one of your communities/);
  assert.match(screen.text(), /You're not a member of members\.example\.org\. Nothing was sent to it\./);
  assert.equal(screen.container.querySelector('[data-testid="portal"]')!.textContent, PORTAL);
  await screen.unmount();
});

test("not on the access list: the DID to send the operator, with a Copy button", async () => {
  const copied: string[] = [];
  const { send } = script({
    prepare: JOIN.join!,
    claim: RESULTS.claim!,
    prove: {
      kind: "failed",
      code: "auth/oob:notAuthorized",
      message: "dids.example.net hasn't added you yet. Send this DID to its operator:",
      stage: "prove",
      party: "community",
      unlisted: { host: "dids.example.net", did: WORK },
    },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  // The harness installs its own `navigator` at render; the clipboard goes on that one.
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="continue"]')!);
  await screen.type(screen.container.querySelector('[data-testid="number"]')!, "47");
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  assert.match(screen.text(), /dids\.example\.net hasn't added you yet/);
  assert.equal(screen.container.querySelector('[data-testid="unlisted-did"]')!.textContent, WORK);
  await screen.click(screen.container.querySelector('[data-testid="copy-did"]')!);
  await screen.settle();
  assert.deepEqual(copied, [WORK]);
  assert.equal(screen.container.querySelector('[data-testid="copy-did"]')!.textContent, "Copied");
  await screen.unmount();
});

// ── An unknown community: joining ───────────────────────────────────────────

const VTC_JOIN: Record<string, SignInStepResult> = {
  prepare: { kind: "join-community", host: "members.example.org", portalOrigin: PORTAL },
  "join-manifest": {
    kind: "join-apply",
    host: "members.example.org",
    portalOrigin: PORTAL,
    displayName: "Example Community",
    admission: "review",
    attributes: [
      { type: "name.display", required: true, purpose: "So members know who you are" },
      { type: "address.country", required: false },
    ],
    identities: [
      { did: BOB, contextId: "personal", usedAt: ["Other Community"] },
      { did: WORK, contextId: "work" },
    ],
  },
  "join-submit": { kind: "join-pending", host: "members.example.org", portalOrigin: PORTAL },
  cancel: { kind: "done", decision: "decline", status: "cancelled" },
};

test("an unknown community: join offer, what it asks, the request, and Request sent", async () => {
  const { steps, send } = script(VTC_JOIN);
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {}, now: () => NOW }));
  await screen.settle();
  assert.match(screen.text(), /Join members\.example\.org\?/);
  assert.match(screen.text(), /Nothing has been sent to it/);
  assert.equal(screen.container.querySelector('[data-testid="portal"]')!.textContent, PORTAL);
  await screen.click(screen.container.querySelector('[data-testid="join-manifest"]')!);
  assert.deepEqual(steps[1], { step: "join-manifest" });

  assert.match(screen.text(), /Ask to join members\.example\.org/);
  assert.equal(screen.container.querySelector('[data-testid="display-name"]')!.textContent, "Example Community");
  assert.match(screen.text(), /not checked/);
  assert.match(screen.text(), /An administrator reviews each request/);
  assert.match(screen.text(), /Also used at Other Community/);
  const submit = screen.container.querySelector<HTMLButtonElement>('[data-testid="join-submit"]')!;
  assert.equal(submit.disabled, true, "no identity chosen, required field empty");
  const radios = screen.container.querySelectorAll<HTMLInputElement>('input[name="applicant"]');
  await screen.click(radios[1]!);
  assert.equal(submit.disabled, true, "the required field is still empty");
  await screen.type(screen.container.querySelector('[data-testid="attribute-name.display"]')!, " Ada ");
  assert.equal(submit.disabled, false);
  const consent = screen.container.querySelector<HTMLInputElement>('[data-testid="registry-consent"]')!;
  assert.equal(consent.checked, false, "not listed unless the person says so");
  await screen.click(submit);
  assert.deepEqual(steps[2], {
    step: "join-submit",
    did: WORK,
    attributes: [{ type: "name.display", value: "Ada" }],
    registryConsent: false,
  });
  assert.match(screen.text(), /Request sent/);
  assert.match(screen.text(), /You can sign in once members\.example\.org approves it/);
  assert.equal(steps.length, 3, "nothing else is sent");
  await screen.unmount();
});

test("what the directory will show is on the join screen, as text, before the request is sent", async () => {
  const { steps, send } = script({
    ...VTC_JOIN,
    "join-manifest": {
      ...(VTC_JOIN["join-manifest"] as Extract<SignInStepResult, { kind: "join-apply" }>),
      directory: {
        lines: ["Your Name will be seen by the community's other members.", "Your <b>card</b> is never published outside the community."],
        statementDigest: "zQmStatement",
      },
    },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="join-manifest"]')!);
  const section = screen.container.querySelector('[data-testid="directory-disclosure"]')!;
  assert.match(section.textContent!, /What the directory will show about you/);
  assert.equal(section.querySelectorAll("li").length, 2);
  assert.equal(section.querySelector("b"), null, "community text is never markup");
  assert.match(section.textContent!, /Your <b>card<\/b> is never published/);
  assert.equal(steps.length, 2, "reading it sends nothing");
  await screen.unmount();
});

test("a community stating no directory shows no directory section", async () => {
  const { send } = script(VTC_JOIN);
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="join-manifest"]')!);
  assert.equal(screen.container.querySelector('[data-testid="directory-disclosure"]'), null);
  await screen.unmount();
});

test("Not now on the community offer cancels and closes", async () => {
  const { steps, send } = script(VTC_JOIN);
  let closed = 0;
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => void closed++ }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="decline"]')!);
  await screen.settle();
  assert.deepEqual(steps.map((s) => s.step), ["prepare", "cancel"]);
  assert.equal(closed, 1);
  await screen.unmount();
});

test("a community asking for what the wallet can't send says what, and only closes", async () => {
  const { send } = script({
    ...VTC_JOIN,
    "join-manifest": {
      kind: "join-elsewhere",
      host: "members.example.org",
      portalOrigin: PORTAL,
      reason: "needs-more",
      needs: ["an invitation from the community", "Hold a member credential"],
    },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="join-manifest"]')!);
  assert.match(screen.text(), /members\.example\.org needs more than your wallet can send/);
  assert.match(screen.container.querySelector('[data-testid="join-needs"]')!.textContent!, /an invitation from the community.*Hold a member credential/);
  assert.ok(screen.container.querySelector('[data-testid="close"]'));
  assert.equal(screen.container.querySelector('[data-testid="join-submit"]'), null);
  await screen.unmount();
});

test("a join request the community refused shows its message plainly", async () => {
  const { send } = script({
    ...VTC_JOIN,
    "join-manifest": { ...(VTC_JOIN["join-manifest"] as Extract<SignInStepResult, { kind: "join-apply" }>), attributes: [] },
    "join-submit": {
      kind: "failed",
      code: "vtc/join-requests/submit:notAccepting",
      message: "members.example.org isn't accepting new members right now.",
      stage: "join-submit",
      party: "community",
    },
  });
  const screen = await render(h(SignInView, { flowId: "f", send, close: () => {} }));
  await screen.settle();
  await screen.click(screen.container.querySelector('[data-testid="join-manifest"]')!);
  await screen.click(screen.container.querySelectorAll<HTMLInputElement>('input[name="applicant"]')[0]!);
  await screen.click(screen.container.querySelector('[data-testid="join-submit"]')!);
  assert.match(screen.text(), /isn't accepting new members right now/);
  assert.match(screen.text(), /sending the join request to the community/);
  await screen.unmount();
});

test("Approved closes the window by itself; Declined waits for Close", async () => {
  const { send } = script(ENROLLED);
  let closed = 0;
  const screen = await render(
    h(SignInView, {
      flowId: "f",
      send,
      uv: ENROLLED_UV,
      close: () => void closed++,
      approvedCloseMs: 0,
    }),
  );
  await screen.settle();
  await screen.click(
    screen.container.querySelector('[data-testid="continue"]')!,
  );
  await screen.type(
    screen.container.querySelector('[data-testid="number"]')!,
    "47",
  );
  await screen.click(screen.container.querySelector('[data-testid="prove"]')!);
  await screen.click(
    screen.container.querySelector('[data-testid="approve"]')!,
  );
  await screen.settle();
  assert.match(screen.text(), /Approved/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, 1);
  await screen.unmount();
});
