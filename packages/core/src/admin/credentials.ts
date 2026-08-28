// `vta/credentials/{issue,revoke}` — the agent as an *issuer*.
//
// Not to be confused with `../credentials`, which is the holder side: OID4VCI
// receipt and OID4VP presentation of credentials issued to this wallet's
// subject. This is the other end — asking an agent to mint a credential about
// somebody, and to revoke one it minted. Issuing authority is the thing an
// agent has that a wallet does not, which is why this lives in `admin` and is
// not in the root barrel.
//
// **`issue` is `0.2`, `revoke` is `0.1`** — the versions `vta-sdk` names. The
// two families version independently; a matching pair is a coincidence, not a
// rule, so read the import paths rather than assuming.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as CREDENTIALS_ISSUE,
  RESPONSE_TYPE_URI as CREDENTIALS_ISSUE_RESPONSE,
  type VTACredentialsIssuePayload,
  type VTACredentialsIssueResponsePayload,
} from "@openvtc/trust-tasks/vta/credentials/issue/0.2/payload";
import {
  TYPE_URI as CREDENTIALS_REVOKE,
  RESPONSE_TYPE_URI as CREDENTIALS_REVOKE_RESPONSE,
  type VTACredentialsRevokePayload,
  type VTACredentialsRevokeResponsePayload,
} from "@openvtc/trust-tasks/vta/credentials/revoke/0.1/payload";

/** Both calls are issued by an operator identity, to an agent. */
export interface CredentialIssuerCallerParams {
  /** Envelope `issuer` — needs an agent role that carries issuing authority. */
  holder: Identity;
  /** The issuing agent — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
}

export interface IssueCredentialParams extends CredentialIssuerCallerParams {
  /** DID of the subject the credential is *about* — not the caller. */
  holderDid: string;
  /** The claims to attest. Their shape is the credential type's business. */
  claims: VTACredentialsIssuePayload["claims"];
  /** Which credential to mint. Omitted takes the agent's default type. */
  credentialType?: string;
  /**
   * Lifetime in seconds, REQUIRED — there is no "does not expire".
   *
   * The response echoes the resulting `expiresAt`, and it is worth reading
   * rather than recomputing: an agent may clamp a request down to its own
   * policy ceiling, and the credential expires when it says, not when the
   * caller asked.
   */
  validitySeconds: number;
  /** Why it was issued, recorded with it. */
  purpose?: string;
}

/**
 * Ask the agent to issue a credential.
 *
 * The response is the shared `IssuedCredentialBase` as of `0.2`, which composes
 * it from `credentials/_shared/0.2` rather than restating the members — the
 * change that stops the two drifting. Two consequences for a caller:
 *
 * - **`issuedAt` is new and worth recording.** The agent had been computing and
 *   storing it since the family existed; `0.1` simply had nowhere to put it, so
 *   it was dropped on the way out. It is optional in the shared definition — a
 *   response without it is schema-valid — but the VTA always sends it.
 * - **`supersedes` is gone.** `0.1` carried it to name a credential this
 *   issuance replaced. Nothing in the `0.2` response does, so a caller that
 *   needs to know which of two credentials for one subject is current must get
 *   that from `expiresAt` or its own records rather than from the answer.
 */
export async function issueCredential(
  sender: TrustTaskSender,
  params: IssueCredentialParams,
): Promise<VTACredentialsIssueResponsePayload> {
  const payload: VTACredentialsIssuePayload = {
    holder: params.holderDid,
    claims: params.claims,
    validitySeconds: params.validitySeconds,
    ...(params.credentialType !== undefined
      ? { credentialType: params.credentialType }
      : {}),
    ...(params.purpose !== undefined ? { purpose: params.purpose } : {}),
  };
  const envelope = buildTrustTask(CREDENTIALS_ISSUE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTACredentialsIssueResponsePayload>(envelope, {
    expectedResponseType: CREDENTIALS_ISSUE_RESPONSE,
    operationLabel: "vta/credentials/issue/0.2",
  });
}

export interface RevokeCredentialParams extends CredentialIssuerCallerParams {
  credentialId: string;
  /** Operator rationale, recorded with the revocation. */
  reason?: string;
}

/**
 * Revoke a credential the agent issued.
 *
 * `revokedAt` is when it took effect and `statusListIndex`, where the agent
 * publishes a status list, is the position a verifier checks. Neither is
 * derivable at the call site: a verifier that has already cached the status
 * list will not see the revocation until it refreshes, so "revoked" here and
 * "rejected there" are separated by however long that takes.
 */
export async function revokeCredential(
  sender: TrustTaskSender,
  params: RevokeCredentialParams,
): Promise<VTACredentialsRevokeResponsePayload> {
  const payload: VTACredentialsRevokePayload = {
    credentialId: params.credentialId,
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(CREDENTIALS_REVOKE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<VTACredentialsRevokeResponsePayload>(envelope, {
    expectedResponseType: CREDENTIALS_REVOKE_RESPONSE,
    operationLabel: "vta/credentials/revoke/0.1",
  });
}
