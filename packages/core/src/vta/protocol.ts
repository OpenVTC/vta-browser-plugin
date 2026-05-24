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
 *  {@link TrustTaskErrorPayload}. */
export const TRUST_TASK_ERROR_TYPE =
  "https://trusttasks.org/spec/trust-task-error/0.1";

const PASSKEY_VMS = "https://trusttasks.org/spec/vta/passkey-vms";

/** Trust-task operation type URIs — the value of a request envelope's
 *  `type` field (NOT the DIDComm message type, which is always
 *  {@link TRUST_TASK_ENVELOPE_TYPE}). */
export const PasskeyVmTask = {
  enrollChallenge: `${PASSKEY_VMS}/enroll-challenge/1.0`,
  enrollSubmit: `${PASSKEY_VMS}/enroll-submit/1.0`,
  list: `${PASSKEY_VMS}/list/1.0`,
  revoke: `${PASSKEY_VMS}/revoke/1.0`,
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

/** Payload of a `trust-task-error/0.1` document. `code` is a snake_case
 *  framework status (`permission_denied`, `malformed_request`,
 *  `task_failed`, `unsupported_type`, `internal_error`, …). */
export interface TrustTaskErrorPayload {
  code: string;
  message?: string;
  retryable?: boolean;
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
