// What a page may do with the wallet's step-up approver, decided without
// `chrome.*` so it is testable.
//
// The approver methods (`approverIdentity`, `approveStepUp`, `attestApprover`,
// `approveDecision`) are reachable by any page the wallet is active on. Three
// rules bound them:
//
// 1. **Only for the relying party the origin is pinned to.** Each community
//    has its own approver so that no two can correlate the user by it; a page
//    that could name any `audience` could read every community's approver DID
//    and undo that. And a statement addressed to a community the page was not
//    signed in to would be the approver vouching at a party the human never
//    chose from this page. The pin is login's (`origin-pin.ts`); nothing here
//    seeds one.
//
// 2. **The approve-response around a statement is signed only for the
//    statement just issued.** `pageSignRefusal` refuses every
//    `auth/step-up/approve-*` document a page asks to have signed, because an
//    approval is built by the wallet's own ceremony. approve-response 0.6 with
//    `approverSigned` evidence is that ceremony's second half: the console
//    wraps the statement `approveStepUp` returned and has the wallet sign it as
//    the subject. So it is signable exactly when it carries, unchanged, a
//    statement this wallet issued to this origin moments ago, for the same
//    subject, challenge and relying party — once, and never otherwise.
//
// 3. **A `decision` statement comes only from `approveDecision`, and the
//    decision around it is signed only for that statement.** `attestApprover`
//    is enrolment only (`attestApproverPurposeRefusal`): a decision statement
//    must be issued by the path that shows the action and recomputes its
//    digest. The `task-consent/decision/0.2` that carries it is then signable
//    without a second prompt exactly when it carries, unchanged, the statement
//    just issued to this origin, with the same challenge, digest, decision
//    (approve/deny), reason and action id the human was shown, signed as the
//    statement's subject — once (`decisionResponseRefusal`).

import { jcsCanonicalize } from "@openvtc/pnm-core";

import type { PageRpPin } from "./page-task-policy.js";

export const APPROVE_RESPONSE_0_6 =
  "https://trusttasks.org/spec/auth/step-up/approve-response/0.6";

/** The decision version that carries `approverSigned` evidence. */
export const TASK_CONSENT_DECISION_0_2 =
  "https://trusttasks.org/spec/task-consent/decision/0.2";

/** How long an issued statement may be wrapped into an approve-response —
 *  the VTC's own mark lifetime (`bound_step_up::MARK_TTL_SECS`). */
export const ISSUED_STATEMENT_TTL_MS = 300_000;

/** A statement `approveStepUp` returned, remembered for the one
 *  approve-response that may carry it. */
export interface IssuedApproverStatement {
  statement: Record<string, unknown>;
  origin: string;
  audience: string;
  subject: string;
  challenge: string;
  expiresAt: number;
  /** Which document may carry it: an approve-response (`stepUp`, the default
   *  for records written before decisions existed) or a decision. */
  purpose?: "stepUp" | "decision";
  /** decision only: what the human was shown and approved. */
  payloadDigest?: string;
  decision?: "approve" | "deny";
  reason?: string;
  actionId?: string;
}

/**
 * Why the page at `origin` may not use the step-up approver for `audience`, or
 * `null` when it may. `pin` is `readOriginPin(origin)`.
 */
export function pageApproverAudienceRefusal(
  origin: string,
  pin: PageRpPin | undefined,
  audience: unknown,
): string | null {
  if (typeof audience !== "string" || !audience.startsWith("did:")) {
    return "A step-up approver call needs the relying party's DID as audience.";
  }
  if (!pin) {
    return (
      `${origin} has no relying party pinned, so the wallet will not use a step-up approver ` +
      `for it. Sign in from this site first: the login prompt is where the site's relying ` +
      `party is shown and confirmed, and it pins that pairing.`
    );
  }
  if (audience !== pin.rpDid) {
    return (
      `The approver call names the relying party ${audience}, but ${origin} is pinned to ` +
      `${pin.rpDid}. A page can only use the approver it holds for the relying party it was ` +
      `signed in to.`
    );
  }
  return null;
}

/** The statement id an approve-response 0.6 carries, or `null`. */
export function approverResponseStatementId(envelope: unknown): string | null {
  const ev = (envelope as { payload?: { evidence?: { statement?: { id?: unknown } } } })?.payload
    ?.evidence;
  const id = ev?.statement?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

const RESPONSE_MEMBERS = new Set(["subject", "challenge", "decision", "evidence", "sessionId"]);

/**
 * Why `envelope` — an approve-response 0.6 the page at `origin` wants signed as
 * `asDid` — may not be signed, or `null` when it may. `issued` is the statement
 * this wallet issued under the id the envelope carries, if any.
 */
export function approverResponseRefusal(
  envelope: unknown,
  issued: IssuedApproverStatement | undefined,
  origin: string,
  asDid: string | undefined,
  now: number = Date.now(),
): string | null {
  const refuse = (why: string) =>
    `${APPROVE_RESPONSE_0_6} cannot be signed for this page: ${why}.`;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return refuse("it is not a Trust Task document");
  }
  const doc = envelope as {
    type?: unknown;
    issuer?: unknown;
    recipient?: unknown;
    payload?: unknown;
    proof?: unknown;
  };
  if (doc.type !== APPROVE_RESPONSE_0_6) return refuse("wrong type");
  if (doc.proof !== undefined) return refuse("it is already signed");
  const p = doc.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return refuse("it has no payload");
  for (const k of Object.keys(p)) {
    if (!RESPONSE_MEMBERS.has(k)) return refuse(`it carries an unexpected member ${k}`);
  }
  if (p.decision !== "approved") return refuse("only an approval is built this way");
  const ev = p.evidence as Record<string, unknown> | undefined;
  if (!ev || typeof ev !== "object" || ev.kind !== "approverSigned") {
    return refuse("its evidence is not an approver's statement");
  }
  for (const k of Object.keys(ev)) {
    if (k !== "kind" && k !== "statement") return refuse(`its evidence carries ${k}`);
  }
  if (!issued) {
    return refuse("it carries no statement this wallet's approver issued to it");
  }
  if ((issued.purpose ?? "stepUp") !== "stepUp") {
    return refuse("the statement it carries was issued for a decision, not a step-up");
  }
  if (now > issued.expiresAt) return refuse("the approver's statement has lapsed");
  if (issued.origin !== origin) return refuse("the statement was issued to another page");
  if (doc.recipient !== issued.audience) {
    return refuse("it is not addressed to the relying party the statement is for");
  }
  if (p.subject !== issued.subject || p.challenge !== issued.challenge) {
    return refuse("its subject or challenge differs from the statement's");
  }
  // Signed as the subject — the outer proof must be the subject's own DID
  // (approve-response 0.6, consumer step 1a), never the approver's.
  if (asDid !== issued.subject) return refuse("it must be signed as its subject");
  if (doc.issuer !== undefined && doc.issuer !== issued.subject) {
    return refuse("its issuer is not its subject");
  }
  let same = false;
  try {
    same = jcsCanonicalize(ev.statement) === jcsCanonicalize(issued.statement);
  } catch {
    same = false;
  }
  if (!same) return refuse("the statement it carries is not the one this wallet issued");
  return null;
}

/**
 * Why `attestApprover` may not sign a statement for `purpose`, or `null` when
 * it may. Only enrolment: a `decision` statement must come from
 * `approveDecision`, which shows the action and recomputes its digest, and a
 * `stepUp` one from `approveStepUp`.
 */
export function attestApproverPurposeRefusal(purpose: unknown): string | null {
  if (purpose === "enrol") return null;
  if (purpose === "decision") {
    return "attestApprover does not sign decision statements; use approveDecision, which shows the action and checks its payloadDigest.";
  }
  if (purpose === "stepUp") {
    return "attestApprover does not sign step-up statements; use approveStepUp.";
  }
  return "attestApprover signs enrolment statements only (purpose: enrol)";
}

/** The statement id a decision 0.2 carries as `approverSigned` evidence, or
 *  `null` when it carries none. */
export function decisionStatementId(envelope: unknown): string | null {
  const ev = (envelope as { payload?: { evidence?: { kind?: unknown; statement?: { id?: unknown } } } })
    ?.payload?.evidence;
  if (ev?.kind !== "approverSigned") return null;
  const id = ev.statement?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Whether `envelope` is a decision 0.2 claiming `approverSigned` evidence —
 *  the shape `decisionResponseRefusal` decides, whatever else it carries. */
export function isApproverSignedDecision(envelope: unknown): boolean {
  const doc = envelope as { type?: unknown; payload?: { evidence?: { kind?: unknown } } } | null;
  return (
    doc?.type === TASK_CONSENT_DECISION_0_2 && doc.payload?.evidence?.kind === "approverSigned"
  );
}

const DECISION_MEMBERS = new Set([
  "challenge",
  "payloadDigest",
  "decision",
  "reason",
  "actionId",
  "evidence",
]);

/**
 * Why `envelope` — a `task-consent/decision/0.2` carrying `approverSigned`
 * evidence that the page at `origin` wants signed as `asDid` — may not be
 * signed without a second prompt, or `null` when it may. `issued` is the
 * statement this wallet issued under the id the envelope carries, if any.
 *
 * It may when it carries, unchanged, a statement `approveDecision` issued to
 * this origin within its lifetime, addressed to the same relying party, with
 * the challenge, digest, decision, reason and action id the human was shown,
 * signed as the statement's subject. A decision with `approverSigned` evidence
 * that fails this is refused outright — never offered the generic prompt — so
 * a page cannot attach a statement the wallet did not issue for it.
 */
export function decisionResponseRefusal(
  envelope: unknown,
  issued: IssuedApproverStatement | undefined,
  origin: string,
  asDid: string | undefined,
  now: number = Date.now(),
): string | null {
  const refuse = (why: string) =>
    `${TASK_CONSENT_DECISION_0_2} with an approver's statement cannot be signed for this page: ${why}.`;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return refuse("it is not a Trust Task document");
  }
  const doc = envelope as {
    type?: unknown;
    issuer?: unknown;
    recipient?: unknown;
    payload?: unknown;
    proof?: unknown;
  };
  if (doc.type !== TASK_CONSENT_DECISION_0_2) return refuse("wrong type");
  if (doc.proof !== undefined) return refuse("it is already signed");
  const p = doc.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return refuse("it has no payload");
  for (const k of Object.keys(p)) {
    if (!DECISION_MEMBERS.has(k)) return refuse(`it carries an unexpected member ${k}`);
  }
  const ev = p.evidence as Record<string, unknown> | undefined;
  if (!ev || typeof ev !== "object" || ev.kind !== "approverSigned") {
    return refuse("its evidence is not an approver's statement");
  }
  for (const k of Object.keys(ev)) {
    if (k !== "kind" && k !== "statement") return refuse(`its evidence carries ${k}`);
  }
  if (!issued) return refuse("it carries no statement this wallet's approver issued to it");
  if (issued.purpose !== "decision") {
    return refuse("the statement it carries was not issued for a decision");
  }
  if (now > issued.expiresAt) return refuse("the approver's statement has lapsed");
  if (issued.origin !== origin) return refuse("the statement was issued to another page");
  if (doc.recipient !== issued.audience) {
    return refuse("it is not addressed to the relying party the statement is for");
  }
  if (p.challenge !== issued.challenge || p.payloadDigest !== issued.payloadDigest) {
    return refuse("its challenge or payloadDigest differs from the statement's");
  }
  if (p.decision !== issued.decision) {
    return refuse(`its decision is not the ${String(issued.decision)} that was approved`);
  }
  if ((p.reason ?? undefined) !== (issued.reason ?? undefined)) {
    return refuse("its reason is not the one shown when it was approved");
  }
  if ((p.actionId ?? undefined) !== (issued.actionId ?? undefined)) {
    return refuse("its actionId is not the action that was shown");
  }
  // The decision's proof must be the subject's own (attest/0.1 `decision`: the
  // statement's subject is the DID that made the decision's proof).
  if (asDid !== issued.subject) return refuse("it must be signed as the statement's subject");
  if (doc.issuer !== undefined && doc.issuer !== issued.subject) {
    return refuse("its issuer is not the statement's subject");
  }
  let same = false;
  try {
    same = jcsCanonicalize(ev.statement) === jcsCanonicalize(issued.statement);
  } catch {
    same = false;
  }
  if (!same) return refuse("the statement it carries is not the one this wallet issued");
  return null;
}

/**
 * The VTC's rendering of an action (`summary.title` / `summary.effect`) as
 * plain text, or `undefined`. Page-supplied and unverified: it is shown
 * labelled so, beside the payload the digest was recomputed from.
 */
export function decisionSummaryText(summary: unknown): string | undefined {
  if (typeof summary === "string") return summary.slice(0, 500) || undefined;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return undefined;
  const { title, effect } = summary as { title?: unknown; effect?: unknown };
  const parts = [title, effect].filter((v): v is string => typeof v === "string" && v !== "");
  return parts.length ? parts.join(" — ").slice(0, 500) : undefined;
}

// Characters that change how text *reads* without being visible: bidi
// overrides and isolates, zero-width joiners and spaces, the BOM.
// `JSON.stringify` escapes control characters but passes these through, so a
// payload value could render as something other than what is signed over.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * The operation's payload as the human is shown it: indented JSON, every
 * member present, with the characters that could disguise a value spelled out
 * as `\uXXXX` escapes. What is shown is what the digest covers — the payload is
 * the one the `boundTo` was recomputed from.
 */
export function renderOperationPayload(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    text = String(payload);
  }
  return text.replace(
    INVISIBLE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

/** `chrome.storage.session` key prefix of an approver prompt's request. */
export const APPROVER_CONSENT_PREFIX = "approver-consent:";

/** What the approver prompt is shown, stored for the popup by consent id. */
export interface ApproverConsentRequest {
  /** `stepUp`: approve one operation. `decision`: vouch for an administrator's
   *  decision on one VTC action. `enrol`: prove possession at enrolment.
   *  `setup`: create the wallet's approver sealing key (no signature). */
  kind: "stepUp" | "decision" | "enrol" | "setup";
  origin: string;
  audience: string;
  approverDid?: string;
  subject?: string;
  /** stepUp only: the request's `reason`. Page-supplied and unverified. */
  reason?: string;
  operation?: { type: string; payload: unknown };
  challenge?: string;
  boundTo?: string;
  /** decision only: approve or deny, as the decision will say. */
  decision?: "approve" | "deny";
  /** decision only: the VTC's summary of the action, unverified. */
  summary?: string;
  actionId?: string;
}

/** The string the gesture's WebAuthn challenge is derived from: the ceremony's
 *  own binding, so the assertion is for this prompt and no other. */
export function approverGestureBinding(req: ApproverConsentRequest): string {
  return [
    `vta-approver/${req.kind}`,
    req.audience,
    req.subject ?? "",
    req.challenge ?? "",
    req.boundTo ?? "",
    ...(req.kind === "decision" ? [req.decision ?? ""] : []),
  ].join("\0");
}
