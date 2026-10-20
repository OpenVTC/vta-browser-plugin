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
//   - A browser with no PRF passkey enrols one of two other kinds instead:
//       `vtaPin`          a PIN the VTA checks (`uv-pin.ts`). The decision is
//                         signed by the device's transport key (the holder),
//                         and `ext["org.openvtc.uv-consent"]` adds `pinProof`.
//       `remoteApprover`  the person's phone approves. The browser sends
//                         `ext["org.openvtc.uv-consent"] = {remote: true}` and
//                         no decision, and re-sends it while the VTA answers
//                         `oobUvPending`.
//     Replacing a `vtaPin` key needs `ext["org.openvtc.uv-key-change"]`, a
//     proof made with the current PIN.
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
import { bytesToBase64url } from "../util/base64url.js";

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
/** `payload.ext` member proving the current PIN when a `vtaPin` UV key is
 *  replaced. */
export const EXT_UV_KEY_CHANGE = "org.openvtc.uv-key-change";

/**
 * The task listing the devices this one may name as its `remoteApprover`
 * (`[{did, displayName?, formFactor?}]`). It must match the URI the VTA serves;
 * this is the one place the wallet names it.
 */
export const TASK_DEVICE_UV_APPROVERS = "https://trusttasks.org/openvtc/device/uv-approvers/0.1";

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
 * `task-consent/decision/0.2` addressed to the VTA, with payload
 * `{challenge: D, payloadDigest: D, decision: "approve"}` and no evidence.
 *
 * For `prfSealedKey` it is issued and signed by the device's UV key: the
 * signature is the verification, because the key signs only once the passkey
 * has unsealed it. For `vtaPin` it is issued and signed by the device's
 * transport key (the holder), and the PIN proof beside it is the verification.
 */
export async function buildUvConsentDecision(opts: {
  /** The device's UV key unsealed for this one signature (`prfSealedKey`),
   *  or the device's transport key (`vtaPin`). */
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

/**
 * `ext["org.openvtc.uv-consent"]` on a grant approval, by the device's UV key
 * kind:
 *   - `prfSealedKey`: `{decision}` signed by the UV key;
 *   - `vtaPin`: `{decision, pinProof}`, the decision signed by the device's
 *     transport key;
 *   - `remoteApprover`: `{remote: true}`, no decision: the phone decides.
 */
export type UvConsent =
  | { decision: TrustTaskEnvelope }
  | { decision: TrustTaskEnvelope; pinProof: string }
  | { remote: true };

/** The `vault/sign-trust-task/0.2` payload for a grant. */
export interface VaultSignGrantPayload {
  entryId: string;
  unsignedEnvelope: TrustTaskEnvelope;
  ext?: { [EXT_UV_CONSENT]: UvConsent };
}

/**
 * Sign `auth/oob/grant` as the member. An approval needs `consent`; a decline
 * is signed without one (base design §14 step 12).
 */
export async function vaultSignGrant(
  channel: TrustTaskSender,
  opts: VaultOobSignOptions & { unsignedGrant: TrustTaskEnvelope; consent?: UvConsent },
): Promise<TrustTaskEnvelope> {
  const payload: VaultSignGrantPayload = {
    entryId: opts.entryId,
    unsignedEnvelope: opts.unsignedGrant,
    ...(opts.consent ? { ext: { [EXT_UV_CONSENT]: opts.consent } } : {}),
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

/** `UvKeyEnrolment` with `kind: "vtaPin"`: the VTA checks a PIN. */
export interface VtaPinUvKeyEnrolment {
  kind: "vtaPin";
  /** base64url, 16..64 bytes. */
  salt: string;
  /** PBKDF2 iterations, at least 600 000. */
  iterations: number;
  /** base64url of K, exactly 32 bytes. A password equivalent: sent once, at
   *  enrolment, and never kept. */
  verifier: string;
  hardwareBacked: false;
  biometricGated: false;
}

/** The enrolment for a PIN whose derived key is `verifier` (`uv-pin.ts`). */
export function vtaPinUvKeyEnrolment(p: {
  salt: Uint8Array;
  iterations: number;
  verifier: Uint8Array;
}): VtaPinUvKeyEnrolment {
  return {
    kind: "vtaPin",
    salt: bytesToBase64url(p.salt),
    iterations: p.iterations,
    verifier: bytesToBase64url(p.verifier),
    hardwareBacked: false,
    biometricGated: false,
  };
}

/** `UvKeyEnrolment` with `kind: "remoteApprover"`: the person's phone
 *  approves. */
export interface RemoteApproverUvKeyEnrolment {
  kind: "remoteApprover";
  /** The phone's DID: one of {@link listUvApprovers}. */
  approver: string;
  hardwareBacked: false;
  biometricGated: false;
}

export function remoteApproverUvKeyEnrolment(approverDid: string): RemoteApproverUvKeyEnrolment {
  return { kind: "remoteApprover", approver: approverDid, hardwareBacked: false, biometricGated: false };
}

/** Every kind of UV key a browser enrols. */
export type UvKeyEnrolment = PrfSealedUvKeyEnrolment | VtaPinUvKeyEnrolment | RemoteApproverUvKeyEnrolment;
export type UvKeyKind = UvKeyEnrolment["kind"];

// ── Why the VTA refused a sign-in document ─────────────────────────────────

/** The device has no binding at the VTA: register it, then try again. */
export const OOB_NOT_ENROLLED_DEVICE = "oobNotEnrolledDevice";
/** The device is registered but disabled or wiped. Registering cannot fix it. */
export const OOB_DEVICE_DISABLED = "oobDeviceDisabled";
/** The device has no UV key, so it cannot approve a grant. */
export const OOB_NO_UV_KEY = "oobNoUvKey";
/** The UV decision did not verify against this device's UV key. */
export const OOB_UV_INVALID = "oobUvInvalid";
/** `vtaPin`: the PIN proof was wrong (`attemptsRemaining`). */
export const OOB_UV_PIN_WRONG = "oobUvPinWrong";
/** `vtaPin`: too many wrong PINs; locked until `lockedUntil` (epoch s). */
export const OOB_UV_LOCKED = "oobUvLocked";
/** `remoteApprover`: the phone has been asked and has not answered yet
 *  (`matchCode`, `expiresAt`). Send the same request again to poll. */
export const OOB_UV_PENDING = "oobUvPending";
/** `remoteApprover`: the phone declined. */
export const OOB_UV_DECLINED = "oobUvDeclined";
/** `remoteApprover`: the phone did not answer in time. */
export const OOB_UV_EXPIRED = "oobUvExpired";

/** A refusal of a sign-in document, with what the VTA said beside its code. */
export interface VaultOobRefusalDetail {
  code: string;
  /** `oobUvPinWrong`: wrong PINs left before the next lock. */
  attemptsRemaining?: number;
  /** `oobUvLocked`: epoch seconds. */
  lockedUntil?: number;
  /** `oobUvPending`: the code the phone shows beside the request. */
  matchCode?: string;
  /** `oobUvPending`: when the request to the phone lapses, epoch seconds. */
  expiresAt?: number;
}

/**
 * The VTA's `vault/sign-trust-task` refusal code for a sign-in document
 * (`details.details.code`, e.g. {@link OOB_NOT_ENROLLED_DEVICE}), if `err` is
 * one. Matched on the stable code, never the message (R3.7).
 */
export function vaultOobRefusal(err: unknown): string | undefined {
  return vaultOobRefusalDetail(err)?.code;
}

/** {@link vaultOobRefusal}, with the details the VTA gives for the UV codes. */
export function vaultOobRefusalDetail(err: unknown): VaultOobRefusalDetail | undefined {
  const d = (err as { details?: { details?: Record<string, unknown> } })?.details?.details;
  const code = d?.code;
  if (typeof code !== "string" || !code.startsWith("oob")) return undefined;
  return { code, ...uvRefusalFields(d!) };
}

function uvRefusalFields(d: Record<string, unknown>): Omit<VaultOobRefusalDetail, "code"> {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: Omit<VaultOobRefusalDetail, "code"> = {};
  const attemptsRemaining = num(d.attemptsRemaining);
  const lockedUntil = num(d.lockedUntil);
  const expiresAt = num(d.expiresAt);
  if (attemptsRemaining !== undefined) out.attemptsRemaining = attemptsRemaining;
  if (lockedUntil !== undefined) out.lockedUntil = lockedUntil;
  if (typeof d.matchCode === "string") out.matchCode = d.matchCode;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  return out;
}

/** `device/heartbeat` refused replacing a `vtaPin` UV key: the current-PIN
 *  proof was wrong. */
export const DEVICE_UV_PIN_WRONG = "uvPinWrong";
/** `device/heartbeat` refused replacing a `vtaPin` UV key: locked. */
export const DEVICE_UV_KEY_LOCKED = "uvKeyLocked";

/**
 * Why `device/heartbeat` refused a UV key change: `uvPinWrong` (with
 * `attemptsRemaining`) or `uvKeyLocked` (with `lockedUntil`), from the
 * refusal's code (`device:uvPinWrong`, `device/heartbeat:uvKeyLocked`, …).
 */
export function deviceUvRefusal(err: unknown): VaultOobRefusalDetail | undefined {
  const e = err as { details?: { code?: unknown; details?: Record<string, unknown> } } | undefined;
  const d = e?.details?.details ?? {};
  for (const raw of [d.code, e?.details?.code]) {
    if (typeof raw !== "string") continue;
    const code = raw.slice(raw.lastIndexOf(":") + 1);
    if (code === DEVICE_UV_PIN_WRONG || code === DEVICE_UV_KEY_LOCKED) return { code, ...uvRefusalFields(d) };
  }
  return undefined;
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
    enrolment: UvKeyEnrolment;
    /** Shown to the operator if this enrolment has to register the device. */
    displayName: string;
    /** Replacing a `vtaPin` UV key: {@link pinChangeProof} with the current
     *  PIN, over this `enrolment`. */
    changeProof?: string;
  },
): Promise<void> {
  const ext = {
    [EXT_UV_KEY]: params.enrolment,
    ...(params.changeProof ? { [EXT_UV_KEY_CHANGE]: { pinProof: params.changeProof } } : {}),
  } as unknown as NonNullable<DeviceHeartbeatPayload["ext"]>;
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
  // A device the VTA does not know has no UV key to replace: no change proof.
  const payload: DeviceRegisterPayload = {
    consumerKind: { kind: "companion", formFactor: "browser" },
    displayName: params.displayName,
    ext: { [EXT_UV_KEY]: params.enrolment } as unknown as NonNullable<DeviceRegisterPayload["ext"]>,
  };
  await sender.send<DeviceRegisterResponsePayload>(buildTrustTask(DEVICE_REGISTER, payload, parties), {
    expectedResponseType: DEVICE_REGISTER_RESPONSE,
    operationLabel: "device/register/0.2 (uv-key)",
  });
}

// ── Which devices may approve for this one ─────────────────────────────────

/** A device this browser may name as its `remoteApprover`. */
export interface UvApprover {
  did: string;
  displayName?: string;
  formFactor?: string;
}

/**
 * The devices this browser may name as its `remoteApprover`
 * ({@link TASK_DEVICE_UV_APPROVERS}), over the device's own session. The VTA
 * decides who qualifies (the person's own phone); this only lists.
 */
export async function listUvApprovers(
  sender: TrustTaskSender,
  params: { holder: TaskParty; service: TaskParty },
): Promise<UvApprover[]> {
  const res = await sender.send<{ approvers?: unknown }>(
    buildTrustTask(TASK_DEVICE_UV_APPROVERS, {}, { issuer: params.holder.did, recipient: params.service.did }),
    { expectedResponseType: `${TASK_DEVICE_UV_APPROVERS}#response`, operationLabel: "device/uv-approvers" },
  );
  const list = Array.isArray(res?.approvers) ? res.approvers : [];
  const out: UvApprover[] = [];
  for (const a of list) {
    const r = a as { did?: unknown; displayName?: unknown; formFactor?: unknown } | null;
    if (typeof r?.did !== "string" || !r.did.startsWith("did:")) continue;
    out.push({
      did: r.did,
      ...(typeof r.displayName === "string" ? { displayName: r.displayName } : {}),
      ...(typeof r.formFactor === "string" ? { formFactor: r.formFactor } : {}),
    });
  }
  return out;
}
