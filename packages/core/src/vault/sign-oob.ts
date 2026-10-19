// The VTA signs the member's two wallet sign-in documents, and learns the
// device's user-verification key.
//
// The shapes are the VTA's (verifiable-trust-infrastructure
// `vta-service/src/operations/vault/oob_sign_in.rs`,
// `vta-sdk/src/protocols/device_management.rs`) and contract C9:
//
//   - `identify` and `grant` both go through `vault/sign-trust-task/0.2` with
//     payload `{entryId, unsignedEnvelope}`. The envelope carries framework
//     members only — no `ext` — and an `issuedAt` within 300 s of the VTA's
//     clock. `identify` needs nothing more.
//   - A grant approval adds `payload.ext["org.openvtc.uv-consent"].decision`:
//     a `task-consent/decision/0.2` addressed to the VTA, issued and signed
//     (for `assertionMethod`) by the device's **UV key** — the `did:key` the
//     wallet holds sealed under its PRF passkey (`store/sign-in-uv-key.ts`) —
//     with payload `{challenge: D, payloadDigest: D, decision: "approve"}`
//     and no evidence, where D is the grant digest (`grantDigest` in
//     `vtc/oob-sign-in.ts`).
//   - The UV key is enrolled with `device/heartbeat/0.2` (or
//     `device/register/0.2`) `payload.ext["org.openvtc.uv-key"]` as
//     `{kind: "prfSealedKey", did, hardwareBacked: false, …}`, sent over the
//     device's own transport-key session.
//
// The `org.openvtc.*` extension members stand in for registry members that do
// not exist yet. TODO: replace with generated trust-tasks types once
// `vault/sign-trust-task` carries a consent member and `device/*` a UV key.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender, TaskParty } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask, type TrustTaskEnvelope } from "../trust-tasks/sign.js";
import { vaultSignTrustTask } from "./sign-trust-task.js";
import { TASK_REFUSAL_NOT_FOUND, taskRefusalReason } from "../vta/errors.js";

import {
  TYPE_URI as TASK_VAULT_SIGN_TRUST_TASK,
  RESPONSE_TYPE_URI as TASK_VAULT_SIGN_TRUST_TASK_RESPONSE,
} from "@openvtc/trust-tasks/vault/sign-trust-task/0.2/payload";
import {
  TYPE_URI as TASK_CONSENT_DECISION,
  type TaskConsentDecisionPayload,
} from "@openvtc/trust-tasks/task-consent/decision/0.2/payload";
import {
  TYPE_URI as DEVICE_HEARTBEAT,
  RESPONSE_TYPE_URI as DEVICE_HEARTBEAT_RESPONSE,
  type DeviceHeartbeatPayload,
  type DeviceHeartbeatResponsePayload,
} from "@openvtc/trust-tasks/device/heartbeat/0.2/payload";
import {
  TYPE_URI as DEVICE_REGISTER,
  RESPONSE_TYPE_URI as DEVICE_REGISTER_RESPONSE,
  type DeviceRegisterPayload,
  type DeviceRegisterResponsePayload,
} from "@openvtc/trust-tasks/device/register/0.2/payload";

/** `payload.ext` member carrying the UV approval of a grant. */
export const EXT_UV_CONSENT = "org.openvtc.uv-consent";
/** `payload.ext` member enrolling the device's UV key. */
export const EXT_UV_KEY = "org.openvtc.uv-key";

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
 * design §11 item 2) — it grants nothing on its own.
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
 * The challenge the wallet's passkey ceremony is bound to for a grant: the
 * UTF-8 bytes of the digest string D, so the gesture that unseals the UV key
 * is made for this grant and no other.
 */
export function uvChallengeBytes(payloadDigest: string): Uint8Array {
  return new TextEncoder().encode(payloadDigest);
}

/**
 * The device's user-verification decision over the unsigned grant: a
 * `task-consent/decision/0.2` addressed to the VTA, issued and signed by the
 * device's UV key. It carries no evidence: the signature is the verification,
 * because the key signs only once the passkey has unsealed it.
 */
export async function buildUvConsentDecision(opts: {
  /** The device's UV key, unsealed for this one signature. */
  uvKey: SigningIdentity;
  /** The VTA's DID. */
  vtaDid: string;
  /** D: the grant digest. */
  payloadDigest: string;
}): Promise<TrustTaskEnvelope> {
  const payload: TaskConsentDecisionPayload = {
    challenge: opts.payloadDigest,
    payloadDigest: opts.payloadDigest,
    decision: "approve",
  };
  const doc = buildTrustTask(TASK_CONSENT_DECISION, payload, {
    issuer: opts.uvKey.did,
    recipient: opts.vtaDid,
  }) as unknown as TrustTaskEnvelope;
  // An approval is an attestation: `task-consent/decision` is an
  // ATTESTATION_SLUGS slug, and the VTA requires `assertionMethod`.
  return signTrustTask({ envelope: doc, signing: opts.uvKey, proofPurpose: "assertionMethod" });
}

/** The `vault/sign-trust-task/0.2` payload for a grant. */
export interface VaultSignGrantPayload {
  entryId: string;
  unsignedEnvelope: TrustTaskEnvelope;
  ext?: { [EXT_UV_CONSENT]: { decision: TrustTaskEnvelope } };
}

/**
 * Sign `auth/oob/grant` as the member. An approval needs `decision` (from
 * {@link buildUvConsentDecision}); a decline is signed without one (base
 * design §14 step 12).
 */
export async function vaultSignGrant(
  channel: TrustTaskSender,
  opts: VaultOobSignOptions & { unsignedGrant: TrustTaskEnvelope; decision?: TrustTaskEnvelope },
): Promise<TrustTaskEnvelope> {
  const payload: VaultSignGrantPayload = {
    entryId: opts.entryId,
    unsignedEnvelope: opts.unsignedGrant,
    ...(opts.decision ? { ext: { [EXT_UV_CONSENT]: { decision: opts.decision } } } : {}),
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

// ── Enrolling the UV key (device/heartbeat ext org.openvtc.uv-key) ─────────

/** `UvKeyEnrolment` with `kind: "prfSealedKey"`, as the VTA reads it. */
export interface PrfSealedUvKeyEnrolment {
  kind: "prfSealedKey";
  /** The UV key, an Ed25519 `did:key`. */
  did: string;
  /** No secure element holds it, and the VTA refuses a claim that one does. */
  hardwareBacked: false;
  /** The platform does not gate it; the passkey's PRF does, which the kind
   *  says. */
  biometricGated: false;
}

/** The enrolment for the UV key `did`. */
export function prfSealedUvKeyEnrolment(did: string): PrfSealedUvKeyEnrolment {
  return { kind: "prfSealedKey", did, hardwareBacked: false, biometricGated: false };
}

// ── Why the VTA refused a sign-in document ─────────────────────────────────

/** The device has no binding at the VTA: register it, then try again. */
export const OOB_NOT_ENROLLED_DEVICE = "oobNotEnrolledDevice";
/** The device is registered but disabled or wiped. Registering cannot fix it. */
export const OOB_DEVICE_DISABLED = "oobDeviceDisabled";
/** The device has no UV key, so it cannot approve a grant. */
export const OOB_NO_UV_KEY = "oobNoUvKey";
/** The UV decision did not verify against this device's UV key. */
export const OOB_UV_INVALID = "oobUvInvalid";

/**
 * The VTA's `vault/sign-trust-task` refusal code for a sign-in document
 * (`details.details.code`, e.g. {@link OOB_NOT_ENROLLED_DEVICE}), if `err` is
 * one. Matched on the stable code, never the message (R3.7).
 */
export function vaultOobRefusal(err: unknown): string | undefined {
  const code = (err as { details?: { details?: { code?: unknown } } })?.details?.details?.code;
  return typeof code === "string" && code.startsWith("oob") ? code : undefined;
}

/**
 * Enrol (or replace) the device's UV key, over the device's own session —
 * the VTA accepts a replacement only from the device's transport key.
 *
 * `device/heartbeat/0.2` with `payload.ext["org.openvtc.uv-key"]` for a device
 * the VTA already has a binding for. A device that never registered (the
 * heartbeat answers `not_found`) is registered with `device/register/0.2`,
 * carrying the same extension; re-registering a bound device is a conflict,
 * which is why the heartbeat goes first.
 */
export async function enrolUvKey(
  sender: TrustTaskSender,
  params: {
    holder: TaskParty;
    service: TaskParty;
    enrolment: PrfSealedUvKeyEnrolment;
    /** Shown to the operator if this enrolment has to register the device. */
    displayName: string;
  },
): Promise<void> {
  const ext = { [EXT_UV_KEY]: params.enrolment } as unknown as NonNullable<DeviceHeartbeatPayload["ext"]>;
  const parties = { issuer: params.holder.did, recipient: params.service.did };
  try {
    const payload: DeviceHeartbeatPayload = { ext };
    await sender.send<DeviceHeartbeatResponsePayload>(buildTrustTask(DEVICE_HEARTBEAT, payload, parties), {
      expectedResponseType: DEVICE_HEARTBEAT_RESPONSE,
      operationLabel: "device/heartbeat/0.2 (uv-key)",
    });
    return;
  } catch (err) {
    if (taskRefusalReason(err) !== TASK_REFUSAL_NOT_FOUND) throw err;
  }
  const payload: DeviceRegisterPayload = {
    consumerKind: { kind: "companion", formFactor: "browser" },
    displayName: params.displayName,
    ext,
  };
  await sender.send<DeviceRegisterResponsePayload>(buildTrustTask(DEVICE_REGISTER, payload, parties), {
    expectedResponseType: DEVICE_REGISTER_RESPONSE,
    operationLabel: "device/register/0.2 (uv-key)",
  });
}
