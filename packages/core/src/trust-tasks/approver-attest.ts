// A step-up approver's signed statement — `auth/step-up/approver/attest/0.1` —
// and the checks a wallet makes before it will sign one.
//
// The statement is the approver's whole contribution to a step-up: "for this
// subject, at this relying party, over this challenge, for this purpose, bound
// to this value". It is issued and proved by the approver's own `did:key`
// (`proofPurpose: authentication`, verified by the relying party over the
// object exactly as received) and carried embedded in the document it backs —
// `auth/step-up/approve-response/0.6` for `stepUp`, the enrolment document for
// `enrol`. It is never sent on its own.
//
// ## Why the wallet recomputes `boundTo`
//
// For `stepUp`, `boundTo` is the VTC's digest of the refused operation salted
// with the challenge ({@link vtcStepUpBoundTo}). A page hands the wallet the
// request and the operation; if the wallet signed the request's `boundTo` as
// given, a page could show the human one operation and have the approver
// authorise another. So the wallet recomputes the digest from the operation it
// is about to *show*, and refuses unless it equals the request's. What the
// human sees is then what the statement binds.
//
// ## The types are generated
//
// The attest/0.1 payload and the approve-request/0.4 request come from
// `@openvtc/trust-tasks`, never restated here. The checks below still read the
// request as untrusted input (a page hands it over), so they test each member
// rather than trust the type.

import type { Payload as ApproverAttestPayload } from "@openvtc/trust-tasks/auth/step-up/approver/attest/0.1/payload";
import { TYPE_URI as ATTEST_0_1 } from "@openvtc/trust-tasks/auth/step-up/approver/attest/0.1/payload";
import type { Payload as StepUpApproverRequest } from "@openvtc/trust-tasks/auth/step-up/approve-request/0.4/payload";
import { TYPE_URI as APPROVE_RESPONSE_0_6 } from "@openvtc/trust-tasks/auth/step-up/approve-response/0.6/payload";
import type { SigningIdentity } from "../siop/self-issued.js";
import { vtcStepUpBoundTo } from "./domain-digest.js";
import { signTrustTask, type TrustTaskEnvelope } from "./sign.js";

/** `auth/step-up/approver/attest/0.1`. */
export const APPROVER_ATTEST_TYPE = ATTEST_0_1;

/** `auth/step-up/approve-response/0.6` — the version that carries
 *  `approverSigned` evidence. */
export const APPROVE_RESPONSE_0_6_TYPE = APPROVE_RESPONSE_0_6;

/** attest/0.1's payload, from the generated bindings. */
export type { ApproverAttestPayload };

/** The inline `auth/step-up/approve-request/0.4` payload a VTC refuses a gated
 *  operation with, from the generated bindings. */
export type { StepUpApproverRequest };

/** The refused document an approver is asked to step up for. */
export interface StepUpOperation {
  type: string;
  payload: unknown;
}

/** Stable codes for an approver refusal (R3.7). */
export const APPROVER_REFUSAL = {
  malformed: "step-up-approver/malformed-request",
  notOffered: "step-up-approver/not-offered",
  boundToMismatch: "step-up-approver/bound-to-mismatch",
  notApproverSigned: "step-up-approver/approver-signed-not-accepted",
  subjectIsApprover: "step-up-approver/subject-is-approver",
} as const;

export type ApproverRefusalCode = (typeof APPROVER_REFUSAL)[keyof typeof APPROVER_REFUSAL];

export class ApproverRefusalError extends Error {
  readonly code: ApproverRefusalCode;
  constructor(code: ApproverRefusalCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ApproverRefusalError";
  }
}

const isDid = (v: unknown, max = 2048): v is string =>
  typeof v === "string" && v.startsWith("did:") && v.length >= 5 && v.length <= max;

const isChallenge = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 16 && v.length <= 512;

const isBoundTo = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 256;

/** The attest/0.1 members, checked against the specification's bounds. Throws
 *  `malformed` on anything a relying party would refuse as `payload schema`. */
export function checkAttestPayload(p: ApproverAttestPayload): ApproverAttestPayload {
  const bad = (what: string): never => {
    throw new ApproverRefusalError(APPROVER_REFUSAL.malformed, `approver statement: ${what}`);
  };
  if (p.purpose !== "stepUp" && p.purpose !== "decision" && p.purpose !== "enrol") {
    bad("purpose must be stepUp, decision or enrol");
  }
  if (!isDid(p.subject)) bad("subject must be a DID");
  if (!isDid(p.audience)) bad("audience must be a DID");
  if (!isChallenge(p.challenge)) bad("challenge must be 16–512 characters");
  if (!isBoundTo(p.boundTo)) bad("boundTo must be 1–256 characters");
  return {
    purpose: p.purpose,
    subject: p.subject,
    audience: p.audience,
    challenge: p.challenge,
    boundTo: p.boundTo,
  };
}

/**
 * Every check an approver makes on a step-up before showing it to a human,
 * and again immediately before signing. Returns the attest payload it would
 * sign; throws {@link ApproverRefusalError} otherwise.
 *
 * - the request is a well-formed approve-request 0.4 bound to one operation
 *   (`boundTo` present) that `accepts` `approverSigned`;
 * - `approverDid` — the wallet's approver for `audience`, never one the caller
 *   names — is among the request's `approvers`;
 * - the approver is not the subject (attest/0.1: issuer MUST differ);
 * - `boundTo` recomputed from `operation` and the request's challenge equals
 *   the request's.
 */
export async function checkStepUpApproval(args: {
  request: unknown;
  operation: unknown;
  audience: string;
  approverDid: string;
}): Promise<ApproverAttestPayload> {
  const { request, operation, audience, approverDid } = args;
  const bad = (what: string): never => {
    throw new ApproverRefusalError(APPROVER_REFUSAL.malformed, `step-up request: ${what}`);
  };
  if (!request || typeof request !== "object" || Array.isArray(request)) bad("not an object");
  const r = request as StepUpApproverRequest;
  if (!isDid(r.subject)) bad("subject must be a DID");
  if (!isChallenge(r.challenge)) bad("challenge must be 16–512 characters");
  if (typeof r.reason !== "string") bad("reason must be a string");
  if (!isBoundTo(r.boundTo)) bad("boundTo is absent — it is not bound to one operation");
  if (!isDid(audience)) bad("audience must be a DID");
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    bad("operation must be {type, payload}");
  }
  const op = operation as StepUpOperation;
  if (typeof op.type !== "string" || op.type === "") bad("operation.type must be a type URI");
  if (!("payload" in op) || op.payload === undefined) bad("operation.payload is absent");

  if (!Array.isArray(r.accepts) || !r.accepts.includes("approverSigned")) {
    throw new ApproverRefusalError(
      APPROVER_REFUSAL.notApproverSigned,
      "this step-up does not accept an approver's statement",
    );
  }
  const approvers: readonly string[] = Array.isArray(r.approvers) ? r.approvers : [];
  if (!approvers.includes(approverDid)) {
    throw new ApproverRefusalError(
      APPROVER_REFUSAL.notOffered,
      `this wallet's approver for ${audience} (${approverDid}) is not one the community ` +
        "has bound to this subject; enrol it first",
    );
  }
  if (approverDid === r.subject) {
    throw new ApproverRefusalError(
      APPROVER_REFUSAL.subjectIsApprover,
      "the approver cannot be the subject it approves for",
    );
  }
  const recomputed = await vtcStepUpBoundTo(op.type, op.payload, r.challenge);
  if (recomputed !== r.boundTo) {
    throw new ApproverRefusalError(
      APPROVER_REFUSAL.boundToMismatch,
      "the step-up's boundTo is not the digest of the operation shown; refusing to sign",
    );
  }
  return checkAttestPayload({
    purpose: "stepUp",
    subject: r.subject,
    audience,
    challenge: r.challenge,
    boundTo: r.boundTo as string,
  });
}

/**
 * Build and sign an attest/0.1 statement as `signing` (the approver).
 *
 * `issuer` is the approver, `recipient` and `payload.audience` the relying
 * party, `id` a fresh `urn:uuid`, `issuedAt` now, and the proof an
 * `eddsa-jcs-2022` proof for `authentication` whose `verificationMethod` is
 * the approver's `did:key:…#<multibase>`.
 */
export async function signApproverStatement(
  payload: ApproverAttestPayload,
  signing: SigningIdentity,
  now: Date = new Date(),
): Promise<TrustTaskEnvelope> {
  const p = checkAttestPayload(payload);
  if (signing.did === p.subject) {
    throw new ApproverRefusalError(
      APPROVER_REFUSAL.subjectIsApprover,
      "the approver cannot be the subject it attests for",
    );
  }
  const doc: TrustTaskEnvelope = {
    id: `urn:uuid:${globalThis.crypto.randomUUID()}`,
    type: APPROVER_ATTEST_TYPE,
    issuer: signing.did,
    recipient: p.audience,
    issuedAt: now.toISOString(),
    payload: { ...p },
  };
  return signTrustTask({ envelope: doc, signing, proofPurpose: "authentication" });
}
