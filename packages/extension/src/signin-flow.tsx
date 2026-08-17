/// <reference types="chrome" />

// "What actually happens when I sign in?" — the SIOPv2 flow, drawn.
//
// Written for someone with no idea what a DID is. The test applied to every
// label: could a person who has only ever used passwords read this line and
// come away with a true belief? That rules out "authenticate", "assertion",
// "relying party" and "id_token" as *labels*, though the detail rows below
// name them, because someone troubleshooting needs the real words.
//
// The steps mirror the actual implementation, not the generic SIOPv2 spec:
// the challenge comes from the site, and the token is minted **by the agent**
// (`RUNTIME_LIST_DIDS` — "the personas the VTA can mint a SIOP id_token AS (it
// holds their signing keys)"), which is why the browser never holds the
// signing key. That is the whole security argument, so the diagram has to show
// the signature happening in the agent's lane rather than the wallet's.

import {
  FlowDiagram,
  type FlowBenefit,
  type FlowLane,
  type FlowStep,
} from "./flow-diagram.js";

// Step numbers live in a fixed gutter down the left edge, never beside their
// own arrow. Positioned per-arrow they collided with any label long enough to
// reach them — step 4's ran straight through its badge — and they jumped
// left and right down the page, which makes a sequence hard to scan.
const GUTTER_X = 40;
const LANE_0 = 108;
const LANE_GAP = 250;
const CANVAS_W = LANE_0 + LANE_GAP * 3 + 52;

const LANES: FlowLane[] = [
  { id: "you", label: "You" },
  { id: "wallet", label: "This wallet" },
  { id: "agent", label: "Your agent" },
  { id: "site", label: "The website" },
];

const STEPS: FlowStep[] = [
  {
    n: 1,
    from: "you",
    to: "site",
    text: "You click “Sign in”",
    detail: "The page calls window.vtaWallet.login({ rpDid, baseUrl }).",
  },
  {
    n: 2,
    from: "site",
    to: "wallet",
    text: "The site asks your wallet to prove who you are",
    detail:
      "It sends its own DID as the audience, plus a one-time challenge from its /auth/challenge endpoint.",
  },
  {
    n: 3,
    from: "wallet",
    to: "you",
    text: "Your wallet asks you first",
    detail:
      "A consent window names the site and the identity it is asking for. Nothing proceeds without your approval — a page cannot sign you in quietly.",
    emphasis: true,
  },
  {
    n: 4,
    from: "wallet",
    to: "agent",
    text: "Your wallet asks your agent to sign — as your identity for that site",
    detail:
      "The vault entry for the site names the identity to use (its principalDid). That is not your wallet's own address: each site gets its own identity. The agent holds the signing keys and the browser never does.",
  },
  {
    n: 5,
    from: "agent",
    to: "wallet",
    text: "Your agent signs it and sends it back",
    detail:
      "A SIOPv2 id_token signed by that site's identity, carrying the site's challenge so it cannot be replayed elsewhere.",
  },
  {
    n: 6,
    from: "wallet",
    to: "site",
    text: "Your wallet hands the pass to the site",
    detail: "Posted to the site's auth endpoint as a bearer token.",
  },
  {
    n: 7,
    from: "site",
    to: "site",
    self: true,
    text: "The site checks the signature by itself",
    detail:
      "It resolves your published DID document and verifies the signature against the key in it. It never contacts your agent — so nobody is told where you sign in.",
    emphasis: true,
  },
];

const BENEFITS: FlowBenefit[] = [
  {
    title: "No password exists",
    body: "There is nothing to reuse across sites, nothing to leak in a breach, and nothing a fake page can phish out of you.",
  },
  {
    title: "The site never holds a secret of yours",
    body: "It gets a one-time pass that only works there. If the site is breached tomorrow, there is nothing of yours in it to steal.",
  },
  {
    title: "Your keys stay with your agent",
    body: "The browser asks for a signature; it never holds the key that makes one. A compromised browser cannot walk off with your identity.",
  },
  {
    title: "A different identity for every site",
    // Stated as a capability, not a guarantee: nothing stops two login entries
    // naming the same identity, and the Network view flags it when they do.
    // Promising unlinkability the setup may not have is worse than silence,
    // because it is exactly the sort of claim someone would rely on.
    body: "A site sees an identity you use only there — never your wallet's own address — so sites cannot work out they are dealing with the same person. Reuse the same identity across two sites and they can; the Network view says which ones do.",
  },
  {
    title: "Nobody watches where you go",
    body: "The site verifies you from your public record, without calling your agent — so no service accumulates a log of every place you sign in.",
  },
  {
    title: "You approve each sign-in",
    body: "Every request names the site asking. Approval is a human step by design, not a setting that can be left on.",
  },
];


export function SignInFlow() {
  return (
    <FlowDiagram
      title="How signing in works"
      teaser="A one-page walkthrough of what happens between clicking “Sign in” and being let in — and why it is safer than a password."
      summary="Seven steps, every time. Select a step for the technical detail."
      lanes={LANES}
      steps={STEPS}
      benefitsTitle="Why this is better than a password"
      benefits={BENEFITS}
    />
  );
}
