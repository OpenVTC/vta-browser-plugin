// The VTA signs the member's two wallet sign-in documents, and learns the
// device's user-verification passkey.
//
// The shapes are the VTA's (verifiable-trust-infrastructure
// `feat/oob-sign-in-vta`: `vta-service/src/operations/vault/oob_sign_in.rs`,
// `vta-sdk/src/protocols/device_management.rs`) and contract C9:
//
//   - `identify` and `grant` both go through `vault/sign-trust-task/0.2` with
//     payload `{entryId, unsignedEnvelope}`. The envelope carries framework
//     members only — no `ext` — and an `issuedAt` within 300 s of the VTA's
//     clock. `identify` needs nothing more.
//   - A grant approval adds `payload.ext["org.openvtc.uv-consent"].decision`:
//     a `task-consent/decision/0.2` addressed to the VTA, issued and signed
//     (for `assertionMethod`) by the device's transport `did:key`, with
//     payload `{challenge: D, payloadDigest: D, decision: "approve",
//     evidence: {kind: "webauthn", assertion}}`, where D is the grant digest
//     (`grantDigest` in `vtc/oob-sign-in.ts`) and the passkey's WebAuthn
//     challenge is the **UTF-8 bytes of the string D**.
//   - The passkey is enrolled with `device/heartbeat/0.2` (or
//     `device/register/0.2`) `payload.ext["org.openvtc.uv-key"]`, sent over
//     the device's own transport-key session. It must be ES256 (P-256):
//     `vti-webauthn` verifies nothing else.
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
import { base58btcEncode } from "../trust-tasks/canonical.js";
import { vaultSignTrustTask } from "./sign-trust-task.js";
import { TASK_REFUSAL_NOT_FOUND, taskRefusalReason } from "../vta/errors.js";

import {
  TYPE_URI as TASK_VAULT_SIGN_TRUST_TASK,
  RESPONSE_TYPE_URI as TASK_VAULT_SIGN_TRUST_TASK_RESPONSE,
} from "@openvtc/trust-tasks/vault/sign-trust-task/0.2/payload";
import {
  TYPE_URI as TASK_CONSENT_DECISION,
  type AuthenticatorAssertionResponseLogin,
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

export type { AuthenticatorAssertionResponseLogin };

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
 * The WebAuthn challenge for a grant: the UTF-8 bytes of the digest string D.
 * Not the 32 hash bytes inside it — the VTA verifies the assertion against
 * `challenge.as_bytes()`.
 */
export function uvChallengeBytes(payloadDigest: string): Uint8Array {
  return new TextEncoder().encode(payloadDigest);
}

/**
 * The device's user-verification decision over the unsigned grant: a
 * `task-consent/decision/0.2` addressed to the VTA, issued and signed by the
 * device's transport key, carrying the passkey's assertion as evidence.
 */
export async function buildUvConsentDecision(opts: {
  /** The device's transport key — the identity the VTA session authenticates. */
  device: SigningIdentity;
  /** The VTA's DID. */
  vtaDid: string;
  /** D: the grant digest. */
  payloadDigest: string;
  assertion: AuthenticatorAssertionResponseLogin;
}): Promise<TrustTaskEnvelope> {
  const payload: TaskConsentDecisionPayload = {
    challenge: opts.payloadDigest,
    payloadDigest: opts.payloadDigest,
    decision: "approve",
    evidence: { kind: "webauthn", assertion: opts.assertion },
  };
  const doc = buildTrustTask(TASK_CONSENT_DECISION, payload, {
    issuer: opts.device.did,
    recipient: opts.vtaDid,
  }) as unknown as TrustTaskEnvelope;
  // An approval is an attestation: `task-consent/decision` is an
  // ATTESTATION_SLUGS slug, and the VTA requires `assertionMethod`.
  return signTrustTask({ envelope: doc, signing: opts.device, proofPurpose: "assertionMethod" });
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

// ── Enrolling the passkey (device/heartbeat ext org.openvtc.uv-key) ─────────

/** `UvKeyEnrolment` with `kind: "webauthn"`, as the VTA reads it. */
export interface WebauthnUvKeyEnrolment {
  kind: "webauthn";
  /** base64url, no padding. */
  credentialId: string;
  /** P-256 Multikey, `zDn…`. */
  publicKeyMultibase: string;
  /** For an extension, its runtime id. */
  rpId: string;
  /** `chrome-extension://<id>` — what `clientDataJSON.origin` carries. */
  origin: string;
  hardwareBacked: boolean;
  biometricGated: boolean;
}

/**
 * A P-256 public key as a Multikey (`zDn…`): the 33-byte compressed point
 * behind the `p256-pub` multicodec (0x1200, varint `0x80 0x24`), base58btc.
 * Accepts the 65-byte uncompressed point or the 33-byte compressed one.
 */
export function p256Multikey(point: Uint8Array): string {
  let compressed: Uint8Array;
  if (point.length === 33 && (point[0] === 0x02 || point[0] === 0x03)) {
    compressed = point;
  } else if (point.length === 65 && point[0] === 0x04) {
    compressed = new Uint8Array(33);
    compressed[0] = (point[64]! & 1) === 0 ? 0x02 : 0x03;
    compressed.set(point.subarray(1, 33), 1);
  } else {
    throw new Error("not a P-256 public key point");
  }
  const out = new Uint8Array(35);
  out.set([0x80, 0x24], 0);
  out.set(compressed, 2);
  return `z${base58btcEncode(out)}`;
}

const P256_SPKI_PREFIX = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/**
 * The uncompressed P-256 point inside a SubjectPublicKeyInfo (what
 * `AuthenticatorAttestationResponse.getPublicKey()` returns for ES256).
 */
export function p256PointFromSpki(spki: Uint8Array): Uint8Array {
  // SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (0x00 ‖
  // the 65-byte uncompressed point) }: a fixed 26-byte prefix, then the point.
  if (spki.length !== 91 || P256_SPKI_PREFIX.some((b, i) => spki[i] !== b) || spki[26] !== 0x04) {
    throw new Error("not a P-256 SubjectPublicKeyInfo");
  }
  return spki.slice(26);
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
 * Enrol (or replace) the device's UV passkey, over the device's own session —
 * the VTA accepts a replacement only from the device's transport key.
 *
 * `device/heartbeat/0.2` with `payload.ext["org.openvtc.uv-key"]` for a device
 * the VTA already has a binding for. A device that never registered (the
 * heartbeat answers `not_found`) is registered with `device/register/0.2`,
 * carrying the same extension; re-registering a bound device is a conflict,
 * which is why the heartbeat goes first.
 */
export async function enrolUvPasskey(
  sender: TrustTaskSender,
  params: {
    holder: TaskParty;
    service: TaskParty;
    enrolment: WebauthnUvKeyEnrolment;
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
