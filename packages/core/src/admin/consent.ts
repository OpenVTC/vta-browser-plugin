// Messaging consent — the canonical `consent/*` Trust Tasks.
//
// Who is allowed to talk to an agent, on which platform, in which
// conversation. Not to be confused with `task-consent/*`, which is the
// human-approval flow for privileged *actions* — that one is inbound and lives
// in `inbound/`. This family answers a narrower question: may this counterparty
// reach me at all.
//
// A grant is identified by its subject — platform, conversation reference,
// conversation kind and agent, together — not by an id. Two of those four
// differing is a different subject, which is why every call here carries the
// whole thing rather than a handle.
//
// `consentRequest` is the counterparty's side of the exchange: it asks for
// consent and carries a challenge the approver's decision is bound to. Most
// consoles will use `consentList`, `consentDecision` and `consentRevoke`.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as CONSENT_LIST,
  RESPONSE_TYPE_URI as CONSENT_LIST_RESPONSE,
  type ConsentListPayload,
  type ConsentListResponsePayload,
  type ConsentGrant,
  type ConsentSubject,
} from "@openvtc/trust-tasks/consent/list/1.0/payload";
import {
  TYPE_URI as CONSENT_DECISION,
  RESPONSE_TYPE_URI as CONSENT_DECISION_RESPONSE,
  type ConsentDecisionPayload,
  type ConsentDecisionResponsePayload,
} from "@openvtc/trust-tasks/consent/decision/1.0/payload";
import {
  TYPE_URI as CONSENT_REVOKE,
  RESPONSE_TYPE_URI as CONSENT_REVOKE_RESPONSE,
  type ConsentRevokePayload,
  type ConsentRevokeResponsePayload,
} from "@openvtc/trust-tasks/consent/revoke/1.0/payload";
import {
  TYPE_URI as CONSENT_REQUEST,
  RESPONSE_TYPE_URI as CONSENT_REQUEST_RESPONSE,
  type ConsentRequestPayload,
  type ConsentRequestResponsePayload,
} from "@openvtc/trust-tasks/consent/request/1.0/payload";
import {
  TYPE_URI as APPROVER_LIST,
  RESPONSE_TYPE_URI as APPROVER_LIST_RESPONSE,
  type ConsentListApproversPayload,
  type ConsentListApproversResponsePayload,
  type ApproverBinding,
} from "@openvtc/trust-tasks/consent/approver-list/1.0/payload";
import {
  TYPE_URI as APPROVER_SET,
  RESPONSE_TYPE_URI as APPROVER_SET_RESPONSE,
  type ConsentSetApproverPayload,
  type ConsentSetApproverResponsePayload,
} from "@openvtc/trust-tasks/consent/approver-set/1.0/payload";

export type { ConsentGrant, ConsentSubject, ApproverBinding };

export interface ConsentCallerParams {
  holder: TaskParty;
  service: TaskParty;
}

export interface ConsentListParams extends ConsentCallerParams {
  agent?: string;
  platform?: string;
  /** Narrow to one conversation. All four members identify it together. */
  subject?: ConsentSubject;
  /** RFC 3339 — grants recorded since. */
  since?: string;
}

export interface ConsentListResult {
  grants: ConsentGrant[];
  cursor?: string;
}

/** List consent grants. A grant carries `effect: "allow" | "deny"` — a deny is
 *  a recorded decision, not an absence, and hiding it would make a blocked
 *  counterparty look merely unknown. */
export async function consentList(
  sender: TrustTaskSender,
  params: ConsentListParams,
): Promise<ConsentListResult> {
  const payload: ConsentListPayload = {
    ...(params.agent ? { agent: params.agent } : {}),
    ...(params.platform ? { platform: params.platform } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.since ? { since: params.since } : {}),
  };
  const envelope = buildTrustTask(CONSENT_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ConsentListResponsePayload>(envelope, {
    expectedResponseType: CONSENT_LIST_RESPONSE,
    operationLabel: "consent/list/1.0",
  });
  return { grants: res.grants ?? [], ...(res.cursor ? { cursor: res.cursor } : {}) };
}

export interface ConsentDecisionParams extends ConsentCallerParams {
  subject: ConsentSubject;
  effect: ConsentDecisionPayload["effect"];
  /** `receive` — they may send; `converse` — a two-way exchange. */
  scope?: ConsentDecisionPayload["scope"];
  /** The challenge from the matching `consent/request`, binding this decision
   *  to the request that prompted it. */
  challenge?: string;
  /** RFC 3339. Omit for a grant that does not expire. */
  expiresAt?: string;
}

/**
 * Record a decision.
 *
 * The response `status` is `recorded` or `rejected` — a rejected decision is
 * the agent refusing to record it (a stale challenge, say), which is not the
 * same as recording a `deny`. A UI that reports "blocked" on a `rejected`
 * would be telling the user the opposite of what happened.
 */
export async function consentDecision(
  sender: TrustTaskSender,
  params: ConsentDecisionParams,
): Promise<ConsentDecisionResponsePayload> {
  const payload: ConsentDecisionPayload = {
    subject: params.subject,
    effect: params.effect,
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.challenge ? { challenge: params.challenge } : {}),
    ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
  };
  const envelope = buildTrustTask(CONSENT_DECISION, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ConsentDecisionResponsePayload>(envelope, {
    expectedResponseType: CONSENT_DECISION_RESPONSE,
    operationLabel: "consent/decision/1.0",
  });
}

export interface ConsentRevokeParams extends ConsentCallerParams {
  subject: ConsentSubject;
  reason?: string;
}

/** Revoke a grant. Reports `notFound` for a subject with no grant — a
 *  successful answer, not an error. */
export async function consentRevoke(
  sender: TrustTaskSender,
  params: ConsentRevokeParams,
): Promise<ConsentRevokeResponsePayload> {
  const payload: ConsentRevokePayload = {
    subject: params.subject,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(CONSENT_REVOKE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ConsentRevokeResponsePayload>(envelope, {
    expectedResponseType: CONSENT_REVOKE_RESPONSE,
    operationLabel: "consent/revoke/1.0",
  });
}

export interface ConsentRequestParams extends ConsentCallerParams {
  subject: ConsentSubject;
  scope: ConsentRequestPayload["scope"];
  /** Bound into the decision that answers this. Required. */
  challenge: string;
  /** Text an approver may be shown. **Supplied by the party asking**, so it is
   *  a claim about itself: display it as such, never as the agent's own
   *  description of what is being agreed to. */
  displayHint?: string;
  /** Digest of the first message, so an approver can verify what arrived
   *  matches what was requested. */
  firstMessageDigest?: ConsentRequestPayload["firstMessageDigest"];
  contextHint?: string;
}

/** Ask for consent to message. The counterparty's half of the exchange. */
export async function consentRequest(
  sender: TrustTaskSender,
  params: ConsentRequestParams,
): Promise<ConsentRequestResponsePayload> {
  const payload: ConsentRequestPayload = {
    subject: params.subject,
    scope: params.scope,
    challenge: params.challenge,
    ...(params.displayHint ? { displayHint: params.displayHint } : {}),
    ...(params.firstMessageDigest
      ? { firstMessageDigest: params.firstMessageDigest }
      : {}),
    ...(params.contextHint ? { contextHint: params.contextHint } : {}),
  };
  const envelope = buildTrustTask(CONSENT_REQUEST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ConsentRequestResponsePayload>(envelope, {
    expectedResponseType: CONSENT_REQUEST_RESPONSE,
    operationLabel: "consent/request/1.0",
  });
}

export interface ApproverListParams extends ConsentCallerParams {
  platform?: string;
  context?: string;
}

/** List the approvers bound to platforms and contexts — who gets asked. */
export async function consentApproverList(
  sender: TrustTaskSender,
  params: ApproverListParams,
): Promise<ApproverBinding[]> {
  const payload: ConsentListApproversPayload = {
    ...(params.platform ? { platform: params.platform } : {}),
    ...(params.context ? { context: params.context } : {}),
  };
  const envelope = buildTrustTask(APPROVER_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<ConsentListApproversResponsePayload>(envelope, {
    expectedResponseType: APPROVER_LIST_RESPONSE,
    operationLabel: "consent/approver-list/1.0",
  });
  return res.approvers ?? [];
}

export interface ApproverSetParams extends ConsentCallerParams {
  platform: string;
  context: string;
  /** DID of the party that will be asked to decide. */
  approver: string;
  /** How the request reaches them. */
  route?: ConsentSetApproverPayload["route"];
  routeHint?: string;
}

/**
 * Bind an approver to a platform and context.
 *
 * This decides *who is asked* when consent is needed there, so it is as
 * privileged as any grant: pointing it at the wrong DID hands that DID the
 * decision. Changing it is worth showing an operator explicitly rather than
 * folding into a settings save.
 */
export async function consentApproverSet(
  sender: TrustTaskSender,
  params: ApproverSetParams,
): Promise<ConsentSetApproverResponsePayload> {
  const payload: ConsentSetApproverPayload = {
    platform: params.platform,
    context: params.context,
    approver: params.approver,
    ...(params.route ? { route: params.route } : {}),
    ...(params.routeHint ? { routeHint: params.routeHint } : {}),
  };
  const envelope = buildTrustTask(APPROVER_SET, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<ConsentSetApproverResponsePayload>(envelope, {
    expectedResponseType: APPROVER_SET_RESPONSE,
    operationLabel: "consent/approver-set/1.0",
  });
}
