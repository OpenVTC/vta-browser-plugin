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
 *  {@link TrustTaskErrorPayload}. The 0.1 form; later framework versions emit
 *  {@link TRUST_TASK_ERROR_TYPE_0_2} or {@link TRUST_TASK_ERROR_TYPE_0_3}. Use
 *  {@link isTrustTaskErrorType} to match any of them on the wire. */
export const TRUST_TASK_ERROR_TYPE =
  "https://trusttasks.org/spec/trust-task-error/0.1";

/** 0.2 framework error-document `type`. Same payload shape as 0.1 except the
 *  `code` enum is lowerCamelCase (`permissionDenied` vs `permission_denied`). */
export const TRUST_TASK_ERROR_TYPE_0_2 =
  "https://trusttasks.org/spec/trust-task-error/0.2";

/** 0.3 framework error-document `type` — what `trust-tasks-rs` ≥ 0.3 emits for
 *  every rejection. Adds the §8.2 `inResponseTo` member (0.2's payload schema
 *  is `additionalProperties: false`, so a document carrying it cannot claim to
 *  be 0.2); the members this wallet reads are unchanged. */
export const TRUST_TASK_ERROR_TYPE_0_3 =
  "https://trusttasks.org/spec/trust-task-error/0.3";

/**
 * True for a framework error-document `type` of any minor version.
 *
 * **Match the slug, not a fixed list of versions.** This used to enumerate 0.1
 * and 0.2, which stopped matching the moment the VTA moved to `trust-tasks-rs`
 * 0.3 and began emitting `trust-task-error/0.3` — and the failure mode is the
 * worst one available: an unrecognised error document is not an error here, it
 * is a *success*. `parseTrustTaskReply` returns its payload as the operation's
 * result, so every VTA rejection arrived at the caller as a completed
 * operation. A `dids/update` the VTA refused reported "published" in the
 * relying party's UI, and — because a `requireConsent` refusal is also an error
 * document — a task awaiting human approval resolved as *done*, so the consent
 * ceremony never rendered and no approver was ever asked.
 *
 * SPEC.md §5.2's forward-minor rule says a 0.2 consumer SHOULD accept a 0.3
 * document; honouring it by slug means the next minor cannot break this the
 * same way. A *major* bump (`trust-task-error/1.x`) is deliberately excluded —
 * that is where the payload shape may genuinely change.
 */
export function isTrustTaskErrorType(type: string | undefined): boolean {
  if (typeof type !== "string") return false;
  return /^https:\/\/trusttasks\.org\/spec\/trust-task-error\/0\.\d+$/.test(type);
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

/** Payload of a `trust-task-error/0.x` document. `code` is a framework
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
