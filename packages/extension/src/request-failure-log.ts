// One console line for every request the offscreen document fails.
//
// Each handler in its listener turns a failure into `{ ok: false, error }` and
// hands it back to the caller, and until this existed that was the only place
// it went. When the caller is the console, the error is drawn in a banner the
// person may never read closely, and the offscreen console, which is where
// anyone debugging a transport looks, showed `[pnm mediator] dropped session
// … reply timeout` with nothing about which request timed out or what the
// TSP channel saw (`last inbound frame declined: …`, the line that tells "the
// reply never came" from "it came and was refused").
//
// What is logged: the handler, the agent, the task type, how long it took, and
// the failure the caller receives. What is not: the request's payload, which
// can carry what a person asked their agent to do with their data. The task
// type says which operation without saying what it was about.
//
// Kept free of `chrome` so it is testable.

interface RequestShape {
  type?: unknown;
  vtaDid?: unknown;
  params?: { type?: unknown } | null;
}

interface FailureShape {
  ok?: unknown;
  error?: unknown;
  code?: unknown;
  details?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The console arguments for a failed reply, or `undefined` when `response` is
 * not a failure. A reply that is not a `{ ok: false }` object (a success, a
 * stream port, nothing) is never logged.
 */
export function requestFailureLog(
  request: unknown,
  response: unknown,
  elapsedMs: number,
): [string, Record<string, unknown>] | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as FailureShape;
  if (r.ok !== false) return undefined;
  const q = (request && typeof request === "object" ? request : {}) as RequestShape;
  const handler = str(q.type) ?? "(unknown request)";
  const fields: Record<string, unknown> = {
    error: str(r.error) ?? "(no message)",
    elapsedMs: Math.round(elapsedMs),
  };
  const vtaDid = str(q.vtaDid);
  if (vtaDid) fields.vtaDid = vtaDid;
  const task = str(q.params?.type);
  if (task) fields.task = task;
  const code = str(r.code);
  if (code) fields.code = code;
  if (r.details !== undefined) fields.details = r.details;
  return [`[pnm request] ${handler} failed after ${(elapsedMs / 1000).toFixed(1)}s`, fields];
}
