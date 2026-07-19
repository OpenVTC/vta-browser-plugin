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

import type { SendOpts, TrustTaskChannel } from "./channel.js";
import { errorFromResponse, VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";
import { parseTrustTaskReply } from "./trust-task.js";
import { isTrustTaskErrorType } from "./protocol.js";
import { getVtaBearer, makeReauth, type VtaAuthInputs } from "../vault/transport.js";
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

  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    const base = this.auth.baseUrl.replace(/\/+$/, "");
    const url = `${base}${this.path}`;
    const body = JSON.stringify(envelope);
    const label = opts.operationLabel ?? envelope.type;

    const post = async (bearer: string): Promise<Response> => {
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
    let res = await post(await getVtaBearer(this.auth));
    if (res.status === 401) {
      res = await post(await makeReauth(this.auth)());
    }

    // A rejected Trust Task comes back at a non-2xx status with a
    // `trust-task-error` document as its body. Handing that to
    // `errorFromResponse` — which expects a different shape entirely — throws
    // the document away, and with it the `details` a caller needs: the payload
    // digest a user must match, the challenge, the signed consent requests an
    // approver has to render.
    //
    // A refusal is not a transport failure. Parse the body first, and only fall
    // back to the generic HTTP error when it is not a Trust Task at all.
    let doc: { type?: string; payload?: unknown } | undefined;
    try {
      doc = (await res.json()) as { type?: string; payload?: unknown };
    } catch (err) {
      if (!res.ok) throw await errorFromResponse(res);
      throw new VtaClientError("e.client.parse", (err as Error).message, {
        status: res.status,
      });
    }
    if (!res.ok && !isTrustTaskErrorType(doc?.type)) {
      throw await errorFromResponse(res);
    }

    return parseTrustTaskReply<Res>(doc, {
      ...(opts.expectedResponseType !== undefined
        ? { expectedResponseType: opts.expectedResponseType }
        : {}),
      operationLabel: label,
    });
  }
}
