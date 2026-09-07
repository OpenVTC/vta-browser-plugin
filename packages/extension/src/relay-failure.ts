// Turning a thrown rejection into a bridge reply without losing the half a
// program can act on.
//
// Every message handler in this extension was written the same way:
//
//     .catch((e: unknown) =>
//       sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }))
//
// which is correct for a wallet surface that only ever renders the failure to a
// human, and lossy everywhere else. `packages/core` throws a `VtaClientError`
// carrying a stable `code` and the agent's structured `details`; that line keeps
// the sentence and drops both. The console then had nothing to switch on, so a
// pane that wanted to behave differently for one particular refusal had exactly
// one option left — matching on the message text — which R3.7 forbids for the
// obvious reason: the agent is free to reword a message and is not free to
// change a code.
//
// So this module is the single place a rejection becomes a reply. It is a
// module rather than an inline expression because the extraction is fiddly in
// two ways that are easy to get subtly wrong, and getting either wrong fails
// silently:
//
//  1. **`VtaClientError.details` has two shapes.** A rejected Trust Task puts
//     the whole `trust-task-error` payload there — `{ code, message, retryable,
//     details }` — so the agent's real code is *nested*, and `e.code` is only
//     the bucket `coerceTrustTaskCode` mapped it into. An HTTP-level failure
//     (`errorFromBody`) instead puts the server's `error.details` there
//     directly, with no `code` beside it. Reading one shape and assuming the
//     other yields `undefined` for everything, which reads as "the agent sent
//     no code" rather than as a bug here.
//
//  2. **The reply is serialized.** `chrome.runtime.sendMessage` structured-
//     clones (and in practice JSON-serializes) what it is given: an `Error`
//     instance survives as `{}` and a `Map` as `{}` too. A `details` that
//     always arrives as an empty object is worse than an absent one, because a
//     pane checking `if (details)` takes the branch and finds nothing there.
//
// The page-facing relay deliberately does NOT use this. See `RelayTaskFailure`
// in `bridge-protocol.ts`.

import { VtaClientError } from "@openvtc/pnm-core";
import type { RelayTaskFailure } from "./bridge-protocol.js";

/**
 * The `trust-task-error` payload as it sits inside `VtaClientError.details`.
 *
 * Structurally typed rather than imported as `TrustTaskErrorPayload`, because
 * what arrives here is an *unvalidated* value off the wire: every member has to
 * be checked before it is used, and a type that promised `code: string` would
 * only hide that.
 */
interface WireErrorPayload {
  code?: unknown;
  details?: unknown;
}

/**
 * Reduce a value to something the bridge can carry, or to nothing.
 *
 * A JSON round-trip rather than a hand-written walk: it is the same
 * transformation the message channel is about to apply, so what a pane receives
 * is what this function returned. Anything that cannot survive it — a cycle, a
 * `BigInt` — is dropped rather than thrown, because a details field is a
 * courtesy and losing the whole refusal to it would be absurd.
 *
 * An empty object is dropped too. `JSON.stringify(new Error("boom"))` is
 * `"{}"`, so without this an `Error` handed to us as `details` would arrive
 * looking like present-but-empty context.
 */
function jsonSafe(value: unknown): unknown | undefined {
  if (value === undefined || value === null) return undefined;
  let round: unknown;
  try {
    round = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
  if (round === undefined || round === null) return undefined;
  if (typeof round === "object" && !Array.isArray(round) && Object.keys(round).length === 0) {
    return undefined;
  }
  return round;
}

/** The message a human reads. Unchanged from what every handler already did —
 *  this is the part that must never regress, because most failures have no
 *  code and prose is all there is. */
function humanMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the console relay's failure reply from a thrown value.
 *
 * Always yields a readable `error`. Adds `code` when the failure had a stable
 * one, and `details` when the agent sent structured context worth rendering.
 *
 * The agent's own code wins over the client's coerced `VtaErrorCode`:
 * `coerceTrustTaskCode` funnels every extended code it does not recognise into
 * `e.p.msg.bad_request`, and its own comment says a caller that needs the
 * meaning must read the raw code off `details`. A `VtaErrorCode` is still
 * carried when there is no agent code — `e.client.timeout` is every bit as
 * matchable as `taskFailed`, and the `e.` prefix keeps the two namespaces
 * apart on sight.
 */
export function relayFailure(e: unknown): RelayTaskFailure {
  const error = humanMessage(e);
  if (!(e instanceof VtaClientError)) return { ok: false, error };

  const payload = e.details as WireErrorPayload | undefined;
  // A `code` beside the details is what marks this as a Trust-Task refusal
  // rather than an HTTP-level one; the framework's error schema makes `code`
  // REQUIRED, so its absence is a reliable negative.
  const wireCode =
    typeof payload?.code === "string" && payload.code.length > 0 ? payload.code : undefined;
  // Take the nested context for a Trust-Task refusal, and `details` itself
  // otherwise — the HTTP path (`errorFromBody`) puts the server's `details`
  // straight on the error with nothing wrapping it.
  const details = jsonSafe(wireCode === undefined ? e.details : payload?.details);

  return {
    ok: false,
    error,
    code: wireCode ?? e.code,
    ...(details !== undefined ? { details } : {}),
  };
}
