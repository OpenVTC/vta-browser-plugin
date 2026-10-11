// The REST TrustTaskChannel.
//
// Carries a canonical Trust-Task envelope over HTTP: authenticate to the VTA
// for a short-lived bearer (two pre-session Trust Tasks, see `auth.ts`), POST
// the envelope to the trust-task dispatcher (`<base>/trust-tasks`), and decode
// the reply with the shared `parseTrustTaskReply`.
//
// This is the ONLY channel that carries a bearer — TSP and DIDComm are
// sender-authenticated by their envelope, so their channels need no token.
// The whole bearer story (challenge round-trip, cache, per-IP rate-limit
// avoidance, 401 self-heal) is quarantined here in `getVtaBearer`/`makeReauth`
// and never leaks into a domain op.

import type { NotifyOpts, SendOpts, TrustTaskChannel } from "./channel.js";
import { TRUST_TASK_PATH } from "./endpoint.js";
import { VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";
import { signOutboundTask } from "./trust-task.js";
import { asTaskSigner, type ChannelSigner, type TaskSigner } from "./trust-task.js";
import type { SigningIdentity } from "../siop/self-issued.js";
import { guardedFetch } from "@openvtc/vti-didcomm-js/net-guard";

import {
  getVtaBearer,
  makeReauth,
  vtaRestEndpointPolicy,
  type VtaAuthInputs,
} from "./auth.js";
import { withFetchTimeout, isFetchTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../http/timeout-fetch.js";
import { clientBudgetMs } from "./budget.js";
import { decodeTrustTaskHttpAck, decodeTrustTaskHttpReply } from "./http-reply.js";

export { decodeTrustTaskHttpAck, decodeTrustTaskHttpReply };

export interface RestChannelOptions extends VtaAuthInputs {
  /**
   * Signs every outbound envelope (SPEC §7.2 item 7a). REQUIRED, and
   * deliberately not optional: the bearer this channel carries authenticates
   * the *connection*, which item 7 explicitly refuses as a substitute for a
   * proof. A channel built without a signer would post documents a conforming
   * VTA rejects with `proofRequired`, so there is no such channel to build.
   *
   * Its `did` must be the envelope's `issuer` — see {@link signOutboundTask}.
   */
  signing: ChannelSigner;
  /**
   * Trust-task dispatcher path, appended to `baseUrl`. Defaults to
   * `/trust-tasks`, which the published HTTPS binding fixes — `baseUrl` is
   * the **Trust-Task base** and the binding owns the suffix.
   *
   * Overriding this is an escape hatch for a non-conformant deployment, not
   * a configuration knob: a VTA that needs it is one the binding cannot
   * describe.
   */
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
  private readonly signer: TaskSigner;
  private readonly path: string;
  /** Policy-guarded but not yet deadline-bound: the deadline is per request,
   *  because a task the VTA relays onward needs longer than one it serves
   *  itself (see `budget.ts`). */
  private readonly policyFetch: typeof fetch;

  constructor(opts: RestChannelOptions) {
    this.signer = asTaskSigner(opts.signing);
    this.auth = {
      baseUrl: opts.baseUrl,
      holder: opts.holder,
      service: opts.service,
      // The same signer the channel uses: the holder's own key, which is what
      // the VTA mints the session for.
      signing: this.signer,
      ...(opts.netPolicy ? { netPolicy: opts.netPolicy } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
    this.path = opts.trustTasksPath ?? TRUST_TASK_PATH;
    // The dispatcher URL is composed from the same `baseUrl` the bearer
    // handshake uses, so it is held to the same policy — vetted before it is
    // dialed, and never followed through a redirect. The cast states what the
    // library's JSDoc types loosely (see `getVtaBearer`).
    this.policyFetch = guardedFetch(
      opts.fetch,
      vtaRestEndpointPolicy(opts.netPolicy),
    ) as typeof fetch;
  }

  /**
   * POST the envelope, with the bearer handshake and its one retry.
   *
   * Shared by `send` and `notify`: the difference between them is entirely in
   * what they do with the reply, and duplicating the auth path would be one
   * more place for a stale-token retry to go missing.
   */
  private async post(
    envelope: TrustTask<unknown>,
    label: string,
    timeoutMs: number,
  ): Promise<Response> {
    const base = this.auth.baseUrl.replace(/\/+$/, "");
    const url = `${base}${this.path}`;
    // Before serialization, and before the bearer handshake: the proof is part
    // of the document, so a body built from an unsigned envelope would be the
    // one thing that reaches the VTA.
    await signOutboundTask(envelope, this.signer);
    const body = JSON.stringify(envelope);
    const fetchImpl = withFetchTimeout(this.policyFetch, timeoutMs);

    const once = async (bearer: string): Promise<Response> => {
      try {
        return await fetchImpl(url, {
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
            `${label}: VTA did not respond within ${timeoutMs / 1000}s`,
          );
        }
        throw new VtaClientError("e.client.network", (err as Error).message);
      }
    };

    // A cached bearer can outlive its server-side session (VTA restart or
    // session eviction). On 401, re-authenticate once and retry so a stale
    // token self-heals instead of surfacing as an auth failure.
    const bearer = await getVtaBearer(this.auth);
    const res = await once(bearer);
    if (res.status !== 401) return res;
    return once(await makeReauth(this.auth)(bearer));
  }

  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    const label = opts.operationLabel ?? envelope.type;
    const res = await this.post(
      envelope,
      label,
      clientBudgetMs(envelope.type, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
    );

    return decodeTrustTaskHttpReply<Res>(res, {
      ...(opts.expectedResponseType !== undefined
        ? { expectedResponseType: opts.expectedResponseType }
        : {}),
      operationLabel: label,
      // The agent this channel is bound to, from its own configuration —
      // never the reply's own `issuer`, which is the claim being checked.
      expectedSigner: this.auth.service.did,
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
    const res = await this.post(
      envelope,
      opts.operationLabel ?? envelope.type,
      opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );
    return decodeTrustTaskHttpAck(res);
  }
}
