// Verifiable Trust Community — the member's side.
//
// Joining a community and being a member of one: submit an application, ask
// where it stands, receive the credential that says you belong, and leave.
//
// **This is deliberately eight tasks, not sixty.** `@openvtc/trust-tasks`
// ships bindings for the whole `vtc/*` surface — endorsements, invitations,
// the community's own website and registry, member administration — but that
// is the *community's* admin plane, implemented by a VTC rather than by an
// agent. `vta-sdk` declares only these eight, which are exactly the ones an
// agent speaks as a member. Wrapping the rest here would be building a VTC
// console inside a wallet library.
//
// Two of them are receipts a member *sends* (`submit-receipt`,
// `self-remove-receipt`) — the acknowledgement half of an exchange the
// community started. They are here because the member is the sender; a
// consumer that only ever applies and leaves will not need them.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as JR_MANIFEST,
  RESPONSE_TYPE_URI as JR_MANIFEST_RESPONSE,
  type VTCJoinRequestsManifestResponsePayload,
} from "@openvtc/trust-tasks/vtc/join-requests/manifest/0.1/payload";
import {
  TYPE_URI as JR_SUBMIT,
  RESPONSE_TYPE_URI as JR_SUBMIT_RESPONSE,
  type VTCJoinRequestsSubmitPayload,
  type VTCJoinRequestsSubmitResponsePayload,
  type Verdict,
  type VerdictEffect,
  type VerdictWith,
} from "@openvtc/trust-tasks/vtc/join-requests/submit/0.2/payload";
import {
  TYPE_URI as JR_STATUS,
  RESPONSE_TYPE_URI as JR_STATUS_RESPONSE,
  type VTCJoinRequestsStatusPayload,
  type VTCJoinRequestsStatusResponsePayload,
} from "@openvtc/trust-tasks/vtc/join-requests/status/0.1/payload";
import {
  TYPE_URI as JR_SUBMIT_RECEIPT,
  RESPONSE_TYPE_URI as JR_SUBMIT_RECEIPT_RESPONSE,
  type VTCJoinRequestsSubmitReceiptPayload,
  type VTCJoinRequestsSubmitReceiptResponsePayload,
} from "@openvtc/trust-tasks/vtc/join-requests/submit-receipt/0.1/payload";
import {
  TYPE_URI as MEMBERS_REQUEST_VMC,
  RESPONSE_TYPE_URI as MEMBERS_REQUEST_VMC_RESPONSE,
  type VTCMembersRequestVMCPayload,
  type VTCMembersRequestVMCResponsePayload,
} from "@openvtc/trust-tasks/vtc/members/request-vmc/0.1/payload";
import {
  TYPE_URI as MEMBERS_VMC,
  RESPONSE_TYPE_URI as MEMBERS_VMC_RESPONSE,
  type VTCMembersDeliverVMCPayload,
  type VTCMembersDeliverVMCReceiptPayload,
} from "@openvtc/trust-tasks/vtc/members/vmc/0.1/payload";
import {
  TYPE_URI as MEMBERS_SELF_REMOVE,
  RESPONSE_TYPE_URI as MEMBERS_SELF_REMOVE_RESPONSE,
  type VTCMembersSelfRemovePayload,
  type VTCMembersSelfRemoveResponsePayload,
} from "@openvtc/trust-tasks/vtc/members/self-remove/0.1/payload";
import {
  TYPE_URI as MEMBERS_SELF_REMOVE_RECEIPT,
  RESPONSE_TYPE_URI as MEMBERS_SELF_REMOVE_RECEIPT_RESPONSE,
  type VTCMembersSelfRemoveReceiptPayload,
  type VTCMembersSelfRemoveReceiptResponsePayload,
} from "@openvtc/trust-tasks/vtc/members/self-remove-receipt/0.1/payload";
import {
  TYPE_URI as MEMBERS_REMOVAL_NOTICE,
  PAYLOAD_SCHEMA as REMOVAL_NOTICE_SCHEMA,
  type VTCMembersRemovalNoticePayload,
} from "@openvtc/trust-tasks/vtc/members/removal-notice/0.1/payload";
import { validateAgainstSchema } from "../trust-tasks/validate.js";

export interface CommunityCallerParams {
  /** Envelope `issuer` — the member's (or applicant's) identity. */
  holder: Identity;
  /** The community — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
}

/**
 * What this community asks of an applicant.
 *
 * Fetch it before building a presentation: the criteria are the community's,
 * they change, and an application built against last month's manifest is a
 * disclosure made for a reason that may no longer apply.
 */
export async function joinManifest(
  sender: TrustTaskSender,
  params: CommunityCallerParams,
): Promise<VTCJoinRequestsManifestResponsePayload> {
  const envelope = buildTrustTask(
    JR_MANIFEST,
    {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<VTCJoinRequestsManifestResponsePayload>(envelope, {
    expectedResponseType: JR_MANIFEST_RESPONSE,
    operationLabel: "vtc/join-requests/manifest/0.1",
  });
}

export interface JoinSubmitParams extends CommunityCallerParams {
  /** A Verifiable Presentation answering the manifest's criteria. */
  vp: VTCJoinRequestsSubmitPayload["vp"];
  /**
   * Whether this applicant agrees to appear in the community's public
   * registry.
   *
   * Absent is not consent. Send it explicitly, from something the applicant
   * actually chose — this decides whether their membership is published.
   */
  registryConsent?: boolean;
  extensions?: VTCJoinRequestsSubmitPayload["extensions"];
}

/**
 * The community's decision on a submission, and its effect-dependent detail.
 *
 * Re-exported so a caller can branch without importing the bindings directly.
 * **Branch on `effect`, never on which members of `with` happen to be
 * present** — every member is optional at the schema level, and which ones are
 * meaningful is decided by `effect` (`role`/`obligations`/`bundleRef` on
 * `allow`, `code`/`reason` on `deny`, `queue`/`reason` on `refer`,
 * `needs`/`presentationDefinition` on `requestMore`).
 */
export type { Verdict, VerdictEffect, VerdictWith };

/**
 * Apply to join. Returns the request id to follow up with, and the community's
 * `verdict` on the submission.
 *
 * **Read `verdict`, not a status constant.** `submit/0.1` returned
 * `status: "pending"` — a literal, so a community that admits outright,
 * refuses outright, or wants more evidence had no way to say so on the
 * response and had to be reported as "pending" regardless. `0.2` replaces it
 * with a {@link Verdict}, which carries all four outcomes. A caller that
 * renders "pending" unconditionally is now describing one branch of four.
 */
export async function submitJoinRequest(
  sender: TrustTaskSender,
  params: JoinSubmitParams,
): Promise<VTCJoinRequestsSubmitResponsePayload> {
  const payload: VTCJoinRequestsSubmitPayload = {
    vp: params.vp,
    // `!== undefined`: an explicit `false` is a refusal to be published, and
    // dropping it would leave the community to decide by default.
    ...(params.registryConsent !== undefined
      ? { registryConsent: params.registryConsent }
      : {}),
    ...(params.extensions !== undefined ? { extensions: params.extensions } : {}),
  };
  const envelope = buildTrustTask(JR_SUBMIT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCJoinRequestsSubmitResponsePayload>(envelope, {
    expectedResponseType: JR_SUBMIT_RESPONSE,
    operationLabel: "vtc/join-requests/submit/0.2",
  });
}

export interface JoinStatusParams extends CommunityCallerParams {
  requestId: string;
}

/**
 * Where an application stands.
 *
 * A `deferred` status carries `needs` and a `presentationDefinition`: the
 * community is not refusing, it is asking for more. Render those rather than
 * reporting a bare "pending", or an applicant waits for a decision that is
 * waiting on them.
 */
export async function joinRequestStatus(
  sender: TrustTaskSender,
  params: JoinStatusParams,
): Promise<VTCJoinRequestsStatusResponsePayload> {
  const payload: VTCJoinRequestsStatusPayload = { requestId: params.requestId };
  const envelope = buildTrustTask(JR_STATUS, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCJoinRequestsStatusResponsePayload>(envelope, {
    expectedResponseType: JR_STATUS_RESPONSE,
    operationLabel: "vtc/join-requests/status/0.1",
  });
}

export interface JoinReceiptParams extends CommunityCallerParams {
  requestId: string;
  status: string;
}

/** Acknowledge a decision the community pushed. */
export async function acknowledgeJoinDecision(
  sender: TrustTaskSender,
  params: JoinReceiptParams,
): Promise<VTCJoinRequestsSubmitReceiptResponsePayload> {
  const payload: VTCJoinRequestsSubmitReceiptPayload = {
    requestId: params.requestId,
    status: params.status,
  };
  const envelope = buildTrustTask(JR_SUBMIT_RECEIPT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCJoinRequestsSubmitReceiptResponsePayload>(envelope, {
    expectedResponseType: JR_SUBMIT_RECEIPT_RESPONSE,
    operationLabel: "vtc/join-requests/submit-receipt/0.1",
  });
}

export interface RequestVmcParams extends CommunityCallerParams {
  /** The community being asked. */
  communityDid: string;
  reason?: string;
}

/**
 * Ask for a Verifiable Membership Credential.
 *
 * The response only acknowledges the request — the credential itself arrives
 * later as a separate `vtc/members/vmc` task from the community. A caller that
 * waits on this call for the credential will wait forever.
 */
export async function requestMembershipCredential(
  sender: TrustTaskSender,
  params: RequestVmcParams,
): Promise<VTCMembersRequestVMCResponsePayload> {
  const payload: VTCMembersRequestVMCPayload = {
    communityDid: params.communityDid,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(MEMBERS_REQUEST_VMC, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCMembersRequestVMCResponsePayload>(envelope, {
    expectedResponseType: MEMBERS_REQUEST_VMC_RESPONSE,
    operationLabel: "vtc/members/request-vmc/0.1",
  });
}

export interface DeliverVmcParams extends CommunityCallerParams {
  /** The membership credential. */
  vc: VTCMembersDeliverVMCPayload["vc"];
  /** The request this answers, when it answers one. */
  requestId?: string;
}

/** Deliver a membership credential, and collect the storage receipt. */
export async function deliverMembershipCredential(
  sender: TrustTaskSender,
  params: DeliverVmcParams,
): Promise<VTCMembersDeliverVMCReceiptPayload> {
  const payload: VTCMembersDeliverVMCPayload = {
    vc: params.vc,
    ...(params.requestId ? { requestId: params.requestId } : {}),
  };
  const envelope = buildTrustTask(MEMBERS_VMC, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCMembersDeliverVMCReceiptPayload>(envelope, {
    expectedResponseType: MEMBERS_VMC_RESPONSE,
    operationLabel: "vtc/members/vmc/0.1",
  });
}

export interface SelfRemoveParams extends CommunityCallerParams {
  /**
   * What should happen to this member's record.
   *
   * `purge` erases it; `tombstone` keeps a marker that someone was here and
   * left. The difference is whether the community can still answer questions
   * about a past membership, so it is the member's choice to state — not a
   * default to accept quietly on their behalf.
   */
  disposition?: VTCMembersSelfRemovePayload["disposition"];
}

/** Leave a community. */
export async function selfRemoveFromCommunity(
  sender: TrustTaskSender,
  params: SelfRemoveParams,
): Promise<VTCMembersSelfRemoveResponsePayload> {
  const payload: VTCMembersSelfRemovePayload = {
    ...(params.disposition ? { disposition: params.disposition } : {}),
  };
  const envelope = buildTrustTask(MEMBERS_SELF_REMOVE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCMembersSelfRemoveResponsePayload>(envelope, {
    expectedResponseType: MEMBERS_SELF_REMOVE_RESPONSE,
    operationLabel: "vtc/members/self-remove/0.1",
  });
}

export interface SelfRemoveReceiptParams extends CommunityCallerParams {
  did: string;
  disposition: string;
  removed: boolean;
}

/** Acknowledge a removal the community carried out. */
export async function acknowledgeSelfRemoval(
  sender: TrustTaskSender,
  params: SelfRemoveReceiptParams,
): Promise<VTCMembersSelfRemoveReceiptResponsePayload> {
  const payload: VTCMembersSelfRemoveReceiptPayload = {
    did: params.did,
    disposition: params.disposition,
    removed: params.removed,
  };
  const envelope = buildTrustTask(MEMBERS_SELF_REMOVE_RECEIPT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTCMembersSelfRemoveReceiptResponsePayload>(envelope, {
    expectedResponseType: MEMBERS_SELF_REMOVE_RECEIPT_RESPONSE,
    operationLabel: "vtc/members/self-remove-receipt/0.1",
  });
}

/** The community's account of a removal this member did not ask for. */
export type RemovalNotice = VTCMembersRemovalNoticePayload;

/**
 * Read an inbound `vtc/members/removal-notice/0.1`.
 *
 * **A parser, not a sender** — the whole family here is the member's side, and
 * this is the one document in it that arrives unsolicited. Unlike
 * {@link acknowledgeSelfRemoval}'s receipt it answers no request, because the
 * member did not make one: the first they learn of it is this.
 *
 * Returns `null` for anything that is not a removal notice from
 * `expectedCommunityDid`, which is the only case a caller may ignore in
 * silence. **The sender check is the security boundary**: an unauthenticated
 * party must not be able to tell a wallet its membership is gone. That would
 * be a cheap way to make someone abandon a community they are still in, and it
 * is the same reasoning `parseTaskConsentGranted` applies to its own nudge.
 *
 * Three members carry more than their types show, and a surface that renders
 * this should use all three:
 *
 * - **`code`** distinguishes `adminRemoved` (policy-governed) from `purged`
 *   (a super-administrator deletion that skips the removal policy). They are
 *   not one `removed` state because what recourse the member has differs.
 * - **`disposition`** says what happened to the member's *published* record —
 *   `purge`, `tombstone` or `historical`. Always concrete: a community
 *   resolves any policy default before sending.
 * - **`decidedAt`** is when the removal took effect, which is **not** the
 *   envelope's `issuedAt` — those diverge by however long the member was
 *   offline, and it is the decision that has to be placed in time.
 *
 * `reason` absent and `reason: ""` are different claims. This is the member's
 * only account of why, so render the absence as "no reason given" rather than
 * as an empty line.
 */
export function parseRemovalNotice(
  doc: unknown,
  expectedCommunityDid: string,
): RemovalNotice | null {
  if (typeof doc !== "object" || doc === null) return null;
  const envelope = doc as { type?: unknown; issuer?: unknown; payload?: unknown };
  if (envelope.type !== MEMBERS_REMOVAL_NOTICE) return null;
  // The community is the document's `issuer`; `decidedBy` names the individual
  // administrator, and is not who the notice is trusted as coming from.
  if (typeof envelope.issuer !== "string" || envelope.issuer !== expectedCommunityDid) {
    return null;
  }

  // Checked against the published schema, not by hand. The hand-written version
  // this replaces enumerated the two `code` values and the three `disposition`
  // values as literals — a transcription that is correct only until the
  // registry adds a fourth, at which point a legitimate notice is dropped in
  // silence and a member is not told they were removed. The schema is the one
  // copy that cannot fall behind itself, and it also enforces what the hand
  // version had no way to: `additionalProperties: false`, and the bounds on
  // `reason`, which is the prose this surface renders.
  if (!validateAgainstSchema(REMOVAL_NOTICE_SCHEMA, envelope.payload).valid) return null;
  return envelope.payload as RemovalNotice;
}
