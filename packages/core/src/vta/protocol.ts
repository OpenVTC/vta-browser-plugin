/**
 * Trust-Tasks passkey-VM management over DIDComm.
 *
 * The VTA exposes passkey verification-method enrollment as Trust-Tasks
 * under the `trusttasks.org` namespace. Over DIDComm they ride the
 * framework binding (`https://trusttasks.org/binding/didcomm/0.1`): every
 * request is a single reserved DIDComm message type
 * ({@link TRUST_TASK_ENVELOPE_TYPE}) whose `body` is a full `TrustTask`
 * document; the document's own `type` selects the operation. Replies are
 * also binding envelopes whose body is the framework response document
 * (success) or a `trust-task-error/0.1` document (failure), correlated by
 * the DIDComm `thid`.
 */

/** DIDComm message `type` for every Trust-Task envelope. The body is a
 *  {@link TrustTask} document. Conformant peers reject any other type. */
export const TRUST_TASK_ENVELOPE_TYPE =
  "https://trusttasks.org/binding/didcomm/0.1/envelope";

/** Framework error-document `type` — a `TrustTask` whose payload is a
 *  {@link TrustTaskErrorPayload}. The 0.1 form; a 0.2-capable peer emits
 *  {@link TRUST_TASK_ERROR_TYPE_0_2}. Use {@link isTrustTaskErrorType} to
 *  match either on the wire. */
export const TRUST_TASK_ERROR_TYPE =
  "https://trusttasks.org/spec/trust-task-error/0.1";

/** 0.2 framework error-document `type`. Same payload shape as 0.1 except the
 *  `code` enum is lowerCamelCase (`permissionDenied` vs `permission_denied`). */
export const TRUST_TASK_ERROR_TYPE_0_2 =
  "https://trusttasks.org/spec/trust-task-error/0.2";

/** True for either the 0.1 or 0.2 framework error-document `type`. */
export function isTrustTaskErrorType(type: string | undefined): boolean {
  return type === TRUST_TASK_ERROR_TYPE || type === TRUST_TASK_ERROR_TYPE_0_2;
}

const PASSKEY_VMS = "https://trusttasks.org/spec/vta/passkey-vms";

/** Trust-task operation type URIs — the value of a request envelope's
 *  `type` field (NOT the DIDComm message type, which is always
 *  {@link TRUST_TASK_ENVELOPE_TYPE}).
 *
 *  Version `0.1` — the published spec version (was the pre-spec `/1.0`).
 *  Payloads are field-identical to the old `/1.0`; the VTA dual-accepts
 *  both (vta-sdk ≥ 0.10.0) and `/1.0` is deprecated there. */
export const PasskeyVmTask = {
  enrollChallenge: `${PASSKEY_VMS}/enroll-challenge/0.1`,
  enrollSubmit: `${PASSKEY_VMS}/enroll-submit/0.1`,
  list: `${PASSKEY_VMS}/list/0.1`,
  revoke: `${PASSKEY_VMS}/revoke/0.1`,
} as const;

export type PasskeyVmTaskType =
  (typeof PasskeyVmTask)[keyof typeof PasskeyVmTask];

/**
 * A Trust-Task document — the DIDComm message body. Field names are the
 * canonical camelCase wire form (`trust_tasks_rs::TrustTask`).
 */
export interface TrustTask<P> {
  id: string;
  type: string;
  issuer?: string;
  recipient?: string;
  threadId?: string;
  issuedAt?: string;
  expiresAt?: string;
  payload: P;
}

/** Payload of a `trust-task-error/{0.1,0.2}` document. `code` is a framework
 *  status — snake_case in 0.1 (`permission_denied`, `malformed_request`,
 *  `task_failed`, `unsupported_type`, `internal_error`, …) and lowerCamelCase
 *  in 0.2 (`permissionDenied`, …). Treat it as an opaque string; do not
 *  branch on a specific casing. */
export interface TrustTaskErrorPayload {
  code: string;
  message?: string;
  /** REQUIRED by the framework error schema (`required: ["code",
   *  "retryable"]`). Whether retrying the same request may succeed. */
  retryable: boolean;
  /** RFC 3339 instant before which a retry SHOULD NOT be attempted. */
  retryAfter?: string;
  /** Task-specific structured context (e.g. `{ reason:
   *  "cleartext_schema_invalid" }` on a `vault/upsert:sealed_secret_invalid`
   *  reject). Shape is defined per Trust-Task spec. */
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Request payloads (the TrustTask `payload`). Mirror the VTA SDK body
// shapes in vta-sdk::protocols::did_management::passkey_vms.
// ---------------------------------------------------------------------------

export interface EnrollChallengePayload {
  did: string;
  label?: string;
}

export interface EnrollSubmitPayload {
  did: string;
  ceremonyId: string;
  credentialId: string;
  publicKeyMultibase: string;
  coseAlgorithm: number;
  attestationObject: string;
  clientDataJson: string;
  authenticatorData: string;
  transports: AuthenticatorTransport[];
  label?: string;
}

export interface ListPayload {
  did: string;
}

export interface RevokePayload {
  did: string;
  fragment: string;
}

// ---------------------------------------------------------------------------
// Response payloads (the success document's `payload`). Re-use the shared
// wire types so the REST + DIDComm transports stay identical.
// ---------------------------------------------------------------------------

export type {
  EnrollmentChallengeResponse as EnrollChallengeResult,
  EnrollmentSubmitResponse as EnrollSubmitResult,
  PasskeyList as ListResult,
} from "./types.js";
