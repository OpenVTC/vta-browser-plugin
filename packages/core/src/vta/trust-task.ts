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

import type { SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
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

/**
 * Attach the Data Integrity proof a Trust-Task document is required to carry,
 * in place, immediately before it goes on the wire.
 *
 * ## Why every channel calls this, rather than every caller
 *
 * SPEC §7.2 item 7a lets a *specification* declare `proof` REQUIRED, and 93 of
 * the 141 task types this wallet speaks do — every `vault/*`, `acl/*`,
 * `vta/webvh/*`, `credential-exchange/*` and `vtc/*` mutation among them. Item
 * 7 admits **no transport substitute**: the bearer token on the REST channel
 * and the sender-authenticated TSP and DIDComm envelopes all authenticate the
 * *connection*, and none of them says the party named in `issuer` vouched for
 * this payload. A consumer enforcing the rule refuses the document with
 * `proofRequired` before a handler ever sees it.
 *
 * Signing at the ~116 call sites that build envelopes would be the same
 * decision taken 116 times, and the failure mode of forgetting once is a task
 * that stops working the day the maintainer turns the check on. So the channel
 * — the one place every envelope passes through on its way out — owns it, and
 * a `SigningIdentity` is a REQUIRED channel input for the same reason: a
 * channel that could be built without one would be a channel that silently
 * sends unsigned documents.
 *
 * ## Unconditional, not flag-driven
 *
 * We do not consult the specification's `isProofRequired`. A proof on a task
 * that merely RECOMMENDs one is legal and strictly more attributable, and the
 * alternative is carrying a 141-entry table whose staleness is invisible until
 * a request is refused.
 *
 * ## Re-signing is safe
 *
 * `VtaSession` may hand the same envelope to a second channel after the first
 * refuses it as unsupported. {@link signTrustTask} hashes a copy with `proof`
 * removed, so a re-sign overwrites cleanly rather than signing over the stale
 * proof — the bug that produces a signature covering bytes no verifier
 * reconstructs.
 */
export async function signOutboundTask(
  envelope: TrustTask<unknown>,
  signer: TaskSigner,
): Promise<void> {
  // SPEC §7.2 item 6 — the in-band issuer must be the party that signed. A
  // consumer rejects the mismatch, so catching it here turns a remote
  // `identityMismatch` into a local error naming both DIDs.
  if (envelope.issuer !== undefined && envelope.issuer !== signer.did) {
    throw new VtaClientError(
      "e.client.identity",
      `${envelope.type}: envelope issuer ${envelope.issuer} is not the signing identity ${signer.did}`,
    );
  }
  await signer.sign(envelope);
}

/**
 * Whatever can put a proof on an outbound document.
 *
 * An interface rather than a key, because the wallet does not hold every key it
 * needs to sign with. A per-site persona's key lives at the VTA and never
 * leaves it, so signing as one is a request, not a computation — but from the
 * channel's point of view the two are the same operation, and the RP cannot
 * tell them apart either: it verifies a proof against `did`, wherever the
 * bytes were produced.
 *
 * **Still REQUIRED, for the reason above.** Widening the type does not weaken
 * the rule that a channel cannot be built without one; a channel with no signer
 * would still be a channel that silently sends unsigned documents. What it
 * changes is only *where the key is*.
 *
 * `did` must be the DID the proof will verify under. A signer whose `did`
 * disagrees with what it actually signs produces documents that fail at the
 * consumer with `identityMismatch`, and the issuer check above cannot catch it
 * — it compares the envelope against this field, not against the signature.
 */
export interface TaskSigner {
  readonly did: string;
  sign(envelope: TrustTask<unknown>): Promise<void>;
}

/** A signer backed by a key this process holds — the holder's own identity,
 *  and what every channel used before the persona paths existed. */
export function localTaskSigner(signing: SigningIdentity): TaskSigner {
  return {
    did: signing.did,
    sign: async (envelope) => {
      await signTrustTask({
        envelope: envelope as unknown as Record<string, unknown> & { proof?: unknown },
        signing,
      });
    },
  };
}

/**
 * What a channel accepts for its signing input.
 *
 * A bare {@link SigningIdentity} is still accepted because the deprecated
 * `*Rest` helpers thread one straight through their own options types, and
 * changing that would rewrite fourteen public interfaces to say something none
 * of their callers need to know. It is normalised on the way in, so exactly one
 * shape reaches {@link signOutboundTask}.
 *
 * This is not a compatibility fold: both arms are live, they describe local
 * objects rather than a wire format, and neither is a legacy spelling of the
 * other.
 */
export type ChannelSigner = SigningIdentity | TaskSigner;

/** Normalise a channel's signing input. Call once, at construction — a channel
 *  that re-normalised per send would re-derive the same object on every
 *  outbound document. */
export function asTaskSigner(signer: ChannelSigner): TaskSigner {
  return "sign" in signer ? signer : localTaskSigner(signer);
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
/**
 * Verify that a reply really came from the agent this channel is talking to.
 *
 * **A reply is bytes off a socket.** Nothing else on this path establishes who
 * produced them — the transport proves a connection, and over REST not even
 * that beyond TLS to a host name. Without the proof an intermediary can rewrite
 * an ACL listing, flip a policy decision, or answer for an agent that never
 * spoke, and every check after this one passes, because the checks after this
 * one are about shape.
 *
 * Every specification that requires a proof on its request requires one on its
 * response too — SPEC §7.3 item 7: "where a specification declares no
 * requirement for the response, the request's applies to it". 265 of them do.
 *
 * ## Two checks, and the second is the one easy to omit
 *
 * The proof must verify, **and its proven signer must be the agent we
 * addressed**. `verifyTrustTaskProof` answers only the first — its own contract
 * says it "does NOT check framework-level bindings ... that's the caller's job".
 * A proof by somebody else's key verifies perfectly well, so skipping the
 * binding turns "signed by somebody" into "signed by our agent".
 *
 * ## What is exempt
 *
 * An error document. Its `type` resolves to the framework's `trust-task-error`
 * specification, whose own proof requirement is RECOMMENDED rather than
 * REQUIRED, so demanding one would make every conforming refusal unreadable —
 * including the ones carrying the reason a caller needs.
 *
 * ## No staging flag
 *
 * The Rust client has one because it talks to agents that may predate response
 * signing. This one does not: nothing here is deployed, and the house rule is
 * that the plugin and the VTA cut over together rather than carrying a fold
 * that reads as a live constraint.
 */
export async function verifyTrustTaskReply(
  doc: { type?: string; proof?: unknown },
  expectedSigner: string,
): Promise<void> {
  if (isTrustTaskErrorType(doc.type)) return;

  const result = await verifyTrustTaskProof(doc as Record<string, unknown>);
  if (!result.verified) {
    throw new VtaClientError(
      "e.client.parse",
      `the reply from ${expectedSigner} is unsigned or its proof does not verify ` +
        `(${result.reason ?? "no reason given"}). An unsigned answer is bytes, not evidence`,
    );
  }
  if (result.signer !== expectedSigner) {
    throw new VtaClientError(
      "e.client.parse",
      `the reply claiming to come from ${expectedSigner} is signed by ${result.signer}. ` +
        `The proof verifies, which means somebody really signed it — just not the agent ` +
        `this channel is talking to`,
    );
  }
}

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

