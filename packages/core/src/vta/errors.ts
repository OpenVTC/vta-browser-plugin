/**
 * Error code namespace mirrors the VTA's typed error variants. The
 * server emits `{ "error": { "code": "e.p.msg.unauthorized", ... } }`
 * and we lift the code into a typed JS error so the UI can switch on
 * it instead of string-matching messages.
 */
export type VtaErrorCode =
  | "e.p.msg.unauthorized"
  | "e.p.msg.forbidden"
  | "e.p.msg.notfound"
  | "e.p.msg.conflict"
  | "e.p.msg.rate_limited"
  | "e.p.msg.bad_request"
  | "e.p.msg.internal"
  | "e.client.network"
  // A request that hit its own deadline rather than being refused. Distinct
  // from `e.client.network` on purpose: "the VTA never answered" is a
  // different operational fact from "the connection failed", and callers that
  // want to retry or tell the user which one happened need a stable code to
  // switch on rather than the message text (R3.7).
  | "e.client.timeout"
  | "e.client.parse"
  // The envelope's in-band `issuer` is not the identity that would sign it.
  // SPEC §7.2 item 6 has the consumer reject exactly this, so it is caught
  // here rather than spent on a round-trip: a document signed by a key its
  // issuer does not control proves only that somebody signed something.
  | "e.client.identity"
  // A page-supplied `sessionKey` that is not a `did:key`. Refused before the
  // subject signs anything, so the wallet never vouches for a value the
  // relying party would reject.
  | "e.client.invalid_session_key"
  // The relying party answered a login that asked for a session key with a
  // session that does not carry it. `auth/authenticate/0.2` says it must bind
  // the key or refuse, so this is a non-conforming reply, not a partial
  // success.
  | "e.client.session_key_not_bound"
  | "e.client.unsupported";

export class VtaClientError extends Error {
  readonly code: VtaErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  readonly suggestion?: string;

  constructor(
    code: VtaErrorCode,
    message: string,
    opts: { status?: number; details?: unknown; suggestion?: string } = {},
  ) {
    super(message);
    this.name = "VtaClientError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.suggestion !== undefined) this.suggestion = opts.suggestion;
  }
}

interface ServerErrorBody {
  error?: { code?: string; message?: string; details?: unknown; suggestion?: string };
}

const KNOWN_CODES: readonly VtaErrorCode[] = [
  "e.p.msg.unauthorized",
  "e.p.msg.forbidden",
  "e.p.msg.notfound",
  "e.p.msg.conflict",
  "e.p.msg.rate_limited",
  "e.p.msg.bad_request",
  "e.p.msg.internal",
];

function coerceCode(raw: string | undefined, status: number): VtaErrorCode {
  if (raw && (KNOWN_CODES as readonly string[]).includes(raw)) {
    return raw as VtaErrorCode;
  }
  if (status === 401) return "e.p.msg.unauthorized";
  if (status === 403) return "e.p.msg.forbidden";
  if (status === 404) return "e.p.msg.notfound";
  if (status === 409) return "e.p.msg.conflict";
  if (status === 429) return "e.p.msg.rate_limited";
  if (status >= 500) return "e.p.msg.internal";
  return "e.p.msg.bad_request";
}

/**
 * Build the typed error from an ALREADY-PARSED body.
 *
 * This exists because a `Response` body can only be read once. A caller that
 * has already parsed the body — as `RestChannel` must, to tell a Trust-Task
 * refusal from a transport failure — cannot hand the same `Response` to
 * {@link errorFromResponse}: the second read throws, the `catch` below
 * swallows it, and `body.error.code` silently comes back `undefined`. The
 * server's machine-readable code is then discarded and the error degrades to a
 * status-only guess, which is the exact failure R3.7 forbids.
 *
 * So: parse once, pass the parsed body here.
 */
export function errorFromBody(
  body: unknown,
  status: number,
  statusText = "",
): VtaClientError {
  const parsed = body as ServerErrorBody | undefined;
  const code = coerceCode(parsed?.error?.code, status);
  const message = parsed?.error?.message ?? `${status} ${statusText}`.trim();
  const opts: { status: number; details?: unknown; suggestion?: string } = { status };
  if (parsed?.error?.details !== undefined) opts.details = parsed.error.details;
  if (parsed?.error?.suggestion !== undefined) opts.suggestion = parsed.error.suggestion;
  return new VtaClientError(code, message, opts);
}

export async function errorFromResponse(res: Response): Promise<VtaClientError> {
  let body: ServerErrorBody | undefined;
  try {
    body = (await res.json()) as ServerErrorBody;
  } catch {
    // fall through with no body
  }
  const code = coerceCode(body?.error?.code, res.status);
  const message = body?.error?.message ?? `${res.status} ${res.statusText}`;
  const opts: { status: number; details?: unknown; suggestion?: string } = {
    status: res.status,
  };
  if (body?.error?.details !== undefined) opts.details = body.error.details;
  if (body?.error?.suggestion !== undefined) opts.suggestion = body.error.suggestion;
  return new VtaClientError(code, message, opts);
}

// ── Who refused with a 429 ──────────────────────────────────────────────────
//
// A 429 from a VTA URL is not necessarily the VTA's. The agent may sit behind
// a CDN or reverse proxy with limits of its own, and the two are tuned in
// different places: an operator told "the agent rate-limited you" when it was
// the CDN tunes the wrong one. The VTA marks every 429 its own limiter emits
// with `x-rate-limit-source: vta`, a `retry-after`, and a JSON body naming the
// limiter (`vta-service/src/routes/rate_limit.rs`; `vta_sdk::rate_limit` reads
// the same contract). Without those it is unattributable, and is reported as
// such rather than guessed at.
//
// The body is read as well as the header because a browser may not be shown
// the header. `x-rate-limit-source` and `retry-after` are not CORS-safelisted,
// so a page reaching the VTA under its origin allow-list rather than a host
// permission sees neither. The body is the VTI limiter contract's own
// machine-readable shape (`error: "rate_limited"`), on a request this module
// addressed to the agent, so it attributes the refusal as well as the header
// does.

/** Response header naming the service whose limiter refused the request. */
export const RATE_LIMIT_SOURCE_HEADER = "x-rate-limit-source";

/** Which service refused. `upstream` means the 429 did not identify itself:
 *  something in front of the agent (a CDN, a proxy, a load balancer). */
export type RateLimitSource = "vta" | "vtc" | "mediator" | "did-host" | "upstream";

/** A 429's attribution, carried as `details.rateLimit` on the error. */
export interface RateLimit {
  source: RateLimitSource;
  /** Which of the service's limiters tripped (`auth`, `did-log`, …), when it
   *  said. The VTA's `auth` limiter is its sign-in endpoints. */
  limiter?: string;
  /** How long the refusing service asked the caller to wait. */
  retryAfterSecs?: number;
}

const KNOWN_SOURCES: readonly RateLimitSource[] = ["vta", "vtc", "mediator", "did-host"];
/** A year. Bounds a hostile or broken hint, as `vta_sdk::rate_limit` does. */
const MAX_RETRY_AFTER_SECS = 86_400 * 365;
const MAX_LIMITER_LEN = 128;

/** `retry-after` in either RFC 9110 form — delta-seconds or an HTTP-date — as
 *  whole seconds from `nowMs`. Anything else is no hint, not an error. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), MAX_RETRY_AFTER_SECS);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), MAX_RETRY_AFTER_SECS);
}

/** Read a 429's attribution from its headers and its already-parsed body. */
export function rateLimitFrom(headers: Headers, body: unknown, nowMs: number = Date.now()): RateLimit {
  const doc = (body ?? {}) as { error?: unknown; limiter?: unknown; retryAfterSecs?: unknown };
  const isLimiterBody = doc.error === "rate_limited";
  const header = headers.get(RATE_LIMIT_SOURCE_HEADER)?.trim().toLowerCase();
  const source: RateLimitSource = (KNOWN_SOURCES as readonly string[]).includes(header ?? "")
    ? (header as RateLimitSource)
    : isLimiterBody
      ? "vta"
      : "upstream";
  const out: RateLimit = { source };
  if (isLimiterBody && typeof doc.limiter === "string" && doc.limiter !== "") {
    out.limiter = doc.limiter.slice(0, MAX_LIMITER_LEN);
  }
  const retryAfterSecs =
    parseRetryAfter(headers.get("retry-after"), nowMs) ??
    parseRetryAfter(headers.get("x-ratelimit-after"), nowMs) ??
    (isLimiterBody && typeof doc.retryAfterSecs === "number" && doc.retryAfterSecs >= 0
      ? Math.min(Math.ceil(doc.retryAfterSecs), MAX_RETRY_AFTER_SECS)
      : undefined);
  if (retryAfterSecs !== undefined) out.retryAfterSecs = retryAfterSecs;
  return out;
}

const SOURCE_LABEL: Record<RateLimitSource, string> = {
  vta: "the agent",
  vtc: "the VTC",
  mediator: "the mediator",
  "did-host": "the DID host",
  upstream: "something in front of the agent (a CDN or proxy), not the agent's own limiter",
};

/**
 * The typed error for a 429, from the response and its already-parsed body
 * (read once — R3.7). Code `e.p.msg.rate_limited`; who refused, which limiter
 * and how long to wait ride in `details.rateLimit` and in the message, so a
 * relay that only forwards prose still says who to talk to.
 */
export function rateLimitedError(res: Response, body: unknown, nowMs: number = Date.now()): VtaClientError {
  const rateLimit = rateLimitFrom(res.headers, body, nowMs);
  const who =
    rateLimit.limiter !== undefined && rateLimit.source !== "upstream"
      ? `${SOURCE_LABEL[rateLimit.source]}'s \`${rateLimit.limiter}\` limiter`
      : SOURCE_LABEL[rateLimit.source];
  const wait = rateLimit.retryAfterSecs !== undefined ? ` — retry after ${rateLimit.retryAfterSecs} s` : "";
  return new VtaClientError("e.p.msg.rate_limited", `rate limited by ${who}${wait}`, {
    status: res.status,
    details: { rateLimit },
  });
}

// ── A Trust-Task refusal's machine-readable reason ──────────────────────────

/** `details.reason` the VTA puts on a `taskFailed` for a missing row and for a
 *  conflicting write (`vta_sdk::protocols::trust_task_reject_reasons`), R3.7. */
export const TASK_REFUSAL_NOT_FOUND = "not_found";
export const TASK_REFUSAL_CONFLICT = "conflict";

/** The refusal's `details.reason`, if the counterparty gave one. */
export function taskRefusalReason(err: unknown): string | undefined {
  const details = (err as { details?: { details?: { reason?: unknown } } })?.details?.details;
  return typeof details?.reason === "string" ? details.reason : undefined;
}
