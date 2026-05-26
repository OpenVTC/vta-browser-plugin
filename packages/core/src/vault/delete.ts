// Vault — delete (M2A.5).
//
// Posts a `https://trusttasks.org/spec/vault/delete/0.1` envelope to the
// VTA's trust-task dispatcher. No envelope / sealing — delete carries
// only id + optimistic-concurrency token, all visible to anyone with the
// bearer.

import { getVtaBearer, postTrustTask, type VtaAuthInputs } from "./transport.js";

const TASK_VAULT_DELETE = "https://trusttasks.org/spec/vault/delete/0.1";
const TASK_VAULT_DELETE_RESPONSE = "https://trusttasks.org/spec/vault/delete/0.1#response";

export interface VaultDeleteRestOptions extends VtaAuthInputs {
  id: string;
  /** Observed `version` for optimistic concurrency. Strongly RECOMMENDED;
   *  the maintainer rejects with `vault/delete:version_conflict` on
   *  mismatch (with `details.currentVersion` for retry). */
  expectedVersion?: number;
  /** Human-readable rationale recorded in the audit trail. */
  reason?: string;
}

export interface VaultDeleteResponse {
  id: string;
  deletedAt: string;
  /** Equals `deletedAt` when the maintainer hard-deletes (M2A.2). Real
   *  grace windows arrive with sync (M5). */
  graceUntil: string;
}

export async function vaultDeleteRest(
  opts: VaultDeleteRestOptions,
): Promise<VaultDeleteResponse> {
  const bearer = await getVtaBearer({
    baseUrl: opts.baseUrl,
    holder: opts.holder,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return postTrustTask<VaultDeleteResponse>({
    baseUrl: opts.baseUrl,
    bearer,
    envelope: {
      type: TASK_VAULT_DELETE,
      payload: {
        id: opts.id,
        ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
      issuer: opts.holder.did,
      recipient: opts.service.did,
    },
    expectedResponseType: TASK_VAULT_DELETE_RESPONSE,
    operationLabel: "vault/delete/0.1",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
