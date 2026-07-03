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
//                             `trust-task-error/{0.1,0.2}` document.
//
// A `TrustTaskChannel` (see `channel.ts`) builds a request with the former
// and hands the decoded reply document to the latter; the channel itself only
// deals with transport concerns.

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
 * - A `trust-task-error/{0.1,0.2}` document throws a `VtaClientError` whose
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
 * Normalizes across framework versions and namespacing: 0.1 codes are
 * snake_case (`permission_denied`), 0.2 lowerCamelCase (`permissionDenied`),
 * and extended task codes are namespaced `<slug>:<local>` (e.g.
 * `vta/passkey-vms:unknownCeremony`). Reduce to the local part and fold
 * snake→camel so one switch covers all forms.
 */
export function coerceTrustTaskCode(code: string | undefined): VtaErrorCode {
  const local = (code ?? "").split(":").pop() ?? "";
  const norm = local.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  switch (norm) {
    case "permissionDenied":
      return "e.p.msg.forbidden";
    case "internalError":
    case "unavailable":
      return "e.p.msg.internal";
    default:
      // malformedRequest, unsupportedType, unsupportedVersion, proofRequired,
      // proofInvalid, wrongRecipient, identityMismatch, taskFailed, expired,
      // and all task-specific extended codes.
      return "e.p.msg.bad_request";
  }
}
