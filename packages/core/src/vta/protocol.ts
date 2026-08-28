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

import {
  TYPE_URI as ENROLL_CHALLENGE_TYPE,
  type VTAPasskeyVMEnrollChallengePayload,
} from "@openvtc/trust-tasks/vta/passkey-vms/enroll-challenge/0.1/payload";
import {
  TYPE_URI as ENROLL_SUBMIT_TYPE,
  type VTAPasskeyVMEnrollSubmitPayload,
} from "@openvtc/trust-tasks/vta/passkey-vms/enroll-submit/0.1/payload";
import {
  TYPE_URI as LIST_TYPE,
  type VTAPasskeyVMListPayload,
} from "@openvtc/trust-tasks/vta/passkey-vms/list/0.1/payload";
import {
  TYPE_URI as REVOKE_TYPE,
  type VTAPasskeyVMRevokePayload,
} from "@openvtc/trust-tasks/vta/passkey-vms/revoke/0.1/payload";

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

/** 0.3 framework error-document `type`. Adds the §8.2 `inResponseTo` member
 *  (0.2's payload schema is `additionalProperties: false`, so a document
 *  carrying it cannot claim to be 0.2); the members this wallet reads are
 *  unchanged.
 *
 *  **These three named constants are historical, not a list to keep current.**
 *  The framework has since gone to 0.4 and 0.5, and a current peer emits
 *  {@link TRUST_TASK_ERROR_TYPE_URI}. Matching is done by
 *  {@link isTrustTaskErrorType} on the slug, so no version needs adding here
 *  to be recognised — which is the entire reason that predicate stopped
 *  enumerating. */
export const TRUST_TASK_ERROR_TYPE_0_3 =
  "https://trusttasks.org/spec/trust-task-error/0.3";

/**
 * The `trust-task-error` version a **current** peer emits — re-exported from
 * the framework runtime rather than spelled out again here.
 *
 * `@openvtc/trust-tasks`'s runtime and `trust-tasks-rs` both build their error
 * documents at this version, and the package documents it as the single source
 * of truth on the producing side precisely because three different answers had
 * been in circulation (the runtime emitted one version, the HTTPS server
 * another, the READMEs a third). Taking it from there means this constant
 * cannot drift from what the agent actually sends.
 *
 * It is `0.5` at the time of writing, and that number is deliberately not
 * repeated in this file. Nothing on the *read* path branches on it —
 * {@link isTrustTaskErrorType} matches the slug across every 0.x — so this is
 * for a caller that needs to name the version (a test fixture, a document this
 * library produces), not for recognising one.
 */
export { TRUST_TASK_ERROR_TYPE_URI } from "@openvtc/trust-tasks/_runtime/document";

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

/** Trust-task operation type URIs — the value of a request envelope's
 *  `type` field (NOT the DIDComm message type, which is always
 *  {@link TRUST_TASK_ENVELOPE_TYPE}).
 *
 *  **Taken from the generated bindings, not assembled from a slug and a version
 *  here.** These used to be built by template from a `PASSKEY_VMS` prefix, and
 *  a URI assembled that way is well-formed whatever version string it carries —
 *  so a family that moves (as `vtc/join-requests/submit` did, 0.1 → 0.2) still
 *  produces a URI the agent has simply never heard of, and the mistake arrives
 *  at a user as a rejected request. Importing `TYPE_URI` makes the version part
 *  of what the registry publishes, so the same drift is a compile error.
 *
 *  Version `0.1` — the published spec version (was the pre-spec `/1.0`).
 *  Payloads are field-identical to the old `/1.0`; the VTA dual-accepts
 *  both (vta-sdk ≥ 0.10.0) and `/1.0` is deprecated there. */
export const PasskeyVmTask = {
  enrollChallenge: ENROLL_CHALLENGE_TYPE,
  enrollSubmit: ENROLL_SUBMIT_TYPE,
  list: LIST_TYPE,
  revoke: REVOKE_TYPE,
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
   *  "cleartext_schema_invalid" }` on a `vault/upsert:sealedSecretInvalid`
   *  reject). Shape is defined per Trust-Task spec.
   *
   *  An extended code in here is spelled as the registry declares it —
   *  lowerCamelCase, SPEC §4.10 rule 4. Plain `===` is the right comparison. */
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Request payloads (the TrustTask `payload`).
//
// Aliases of the generated bindings, which are compiled from the same JSON
// Schemas the agent's own implementation is generated from — so these are the
// specification's shapes rather than a copy of them that has to be kept equal
// by hand. The names are kept because they are this package's published API.
//
// The hand-written versions had drifted in one member that a copy cannot help
// drifting in: `transports` was typed `AuthenticatorTransport[]` and REQUIRED.
// The schema says optional, and calls it an advisory hint — so a caller with no
// transport hints to give had to invent an empty array to satisfy a type this
// library made up. `AuthenticatorTransport` is also a DOM lib type, which had
// no business in the transport-free layer of a package whose every entry point
// is asserted to import under plain Node.
// ---------------------------------------------------------------------------

export type EnrollChallengePayload = VTAPasskeyVMEnrollChallengePayload;
export type EnrollSubmitPayload = VTAPasskeyVMEnrollSubmitPayload;
export type ListPayload = VTAPasskeyVMListPayload;
export type RevokePayload = VTAPasskeyVMRevokePayload;

// ---------------------------------------------------------------------------
// Response payloads (the success document's `payload`). Re-use the shared
// wire types so the REST + DIDComm transports stay identical.
// ---------------------------------------------------------------------------

export type {
  EnrollmentChallengeResponse as EnrollChallengeResult,
  EnrollmentSubmitResponse as EnrollSubmitResult,
  PasskeyList as ListResult,
} from "./types.js";
