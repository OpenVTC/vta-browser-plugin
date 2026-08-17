/// <reference types="chrome" />

// Delegated Trust-Task Execution, drawn.
//
// Follows `design-docs/trust-task-delegation-architecture.md` — the roles
// table, the flow diagram, and the invariant. Where the doc and a simpler
// story disagree, the doc wins: this describes what the VTA actually enforces,
// and a diagram that flattered the design would be worse than none.
//
// Two steps carry the whole argument and are emphasised accordingly:
//
//   - the agent works out the real effects itself (steps 5–7 in the doc). The
//     relying party proposes; it never describes what will happen, because a
//     malicious or XSS'd page would describe something else.
//   - the agent re-checks policy and device enrolment *after* approval, at the
//     moment of execution (step 12 — "the part everyone forgets"). Revoking a
//     device stops approvals already in flight from it.

import {
  FlowDiagram,
  type FlowBenefit,
  type FlowLane,
  type FlowStep,
} from "./flow-diagram.js";

const LANES: FlowLane[] = [
  { id: "site", label: "A site" },
  { id: "wallet", label: "This wallet" },
  { id: "agent", label: "Your agent" },
  { id: "approver", label: "Your approver" },
];

const STEPS: FlowStep[] = [
  {
    n: 1,
    from: "site",
    to: "wallet",
    text: "A site asks for something to be done",
    detail:
      "The relying party proposes a task type and a payload — nothing else. It is treated as untrusted: it may be malicious or XSS'd, and it never supplies anything a human reads as the basis of a decision.",
  },
  {
    n: 2,
    from: "wallet",
    to: "agent",
    text: "Your wallet passes it on, and says where it came from",
    detail:
      "task/propose, carrying this device's id. The origin is taken from the browser's own view of the sender, not from anything the page put in the message body.",
  },
  {
    n: 3,
    from: "agent",
    to: "agent",
    self: true,
    text: "Your agent works out what would actually change",
    detail:
      "It validates the request, checks policy, loads the current state, and dry-runs the task to produce the real list of effects. Then it pins that state and takes a digest of the exact payload. The site is never allowed to do this: only the code about to run knows what it will do.",
    emphasis: true,
  },
  {
    n: 4,
    from: "agent",
    to: "site",
    text: "It answers straight away: not yet, this needs approval",
    detail:
      "A consentRequired outcome, relayed back through your wallet. The request does not hang waiting for a human — the site gets an answer immediately and shows a match code, a short code derived from the payload digest.",
  },
  {
    n: 5,
    from: "agent",
    to: "approver",
    text: "At the same time, it asks your approver to approve",
    detail:
      "Concurrent with step 4, not after it: the wallet fires the approval request alongside answering the site, so a slow human never delays the site's reply. Signed by your agent, carrying the effects, the payload digest, the origin and a single-use challenge. It reaches your approver in this browser directly, or on another device through the approver's mediator inbox.",
  },
  {
    n: 6,
    from: "approver",
    to: "approver",
    self: true,
    text: "You check the code matches, and approve",
    detail:
      "Your approver renders the agent's description — not the site's — and shows the same match code the site is showing. Comparing them is how you confirm the thing you are approving is the thing that was asked for. Your authenticator then releases the signing key for this one decision.",
    emphasis: true,
  },
  {
    n: 7,
    from: "approver",
    to: "agent",
    text: "Your approval goes back, signed",
    detail:
      "A consent decision carrying the same challenge and the same payload digest, signed by the approver's key. Your agent replies accepted or refused — a refusal means a human agreed to something that then did not happen, which the wallet logs rather than silently dropping.",
  },
  {
    n: 8,
    from: "site",
    to: "agent",
    text: "The site asks again — this time the approval is used up",
    detail:
      "The re-submit consumes the single-use grant. It travels the same road as the first request, through your wallet, which stamps the attested origin again. This is why the first call could return immediately: approval is a separate errand, not a held-open request, so it can take minutes or happen on another device without anything hanging.",
  },
  {
    n: 9,
    from: "agent",
    to: "site",
    text: "Your agent re-checks everything, does it, and answers",
    detail:
      "It re-verifies the digest and pinned state, then re-evaluates policy and device enrolment before executing — re-checking at the moment of execution is what makes revoking a device stop approvals already in flight. The result is relayed back through your wallet to the page.",
    emphasis: true,
  },
];

const BENEFITS: FlowBenefit[] = [
  {
    title: "The site cannot authorise anything",
    body: "It proposes; your agent decides. A compromised page can ask for something outrageous and get no further than the approval prompt you are about to read.",
  },
  {
    title: "You approve what actually happens",
    body: "The description you read is written by the thing about to run the task, not by whoever asked for it. Your approval is bound to that exact payload by a digest, so nothing can be swapped afterwards.",
  },
  {
    title: "Asking and approving are different identities",
    body: "The identity that requests cannot approve. A hijacked browser session can propose a destructive task and still not sign it off.",
  },
  {
    title: "Approval can happen somewhere else",
    body: "The device that proposes need not be the device that approves — a request made in this browser can be approved on your phone.",
  },
  {
    title: "Nothing hangs waiting for you",
    body: "The site is told immediately that approval is needed, rather than being left on a held-open request. That is what lets an approval take minutes, or happen on a different device, without the page timing out.",
  },
  {
    title: "Revoking a device works immediately",
    body: "Policy and enrolment are re-checked at the moment of execution, not just when the request was made, so approvals already in flight from a revoked device stop working.",
  },
];

export function DtteFlow() {
  return (
    <FlowDiagram
      title="How approvals work"
      teaser="When a site asks your agent to actually change something — publish a record, rotate a key — this is what stands between the request and it happening."
      summary="Nine steps, in two rounds: the site is told approval is needed, then asks again once you have given it. Select a step for the technical detail."
      lanes={LANES}
      steps={STEPS}
      benefitsTitle="What this protects you from"
      benefits={BENEFITS}
    />
  );
}
