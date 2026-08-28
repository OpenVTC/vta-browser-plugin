// `vault/get/0.3` — one entry's metadata.
//
// The counterpart to `vault/list`, and deliberately *not* the counterpart to
// `vault/release`: this returns the entry's shape — label, targets, context,
// kind, timestamps — and **never the secret**. Releasing a secret is its own
// task, with its own gating, precisely so that reading a vault's contents and
// obtaining what is inside them are separate authorities.
//
// Types come from `@openvtc/trust-tasks`; this file is the call layer.

import { type Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { VtaAuthInputs } from "../vta/auth.js";

import {
  TYPE_URI as VAULT_GET,
  RESPONSE_TYPE_URI as VAULT_GET_RESPONSE,
  type VaultGetPayload,
  type VaultGetResponsePayload,
  type VaultEntry,
} from "@openvtc/trust-tasks/vault/get/0.3/payload";

// `VaultEntry` is deliberately NOT re-exported here.
//
// `vault/list.ts` already exports a hand-written type of that name, written
// before the generated bindings existed, and the two disagree: the spec's
// `targets` is a non-empty tuple, and its `AttachmentRef` has no `sha256`
// member. Exporting both would put two different shapes behind one name.
//
// Migrating the rest of `vault/` onto the generated types is the same job the
// `admin/` module has already had done to it, and worth doing for the same
// reason — but it is a change to a published surface, not a detail to slip
// into a new call. Until then, reach for `VaultGetResult["entry"]`.

export interface VaultGetParams {
  /** Authcrypt sender / envelope `issuer` (the holder's DIDComm identity). */
  holder: Identity;
  /** VTA's keyAgreement endpoint — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
  /** Entry id. */
  id: string;
}

export interface VaultGetResult {
  entry: VaultEntry;
  /**
   * Fields the agent withheld from this caller — for example a `notes` body a
   * scoped reader may not see.
   *
   * Empty when nothing was withheld. Worth surfacing rather than swallowing: an
   * entry rendered without saying that parts of it were redacted reads as a
   * complete record, and the difference matters to whoever is deciding
   * something from it.
   */
  redactedFields: string[];
}

/** Fetch one vault entry's metadata. The secret is not included. */
export async function vaultGet(
  sender: TrustTaskSender,
  params: VaultGetParams,
): Promise<VaultGetResult> {
  const payload: VaultGetPayload = { id: params.id };
  const envelope = buildTrustTask(VAULT_GET, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<VaultGetResponsePayload>(envelope, {
    expectedResponseType: VAULT_GET_RESPONSE,
    operationLabel: "vault/get/0.3",
  });
  return { entry: res.entry, redactedFields: res.redactedFields ?? [] };
}

/** @deprecated REST-transport options. Kept for symmetry with the rest of this
 *  module; prefer {@link vaultGet} with a channel from a `VtaSession`. */
export interface VaultGetRestOptions extends VaultGetParams, VtaAuthInputs {}

/** @deprecated Use {@link vaultGet} with a channel from a `VtaSession`. */
export function vaultGetRest(opts: VaultGetRestOptions): Promise<VaultGetResult> {
  return vaultGet(new RestChannel(opts), opts);
}
