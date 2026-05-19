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
  | "e.client.parse"
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
