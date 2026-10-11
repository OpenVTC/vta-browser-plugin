// Reading a Trust-Task reply off an HTTP response.
//
// Shared by the REST channel and the bearer handshake in `auth.ts`, which posts
// its two pre-session documents to the same `/trust-tasks` and must read their
// replies the same way: body first, then status (R3.7), the agent's proof
// verified, the thread checked. Its own module so `auth.ts` can use it without
// importing the channel that imports it.

import { errorFromBody, rateLimitedError, VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";
import { isTrustTaskErrorType } from "./protocol.js";
import { parseTrustTaskReply, verifyTrustTaskReply } from "./trust-task.js";

/**
 * Decide whether a one-way POST was delivered.
 *
 * The mirror of {@link decodeTrustTaskHttpReply}, and deliberately much
 * weaker. A task with no response document may be answered with a courtesy
 * `trust-task-ok`, with an empty body, or with nothing at all — none of which
 * a caller should act on, so a 2xx is simply "delivered" and the body is left
 * unread.
 *
 * What does not weaken is a refusal. A non-2xx still has its body read once
 * and its machine-readable code preferred over the status (R3.7): "the agent
 * rejected this" is not delivery, and a caller that cannot tell the two apart
 * will report a rejected task as sent.
 */
export async function decodeTrustTaskHttpAck(res: Response): Promise<void> {
  if (res.ok) return;
  let doc: { type?: string; payload?: unknown } | undefined;
  try {
    doc = (await res.json()) as { type?: string; payload?: unknown };
  } catch {
    // Not JSON, so there is no code to recover — build from the status alone.
    if (res.status === 429) throw rateLimitedError(res, undefined);
    throw errorFromBody(undefined, res.status, res.statusText);
  }
  if (res.status === 429 && !isTrustTaskErrorType(doc?.type)) throw rateLimitedError(res, doc);
  throw errorFromBody(doc, res.status, res.statusText);
}

/**
 * Decode an HTTP Trust-Task reply: read the body once, map failures to typed
 * errors, and hand a well-formed document to {@link parseTrustTaskReply}.
 *
 * Exported (rather than inlined in `send`) so this is reachable from a test
 * without standing up the whole bearer handshake. The decision it encodes is
 * security-relevant — whether a refusal keeps its `details` — and logic that
 * can only be exercised through a DIDComm authcrypt round-trip is logic that
 * in practice never gets exercised at all.
 *
 * Two rules, both R3.7:
 *
 *  1. A rejected Trust Task comes back at a NON-2xx status with a
 *     `trust-task-error` document as its body. Throwing on status first would
 *     discard the document, and with it the `details` a caller needs: the
 *     payload digest a user must match, the challenge, the signed consent
 *     requests an approver has to render. A refusal is not a transport
 *     failure. Parse first; fall back to the generic HTTP error only when the
 *     body is not a Trust Task at all.
 *  2. Read the body ONCE. `res.json()` consumes the stream, so every path here
 *     works from the parsed `doc`. Handing `res` to `errorFromResponse` after
 *     parsing would re-read a spent body, lose the server's code to that
 *     function's internal `catch`, and degrade to a status-only guess.
 */
export async function decodeTrustTaskHttpReply<Res>(
  res: Response,
  opts: {
    expectedResponseType?: string;
    operationLabel?: string;
    /** The agent this channel addressed. Its proof is what makes the reply
     *  evidence rather than bytes — see {@link verifyTrustTaskReply}. */
    expectedSigner?: string;
    /** The request this reply must answer: a non-error reply must be threaded
     *  to it (`threadId` = its `threadId`, else its `id`) and, when it named an
     *  issuer, addressed back to that issuer. A signed answer to some other
     *  request, or to someone else, is refused. */
    inReplyTo?: Pick<TrustTask<unknown>, "id" | "threadId" | "issuer">;
  } = {},
): Promise<Res> {
  let doc: { type?: string; payload?: unknown } | undefined;
  try {
    doc = (await res.json()) as { type?: string; payload?: unknown };
  } catch (err) {
    // Not JSON, so there is no code to recover — build from the status alone
    // rather than from a stream we cannot read again.
    if (res.status === 429) throw rateLimitedError(res, undefined);
    if (!res.ok) throw errorFromBody(undefined, res.status, res.statusText);
    throw new VtaClientError("e.client.parse", (err as Error).message, {
      status: res.status,
    });
  }
  if (!res.ok && !isTrustTaskErrorType(doc?.type)) {
    // A 429 is answered by whichever limiter tripped, which may not be the
    // agent's: say which (see `rateLimitedError`).
    if (res.status === 429) throw rateLimitedError(res, doc);
    throw errorFromBody(doc, res.status, res.statusText);
  }

  if (opts.expectedSigner !== undefined) {
    await verifyTrustTaskReply(doc ?? {}, opts.expectedSigner);
  }
  if (opts.inReplyTo !== undefined && !isTrustTaskErrorType(doc?.type)) {
    const reply = (doc ?? {}) as { threadId?: unknown; recipient?: unknown };
    const thread = opts.inReplyTo.threadId ?? opts.inReplyTo.id;
    if (reply.threadId !== thread) {
      throw new VtaClientError(
        "e.client.parse",
        `${opts.operationLabel ?? "reply"}: the reply is threaded to ${String(reply.threadId)}, not to this request`,
      );
    }
    if (opts.inReplyTo.issuer !== undefined && reply.recipient !== opts.inReplyTo.issuer) {
      throw new VtaClientError(
        "e.client.parse",
        `${opts.operationLabel ?? "reply"}: the reply is addressed to ${String(reply.recipient)}, not ${opts.inReplyTo.issuer}`,
      );
    }
  }

  return parseTrustTaskReply<Res>(doc, {
    ...(opts.expectedResponseType !== undefined
      ? { expectedResponseType: opts.expectedResponseType }
      : {}),
    ...(opts.operationLabel !== undefined ? { operationLabel: opts.operationLabel } : {}),
  });
}
