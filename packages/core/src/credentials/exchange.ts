// Credential exchange — `credential-exchange/*`.
//
// Issuance and presentation are threaded: `offer → request → issue` and
// `query → present`. Each step is its own Trust Task carrying an OID4VCI or
// OID4VP structure **verbatim** — which is why `credential_offer`,
// `credential_request`, `vp_token` and `dcql_query` keep their snake_case
// names. They belong to a foreign specification, and re-spelling them here
// would create a second source of truth that drifts from it.
//
// **The threaded steps take a `TrustTaskNotifier`, not a sender.** None of the
// five defines a response document; per SPEC.md §8.6 a consumer may send a
// courtesy `trust-task-ok`, but "a producer MUST NOT rely on receiving one,
// and the absence of one carries no information". So these resolve when the
// message reaches the transport and tell you nothing more — the counterparty's
// answer, when there is one, arrives later as the *next* task in the thread.
// Taking a notifier rather than a sender puts that in the signature: a caller
// cannot accidentally await an answer that was never promised.
//
// The `pending/*` calls below are genuinely request/response and take a
// sender, as usual.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskNotifier, TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as CX_OFFER,
  type CredentialExchangeOfferPayload,
} from "@openvtc/trust-tasks/credential-exchange/offer/0.1/payload";
import {
  TYPE_URI as CX_REQUEST,
  type CredentialExchangeRequestPayload,
} from "@openvtc/trust-tasks/credential-exchange/request/0.1/payload";
import {
  TYPE_URI as CX_ISSUE,
  type CredentialExchangeIssuePayload,
} from "@openvtc/trust-tasks/credential-exchange/issue/0.1/payload";
import {
  TYPE_URI as CX_QUERY,
  type CredentialExchangeQueryPayload,
} from "@openvtc/trust-tasks/credential-exchange/query/0.1/payload";
import {
  TYPE_URI as CX_PRESENT,
  type CredentialExchangePresentPayload,
} from "@openvtc/trust-tasks/credential-exchange/present/0.1/payload";
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

// ── the threaded steps: delivered, not answered ─────────────────────────────

export interface CredentialOfferParams extends ExchangeCallerParams {
  /** An OID4VCI Credential Offer, carried verbatim. */
  credentialOffer: CredentialExchangeOfferPayload["credential_offer"];
}

/** Issuer → holder: offer a credential, opening the issuance thread. */
export async function credentialOffer(
  notifier: TrustTaskNotifier,
  params: CredentialOfferParams,
): Promise<void> {
  // The camelCase parameter is this library's ergonomics; the snake_case
  // member is OID4VCI's. The boundary between the two conventions is here,
  // and nowhere else.
  const payload: CredentialExchangeOfferPayload = {
    credential_offer: params.credentialOffer,
  };
  await notifier.notify(
    buildTrustTask(CX_OFFER, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { operationLabel: "credential-exchange/offer/0.1" },
  );
}

export interface CredentialRequestParams extends ExchangeCallerParams {
  /** An OID4VCI Credential Request, carried verbatim. */
  credentialRequest: CredentialExchangeRequestPayload["credential_request"];
}

/** Holder → issuer: ask for the offered credential. */
export async function credentialRequest(
  notifier: TrustTaskNotifier,
  params: CredentialRequestParams,
): Promise<void> {
  const payload: CredentialExchangeRequestPayload = {
    credential_request: params.credentialRequest,
  };
  await notifier.notify(
    buildTrustTask(CX_REQUEST, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { operationLabel: "credential-exchange/request/0.1" },
  );
}

/**
 * Issuer → holder: deliver the credential.
 *
 * **Exactly one carrier.** `credentialResponse` is cleartext, for a known
 * holder over an authenticated channel; `sealed` is an armored bundle
 * encrypted to the holder, for a secret-bearing credential or a holder not yet
 * known. Only the holder can open the sealed form, and an out-of-band digest
 * pins its integrity — there is no trust-on-first-use.
 *
 * The union is enforced in the type rather than left to the agent, because
 * sending both would ship the credential in cleartext alongside the very
 * envelope that exists to avoid that.
 */
export type CredentialIssueParams = ExchangeCallerParams &
  (
    | { credentialResponse: Record<string, unknown>; sealed?: never }
    | { sealed: string; credentialResponse?: never }
  );

export async function credentialIssue(
  notifier: TrustTaskNotifier,
  params: CredentialIssueParams,
): Promise<void> {
  const payload: CredentialExchangeIssuePayload =
    params.sealed !== undefined
      ? { sealed: params.sealed }
      : { credential_response: params.credentialResponse };
  await notifier.notify(
    buildTrustTask(CX_ISSUE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { operationLabel: "credential-exchange/issue/0.1" },
  );
}

export interface CredentialQueryParams extends ExchangeCallerParams {
  /** A DCQL query, carried verbatim. */
  dcqlQuery: CredentialExchangeQueryPayload["dcql_query"];
  /** Replay protection — bound into the presentation that answers this. */
  nonce: string;
  /** Why the verifier wants it. **Written by the verifier about itself**, so
   *  render it as a claim, never as an explanation the holder's own agent
   *  vouches for. */
  purpose: string;
}

/** Verifier → holder: ask for a presentation. */
export async function credentialQuery(
  notifier: TrustTaskNotifier,
  params: CredentialQueryParams,
): Promise<void> {
  const payload: CredentialExchangeQueryPayload = {
    dcql_query: params.dcqlQuery,
    nonce: params.nonce,
    purpose: params.purpose,
  };
  await notifier.notify(
    buildTrustTask(CX_QUERY, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { operationLabel: "credential-exchange/query/0.1" },
  );
}

export interface CredentialPresentParams extends ExchangeCallerParams {
  /** An OID4VP `vp_token` — a compact string or a JSON object. */
  vpToken: CredentialExchangePresentPayload["vp_token"];
}

/** Holder → verifier: answer a query. */
export async function credentialPresent(
  notifier: TrustTaskNotifier,
  params: CredentialPresentParams,
): Promise<void> {
  const payload: CredentialExchangePresentPayload = { vp_token: params.vpToken };
  await notifier.notify(
    buildTrustTask(CX_PRESENT, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { operationLabel: "credential-exchange/present/0.1" },
  );
}

// ── deferred presentations: genuinely request/response ──────────────────────

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
