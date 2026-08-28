// Layer 0 — transport-free Trust-Task envelope logic.
//
// Every VTA operation, on every transport (TSP, DIDComm, REST), is the same
// canonical Trust-Task document: `{ id, type, issuer?, recipient?, issuedAt,
// payload }`. The only things that differ per transport are auth, how the
// bytes are carried, how the reply is correlated, and the outer framing —
// none of which live here. This module owns the two pieces every transport
// shares:
//
//   - `buildTrustTask`     — construct the request envelope.
//   - `parseTrustTaskReply` — turn a reply document into a typed payload, or
//                             throw a normalized `VtaClientError` for a
//                             `trust-task-error/0.x` document.
//
// A `TrustTaskChannel` (see `channel.ts`) builds a request with the former
// and hands the decoded reply document to the latter; the channel itself only
// deals with transport concerns.

import { isStandardCode, normalizeCode } from "@openvtc/trust-tasks/_runtime/codes";

import { VtaClientError, type VtaErrorCode } from "./errors.js";
import {
  isTrustTaskErrorType,
  type TrustTask,
  type TrustTaskErrorPayload,
} from "./protocol.js";

export interface BuildTrustTaskOptions {
  /** Envelope id — also the correlation id for async transports. Defaults to
   *  a fresh UUID. */
  id?: string;
  /** Issuer DID (the caller). Set on authenticated requests. */
  issuer?: string;
  /** Recipient DID (the maintainer/VTA). Audience-binds the document. */
  recipient?: string;
  /** RFC 3339 issue time. Defaults to now. */
  issuedAt?: string;
  /** Thread id, when the task participates in a multi-message exchange. */
  threadId?: string;
  /** RFC 3339 expiry, when the task carries one. */
  expiresAt?: string;
}

/**
 * Build a canonical Trust-Task request envelope. Transport-neutral: the same
 * document is authcrypted (DIDComm), sealed (TSP), or POSTed (REST) unchanged.
 */
export function buildTrustTask<P>(
  type: string,
  payload: P,
  opts: BuildTrustTaskOptions = {},
): TrustTask<P> {
  const envelope: TrustTask<P> = {
    id: opts.id ?? globalThis.crypto.randomUUID(),
    type,
    ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
    ...(opts.recipient !== undefined ? { recipient: opts.recipient } : {}),
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
    issuedAt: opts.issuedAt ?? new Date().toISOString(),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    payload,
  };
  return envelope;
}

export interface ParseTrustTaskReplyOptions {
  /** Expected response document `type` (the `<request>#response` URI). When
   *  set, a reply whose `type` is neither this nor a trust-task-error is a
   *  protocol error. Omit to accept any non-error response type (the DIDComm
   *  binding path does this — the binding envelope already vouches for the
   *  message). */
  expectedResponseType?: string;
  /** Label used to enrich the "unexpected type" error (defaults to the
   *  response type). */
  operationLabel?: string;
}

/** Reply document shape — a `TrustTask` whose `payload` is either the
 *  operation result or a {@link TrustTaskErrorPayload}. */
type ReplyDocument = { type?: string; payload?: unknown };

/**
 * Decode a Trust-Task reply document into its typed payload.
 *
 * - A `trust-task-error/0.x` document throws a `VtaClientError` whose
 *   `code` is the coerced typed {@link VtaErrorCode}, whose `message` is the
 *   framework's human message, and whose `details` is the raw error payload
 *   (so callers can still read the framework `code`, `retryable`, etc.).
 * - Otherwise the `payload` is returned as `Res` (validated against
 *   `expectedResponseType` first, when one is supplied).
 */
export function parseTrustTaskReply<Res>(
  doc: TrustTask<unknown> | ReplyDocument,
  opts: ParseTrustTaskReplyOptions = {},
): Res {
  if (isTrustTaskErrorType(doc.type)) {
    const err = (doc.payload ?? {}) as TrustTaskErrorPayload;
    throw new VtaClientError(
      coerceTrustTaskCode(err.code),
      err.message ?? err.code ?? "trust-task error",
      { details: err },
    );
  }

  if (opts.expectedResponseType !== undefined && doc.type !== opts.expectedResponseType) {
    const label = opts.operationLabel ?? opts.expectedResponseType;
    throw new VtaClientError(
      "e.client.parse",
      `${label}: unexpected response type ${doc.type ?? "(none)"} — ${JSON.stringify(doc)}`,
    );
  }

  return (doc.payload ?? {}) as Res;
}

/**
 * Map a framework Trust-Task status `code` to a typed {@link VtaErrorCode} so
 * the CLI/UI layer can give targeted guidance.
 *
 * **The standard-code spellings come from the framework runtime, not from a
 * regex here.** `normalizeCode` folds the frozen framework 0.1 snake_case
 * spellings (`permission_denied`) to their canonical 0.2 form
 * (`permissionDenied`) *only when the result is a SPEC §8.3 standard code*,
 * and `isStandardCode` says whether it is one. The old version hand-rolled
 * both: an unconditional snake→camel fold over whatever followed the last
 * `:`. That fold is wrong in one direction the framework's is not — it
 * rewrites the local part of an *extended* code whose spec legitimately
 * contains an underscore — and it silently missed `idConflict`, a §8.3 code
 * added after the switch was written.
 *
 * **An extended code (§8.5) is mapped by its local part, deliberately.**
 * `vault/list:permissionDenied` reports as forbidden. The namespace exists so
 * an extended code cannot *collide* with the standard set, so this is a
 * courtesy reading and not an identity: a specification is free to define
 * `<slug>:expired` to mean something its own spec decides. It is done anyway
 * because the alternative — every extended code arriving as a generic bad
 * request — throws away the only hint the UI has for a refusal an agent chose
 * to namespace, and `tests/tsp.channel.mjs` pins the behaviour. A caller that
 * needs the actual meaning reads the raw code off `VtaClientError.details` and
 * compares it directly, never against this bucket.
 */
export function coerceTrustTaskCode(code: string | undefined): VtaErrorCode {
  const raw = code ?? "";
  // Standard first, on the whole code. Only if that fails is the §8.5 local
  // part read — so a bare `permissionDenied` never takes the extended path.
  const norm = normalizeCode(raw);
  const local = isStandardCode(norm)
    ? norm
    : normalizeCode(raw.slice(raw.lastIndexOf(":") + 1));

  switch (local) {
    case "permissionDenied":
      return "e.p.msg.forbidden";
    case "idConflict":
      // §8.3's `idConflict` — this document id already executed with a
      // different body. It postdates the original switch: `trust-tasks-rs` and
      // the TypeScript framework runtime both emit it, and it is absent from
      // `trust-task-error/0.3`'s code enum, which is why that runtime's error
      // documents are `0.5`. It has an exact counterpart in `VtaErrorCode`,
      // and reporting it as a generic bad request loses the one thing a caller
      // can act on: that retrying under a fresh id is the fix.
      return "e.p.msg.conflict";
    case "internalError":
    case "unavailable":
      return "e.p.msg.internal";
    default:
      // malformedRequest, unsupportedType, unsupportedVersion, proofRequired,
      // proofInvalid, wrongRecipient, identityMismatch, taskFailed, expired,
      // cancelled, and every extended code with no standard-code local part.
      return "e.p.msg.bad_request";
  }
}

