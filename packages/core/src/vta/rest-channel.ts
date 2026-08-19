// The REST TrustTaskChannel.
//
// Carries a canonical Trust-Task envelope over HTTP: authenticate to the VTA
// for a short-lived bearer (the DIDComm-authcrypt `/auth/` handshake), POST
// the envelope to the trust-task dispatcher (`/api/trust-tasks`), and decode
// the reply with the shared `parseTrustTaskReply`.
//
// This is the ONLY channel that carries a bearer — TSP and DIDComm are
// sender-authenticated by their envelope, so their channels need no token.
// The whole bearer story (challenge round-trip, cache, per-IP rate-limit
// avoidance, 401 self-heal) is quarantined here in `getVtaBearer`/`makeReauth`
// and never leaks into a domain op.

import type { NotifyOpts, SendOpts, TrustTaskChannel } from "./channel.js";
import { errorFromBody, VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";
import { parseTrustTaskReply } from "./trust-task.js";
import { isTrustTaskErrorType } from "./protocol.js";
import { getVtaBearer, makeReauth, type VtaAuthInputs } from "./auth.js";
import { withFetchTimeout, isFetchTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../http/timeout-fetch.js";

export interface RestChannelOptions extends VtaAuthInputs {
  /** Trust-task dispatcher path. Defaults to `/api/trust-tasks`. */
  trustTasksPath?: string;
}

/**
 * A {@link TrustTaskChannel} that dispatches Trust-Task requests over the
 * VTA's REST trust-task endpoint. Stateless (no live transport), so it
 * implements neither `close` nor `supports` — every task posts to the
 * dispatcher. (Non-dispatcher REST routes — `/contexts`, list-DIDs — are not
 * Trust-Tasks over REST today and stay out of this channel until the VTA
 * unifies them; see the transport-agnostic plan.)
 */
export class RestChannel implements TrustTaskChannel {
  readonly kind = "rest" as const;
  private readonly auth: VtaAuthInputs;
  private readonly path: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RestChannelOptions) {
    this.auth = {
      baseUrl: opts.baseUrl,
      holder: opts.holder,
      service: opts.service,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
    this.path = opts.trustTasksPath ?? "/api/trust-tasks";
    this.fetchImpl = withFetchTimeout(opts.fetch);
  }

  /**
   * POST the envelope, with the bearer handshake and its one retry.
   *
   * Shared by `send` and `notify`: the difference between them is entirely in
   * what they do with the reply, and duplicating the auth path would be one
   * more place for a stale-token retry to go missing.
   */
  private async post(envelope: TrustTask<unknown>, label: string): Promise<Response> {
    const base = this.auth.baseUrl.replace(/\/+$/, "");
    const url = `${base}${this.path}`;
    const body = JSON.stringify(envelope);

    const once = async (bearer: string): Promise<Response> => {
      try {
        return await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bearer}`,
          },
          body,
        });
      } catch (err) {
        if (isFetchTimeout(err)) {
          throw new VtaClientError(
            "e.client.timeout",
            `${label}: VTA did not respond within ${DEFAULT_FETCH_TIMEOUT_MS / 1000}s`,
          );
        }
        throw new VtaClientError("e.client.network", (err as Error).message);
      }
    };

    // A cached bearer can outlive its server-side session (VTA restart or
    // session eviction). On 401, re-authenticate once and retry so a stale
    // token self-heals instead of surfacing as an auth failure.
    const res = await once(await getVtaBearer(this.auth));
    if (res.status !== 401) return res;
    return once(await makeReauth(this.auth)());
  }

  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    const label = opts.operationLabel ?? envelope.type;
    const res = await this.post(envelope, label);

    return decodeTrustTaskHttpReply<Res>(res, {
      ...(opts.expectedResponseType !== undefined
        ? { expectedResponseType: opts.expectedResponseType }
        : {}),
      operationLabel: label,
    });
  }

  /**
   * `TrustTaskChannel.notify` — POST the envelope and treat a 2xx as delivered.
   *
   * The body is deliberately not decoded on success: a task with no response
   * document may be answered with a courtesy `trust-task-ok`, with an empty
   * body, or with nothing at all, and none of those is information a caller
   * should act on. What *is* still honoured is a refusal — a non-2xx carrying a
   * `trust-task-error` keeps its code and details (R3.7), because "the agent
   * rejected this" is not the same as "delivered".
   */
  async notify(envelope: TrustTask<unknown>, opts: NotifyOpts = {}): Promise<void> {
    const res = await this.post(envelope, opts.operationLabel ?? envelope.type);
    return decodeTrustTaskHttpAck(res);
  }
}

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
    throw errorFromBody(undefined, res.status, res.statusText);
  }
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
  opts: { expectedResponseType?: string; operationLabel?: string } = {},
): Promise<Res> {
  let doc: { type?: string; payload?: unknown } | undefined;
  try {
    doc = (await res.json()) as { type?: string; payload?: unknown };
  } catch (err) {
    // Not JSON, so there is no code to recover — build from the status alone
    // rather than from a stream we cannot read again.
    if (!res.ok) throw errorFromBody(undefined, res.status, res.statusText);
    throw new VtaClientError("e.client.parse", (err as Error).message, {
      status: res.status,
    });
  }
  if (!res.ok && !isTrustTaskErrorType(doc?.type)) {
    throw errorFromBody(doc, res.status, res.statusText);
  }

  return parseTrustTaskReply<Res>(doc, {
    ...(opts.expectedResponseType !== undefined
      ? { expectedResponseType: opts.expectedResponseType }
      : {}),
    ...(opts.operationLabel !== undefined ? { operationLabel: opts.operationLabel } : {}),
  });
}
