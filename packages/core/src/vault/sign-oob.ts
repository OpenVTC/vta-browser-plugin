// The VTA signs the member's two wallet sign-in documents.
//
// TODO(vta-oob-signing): the request shapes in this file are NOT final. The VTA
// change that lets `vault/sign-trust-task` sign `auth/oob/identify` (no user
// verification) and `auth/oob/grant` (only with the device's user-verification
// decision over the grant's digest, contract C6 / base design §11) is being
// built in parallel. Everything that depends on its wire shape is in this one
// module so the cut-over is one file:
//
//   - where the `consent/decision` rides in the `vault/sign-trust-task/0.2`
//     request ({@link VaultSignGrantRequest.consentDecision} — a sibling of
//     `unsignedEnvelope` here);
//   - the decision's own shape ({@link UvConsentDecision}) and how the WebAuthn
//     assertion is encoded in it;
//   - what the assertion's challenge is ({@link uvChallengeForDigest}).
//
// What is NOT provisional, and is checked by the caller whatever the VTA
// answers: the returned document must be the one sent plus a proof, signed for
// `authentication` (identify) or `assertionMethod` (grant) —
// `assertSignedAsSent` in `vtc/oob-sign-in.ts`.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { decodeDigestMultibase } from "../trust-tasks/digest.js";
import type { TrustTaskEnvelope } from "../trust-tasks/sign.js";
import { vaultSignTrustTask } from "./sign-trust-task.js";

import {
  TYPE_URI as TASK_VAULT_SIGN_TRUST_TASK,
  RESPONSE_TYPE_URI as TASK_VAULT_SIGN_TRUST_TASK_RESPONSE,
} from "@openvtc/trust-tasks/vault/sign-trust-task/0.2/payload";

export interface VaultOobSignOptions {
  /** The wallet's holder: issuer of the `vault/sign-trust-task` request. */
  holder: Identity;
  /** The VTA. */
  service: RemoteDidcommEndpoint;
  /** The `didSelfIssued` vault entry of the identity the member chose. */
  entryId: string;
}

/**
 * Sign `auth/oob/identify` as the member. Needs no user verification (base
 * design §11 item 2) — it grants nothing on its own — so this is the existing
 * `vault/sign-trust-task/0.2` call, unchanged.
 */
export async function vaultSignIdentify(
  channel: TrustTaskSender,
  opts: VaultOobSignOptions & { unsignedIdentify: TrustTaskEnvelope },
): Promise<TrustTaskEnvelope> {
  const { signedEnvelope } = await vaultSignTrustTask(channel, {
    holder: opts.holder,
    service: opts.service,
    entryId: opts.entryId,
    unsignedEnvelope: opts.unsignedIdentify,
  });
  return signedEnvelope;
}

/**
 * The WebAuthn assertion the plugin's passkey makes over the grant digest
 * (contract C6), base64url-encoded member by member.
 *
 * TODO(vta-oob-signing): replace with the VTA's `consent/decision` shape.
 */
export interface UvWebauthnAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  userHandle?: string;
}

/**
 * The device's user-verification decision over the unsigned grant.
 *
 * TODO(vta-oob-signing): replace with the VTA's `consent/decision` shape.
 */
export interface UvConsentDecision {
  /** The grant digest (`grantDigest` in `vtc/oob-sign-in.ts`). */
  payloadDigest: string;
  decision: "approve";
  /** `webauthn` for the browser plugin; a phone's hardware UV key would be
   *  another kind. */
  kind: "webauthn";
  assertion: UvWebauthnAssertion;
}

/**
 * The assertion's challenge: the 32 raw SHA-256 bytes inside the grant's
 * `digestMultibase`, so the authenticator's signature is over this grant and
 * nothing else.
 *
 * TODO(vta-oob-signing): confirm with the VTA's `vti-webauthn` verifier.
 */
export function uvChallengeForDigest(payloadDigest: string): Uint8Array {
  return decodeDigestMultibase(payloadDigest);
}

/** TODO(vta-oob-signing): the request payload is not final. */
export interface VaultSignGrantRequest {
  entryId: string;
  unsignedEnvelope: TrustTaskEnvelope;
  /** Present for an approval; absent for a decline, which needs no UV. */
  consentDecision?: UvConsentDecision;
}

/**
 * Sign `auth/oob/grant` as the member. The VTA signs an approval only with the
 * device's user-verification decision over the grant digest; a decline is
 * signed without one (base design §14 step 12).
 */
export async function vaultSignGrant(
  channel: TrustTaskSender,
  opts: VaultOobSignOptions & { unsignedGrant: TrustTaskEnvelope; consentDecision?: UvConsentDecision },
): Promise<TrustTaskEnvelope> {
  const payload: VaultSignGrantRequest = {
    entryId: opts.entryId,
    unsignedEnvelope: opts.unsignedGrant,
    ...(opts.consentDecision ? { consentDecision: opts.consentDecision } : {}),
  };
  const envelope = buildTrustTask(TASK_VAULT_SIGN_TRUST_TASK, payload, {
    issuer: opts.holder.did,
    recipient: opts.service.did,
  });
  const wire = await channel.send<{ signedEnvelope: TrustTaskEnvelope }>(envelope, {
    expectedResponseType: TASK_VAULT_SIGN_TRUST_TASK_RESPONSE,
    operationLabel: "vault/sign-trust-task/0.2 (auth/oob/grant)",
  });
  return wire.signedEnvelope;
}
