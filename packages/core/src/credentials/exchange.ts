// Credential exchange — the answerable half of `credential-exchange/*`.
//
// Issuance and presentation are threaded: `offer → request → issue` and
// `query → present`. Each step is its own Trust Task carrying an OID4VCI or
// OID4VP structure verbatim, and **none of those five defines a response
// document**. Per SPEC.md §8.6 a consumer may send a courtesy
// `trust-task-ok`, but "a producer MUST NOT rely on receiving one, and the
// absence of one carries no information".
//
// This library cannot express that yet. `TrustTaskChannel` offers exactly one
// primitive — `send()`, which awaits a reply — so wrapping the threaded steps
// would await something a conforming counterparty is entitled never to send:
// a hang, or a timeout reported as a failure when the message was delivered
// perfectly. Supporting them needs a one-way path on the channel (and on all
// three transports), which is a change to make deliberately rather than as a
// side effect of adding a family.
//
// So what is here is the part that genuinely is request/response: the deferred
// presentations a verifier asked for while the holder was away, and the
// holder's decision on them.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as CX_PENDING_LIST,
  RESPONSE_TYPE_URI as CX_PENDING_LIST_RESPONSE,
  type CredentialExchangePendingListResponsePayload,
  type DeferredPresentation,
  type RequestedCredential,
} from "@openvtc/trust-tasks/credential-exchange/pending/list/0.1/payload";
import {
  TYPE_URI as CX_PENDING_APPROVE,
  RESPONSE_TYPE_URI as CX_PENDING_APPROVE_RESPONSE,
  type CredentialExchangePendingApproveResponsePayload,
} from "@openvtc/trust-tasks/credential-exchange/pending/approve/0.1/payload";
import {
  TYPE_URI as CX_PENDING_DENY,
  RESPONSE_TYPE_URI as CX_PENDING_DENY_RESPONSE,
  type CredentialExchangePendingDenyResponsePayload,
} from "@openvtc/trust-tasks/credential-exchange/pending/deny/0.1/payload";

export type { DeferredPresentation, RequestedCredential };

export interface ExchangeCallerParams {
  /** Envelope `issuer` — this party's DIDComm identity. */
  holder: Identity;
  /** The counterparty — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
}

/**
 * Presentations a verifier asked for while the holder was away.
 *
 * Each carries `requested` — the specific credentials and **claims** the
 * verifier wants — the purpose it stated, and when it expires. Render the
 * claim list: "approve this presentation" without saying which fields leave
 * the wallet is not consent to anything in particular.
 *
 * `purpose` is written by the verifier about itself. Show it as a claim, never
 * as an explanation the holder's own agent vouches for.
 */
export async function pendingPresentations(
  sender: TrustTaskSender,
  params: ExchangeCallerParams,
): Promise<DeferredPresentation[]> {
  const envelope = buildTrustTask(
    CX_PENDING_LIST,
    {},
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<CredentialExchangePendingListResponsePayload>(envelope, {
    expectedResponseType: CX_PENDING_LIST_RESPONSE,
    operationLabel: "credential-exchange/pending/list/0.1",
  });
  return res.pending ?? [];
}

export interface PendingDecisionParams extends ExchangeCallerParams {
  /** The deferred presentation's id, from {@link pendingPresentations}. */
  id: string;
}

/**
 * Approve a deferred presentation.
 *
 * Returns the `vp_token` that goes to the verifier. Approving is what mints
 * it, so a failure here means nothing was disclosed — which is the reassuring
 * direction, and worth saying plainly to a user who sees an error.
 */
export async function approvePendingPresentation(
  sender: TrustTaskSender,
  params: PendingDecisionParams,
): Promise<CredentialExchangePendingApproveResponsePayload> {
  const envelope = buildTrustTask(
    CX_PENDING_APPROVE,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<CredentialExchangePendingApproveResponsePayload>(envelope, {
    expectedResponseType: CX_PENDING_APPROVE_RESPONSE,
    operationLabel: "credential-exchange/pending/approve/0.1",
  });
}

/** Deny a deferred presentation. Nothing is disclosed. */
export async function denyPendingPresentation(
  sender: TrustTaskSender,
  params: PendingDecisionParams,
): Promise<CredentialExchangePendingDenyResponsePayload> {
  const envelope = buildTrustTask(
    CX_PENDING_DENY,
    { id: params.id },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<CredentialExchangePendingDenyResponsePayload>(envelope, {
    expectedResponseType: CX_PENDING_DENY_RESPONSE,
    operationLabel: "credential-exchange/pending/deny/0.1",
  });
}
