// Vault — sign-trust-task.
//
// Posts a `https://trusttasks.org/spec/vault/sign-trust-task/0.2`
// envelope. The VTA attaches an eddsa-jcs-2022 Data Integrity proof
// to the supplied envelope, signing as the principal DID of a
// `did-self-issued` or `didcomm-peer` vault entry. The long-term
// signing key never leaves the VTA.
//
// This is the per-envelope signing complement to `vault/proxy-login`:
// proxy-login mints a session credential at session-start; sign-trust-
// task signs individual follow-up tasks during that session so the
// RP's `proof.verificationMethod == authenticated session DID` check
// passes.
//
// Unlike `vault/release` / `vault/proxy-login`, the response is NOT
// authcrypt-sealed — the signed envelope is destined for the RP
// (which has to be able to verify it anyway) and carries no
// long-term secret material. The proof itself is the only sensitive
// output, and it's deliberately public.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { VtaAuthInputs } from "./transport.js";
import type { TrustTaskEnvelope } from "../trust-tasks/sign.js";

const TASK_VAULT_SIGN_TRUST_TASK = "https://trusttasks.org/spec/vault/sign-trust-task/0.2";
const TASK_VAULT_SIGN_TRUST_TASK_RESPONSE =
  "https://trusttasks.org/spec/vault/sign-trust-task/0.2#response";

export interface VaultSignTrustTaskOptions {
  /** Issuer of the request (envelope `issuer`). */
  holder: Identity;
  /** The VTA — audience-binds the request (envelope `recipient`). */
  service: RemoteDidcommEndpoint;
  /** Identifier of the vault entry whose principal will sign. MUST
   *  point at a `did-self-issued` or `didcomm-peer` entry — other
   *  kinds reject with `vault/sign-trust-task:not_signable`. */
  entryId: string;
  /** The Trust Task document to sign. MUST have no `proof` field.
   *  MUST set `issuer = <entry.principalDid>`. The VTA refuses to
   *  silently rewrite issuer (`envelope_issuer_mismatch`). */
  unsignedEnvelope: TrustTaskEnvelope;
}

/** @deprecated REST-transport options. Kept for existing call sites; prefer
 *  {@link vaultSignTrustTask} with a channel from a `VtaSession`. */
export interface VaultSignTrustTaskRestOptions
  extends VaultSignTrustTaskOptions,
    VtaAuthInputs {}

export interface VaultSignTrustTaskResponse {
  /** The supplied envelope with a `proof` field attached.
   *  `proof.verificationMethod = <principalDid>#<signingKeyId>`;
   *  `proof.cryptosuite = "eddsa-jcs-2022"`;
   *  `proof.proofPurpose = "assertionMethod"`. */
  signedEnvelope: TrustTaskEnvelope;
}

/**
 * Ask the VTA to sign a Trust Task envelope as the principal of a
 * vault entry. The returned `signedEnvelope` is byte-identical to
 * the input except for the attached `proof` field.
 */
export async function vaultSignTrustTask(
  channel: TrustTaskSender,
  opts: VaultSignTrustTaskOptions,
): Promise<VaultSignTrustTaskResponse> {
  const envelope = buildTrustTask(
    TASK_VAULT_SIGN_TRUST_TASK,
    { entryId: opts.entryId, unsignedEnvelope: opts.unsignedEnvelope },
    { issuer: opts.holder.did, recipient: opts.service.did },
  );
  const wire = await channel.send<{ signedEnvelope: TrustTaskEnvelope }>(envelope, {
    expectedResponseType: TASK_VAULT_SIGN_TRUST_TASK_RESPONSE,
    operationLabel: "vault/sign-trust-task/0.2",
  });
  return { signedEnvelope: wire.signedEnvelope };
}

/** @deprecated Use {@link vaultSignTrustTask} with a channel from a
 *  `VtaSession`. Sign over REST — builds a one-shot {@link RestChannel}. */
export function vaultSignTrustTaskRest(
  opts: VaultSignTrustTaskRestOptions,
): Promise<VaultSignTrustTaskResponse> {
  return vaultSignTrustTask(new RestChannel(opts), opts);
}
