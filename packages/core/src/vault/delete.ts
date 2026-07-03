// Vault — delete (M2A.5).
//
// Sends a `https://trusttasks.org/spec/vault/delete/0.1` Trust Task over a
// TrustTaskSender (channel or session). No envelope / sealing — delete carries only id +
// optimistic-concurrency token, all visible to anyone the transport
// authenticates.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { VtaAuthInputs } from "./transport.js";

const TASK_VAULT_DELETE = "https://trusttasks.org/spec/vault/delete/0.1";
const TASK_VAULT_DELETE_RESPONSE = "https://trusttasks.org/spec/vault/delete/0.1#response";

export interface VaultDeleteOptions {
  /** Issuer of the request (envelope `issuer`). */
  holder: Identity;
  /** The VTA — audience-binds the request (envelope `recipient`). */
  service: RemoteDidcommEndpoint;
  id: string;
  /** Observed `version` for optimistic concurrency. Strongly RECOMMENDED;
   *  the maintainer rejects with `vault/delete:version_conflict` on
   *  mismatch (with `details.currentVersion` for retry). */
  expectedVersion?: number;
  /** Human-readable rationale recorded in the audit trail. */
  reason?: string;
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link vaultDelete} with a channel from a `VtaSession`. */
export interface VaultDeleteRestOptions extends VaultDeleteOptions, VtaAuthInputs {}

export interface VaultDeleteResponse {
  id: string;
  deletedAt: string;
  /** Equals `deletedAt` when the maintainer hard-deletes (M2A.2). Real
   *  grace windows arrive with sync (M5). */
  graceUntil: string;
}

/** Delete a vault entry over the given channel. */
export async function vaultDelete(
  channel: TrustTaskSender,
  opts: VaultDeleteOptions,
): Promise<VaultDeleteResponse> {
  const envelope = buildTrustTask(
    TASK_VAULT_DELETE,
    {
      id: opts.id,
      ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
    { issuer: opts.holder.did, recipient: opts.service.did },
  );
  return channel.send<VaultDeleteResponse>(envelope, {
    expectedResponseType: TASK_VAULT_DELETE_RESPONSE,
    operationLabel: "vault/delete/0.1",
  });
}

/** @deprecated Use {@link vaultDelete} with a channel from a `VtaSession`.
 *  Delete over REST — builds a one-shot {@link RestChannel}. */
export function vaultDeleteRest(opts: VaultDeleteRestOptions): Promise<VaultDeleteResponse> {
  return vaultDelete(new RestChannel(opts), opts);
}
