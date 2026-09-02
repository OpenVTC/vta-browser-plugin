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

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as CREDENTIALS_LIST,
  RESPONSE_TYPE_URI as CREDENTIALS_LIST_RESPONSE,
  type VTACredentialsListResponsePayload,
  type IssuedCredentialSummary,
  type IssuedCredentialStatus,
} from "@openvtc/trust-tasks/vta/credentials/list/0.1/payload";

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
  holder: TaskParty;
  /** The issuing agent — envelope `recipient`. */
  service: TaskParty;
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

export type { IssuedCredentialSummary, IssuedCredentialStatus };

export interface ListCredentialsParams extends CredentialIssuerCallerParams {
  /**
   * Only credentials issued to this DID.
   *
   * Named `holderDid` rather than `holder` — matching {@link issueCredential} —
   * because `holder` on the caller params is the envelope's *issuer*, this
   * library's own identity. Two different parties would otherwise share one
   * member name on the same object.
   */
  holderDid?: string;
  /** Only credentials carrying this type tag beyond `VerifiableCredential`. */
  credentialType?: string;
  /** Only credentials in this state. */
  status?: IssuedCredentialStatus;
  /** Maximum records to return. The agent caps this. */
  pageSize?: number;
  /** Continue a previous page. Opaque — never construct or parse one. */
  cursor?: string;
}

export interface ListCredentialsResult {
  credentials: IssuedCredentialSummary[];
  /** The agent stopped early. **Check this before drawing conclusions** — a
   *  truncated page is not a complete account of what was issued, and reading
   *  "nothing else was issued" off one is the mistake the member exists to
   *  prevent. */
  truncated: boolean;
  /** Pass as `cursor` to continue. Absent on the last page, so a caller stops
   *  on its absence rather than needing an empty page to learn it is done. */
  cursor?: string;
}

/**
 * What this agent has issued, as metadata.
 *
 * **No credential bodies.** `vault/list/0.1` states the rule this family
 * follows — list enumerates, release uses — and an issuer that needs a body
 * minted it and got it back from {@link issueCredential}. A caller reaching for
 * this to populate claim data has mistaken it for a read of the credentials
 * themselves; there is no such task.
 *
 * `status` is derived by the agent when it answers, never stored, and
 * `revoked` takes precedence over `expired` — a credential revoked before its
 * window closed is revoked, and reading it as merely expired hides that
 * somebody acted. Do not cache the result: a cached page reports a credential
 * as active after it has been revoked.
 *
 * Unlike the holder-side `credVaultQuery`, an unfiltered call is answered. The
 * caller here is the issuer reading a record of its own past actions rather
 * than a delegate reading someone's private store.
 */
export async function listCredentials(
  sender: TrustTaskSender,
  params: ListCredentialsParams,
): Promise<ListCredentialsResult> {
  const envelope = buildTrustTask(
    CREDENTIALS_LIST,
    {
      ...(params.holderDid ? { holder: params.holderDid } : {}),
      ...(params.credentialType ? { credentialType: params.credentialType } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<VTACredentialsListResponsePayload>(envelope, {
    expectedResponseType: CREDENTIALS_LIST_RESPONSE,
    operationLabel: "vta/credentials/list/0.1",
  });
  return {
    credentials: res.credentials ?? [],
    truncated: res.truncated ?? false,
    ...(res.cursor ? { cursor: res.cursor } : {}),
  };
}
