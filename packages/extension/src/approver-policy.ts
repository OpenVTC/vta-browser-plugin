// What a page may do with the wallet's step-up approver, decided without
// `chrome.*` so it is testable.
//
// The approver methods (`approverIdentity`, `approveStepUp`, `attestApprover`)
// are reachable by any page the wallet is active on. Two rules bound them:
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

import { jcsCanonicalize } from "@openvtc/pnm-core";

import type { PageRpPin } from "./page-task-policy.js";

export const APPROVE_RESPONSE_0_6 =
  "https://trusttasks.org/spec/auth/step-up/approve-response/0.6";

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
  /** `stepUp`: approve one operation. `enrol`: prove possession at enrolment.
   *  `setup`: create the wallet's approver sealing key (no signature). */
  kind: "stepUp" | "enrol" | "setup";
  origin: string;
  audience: string;
  approverDid?: string;
  subject?: string;
  /** stepUp only: the request's `reason`. Page-supplied and unverified. */
  reason?: string;
  operation?: { type: string; payload: unknown };
  challenge?: string;
  boundTo?: string;
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
  ].join("\0");
}
