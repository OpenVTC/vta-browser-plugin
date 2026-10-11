// One request and its answer, timed — the check a connection self-test needs.
//
// Every other check a wallet can run is about reachability: the DID resolves,
// the endpoint accepts this origin, a socket is open. All of them passed in a
// field case where every request to the agent timed out, because none of them
// waits for the agent to *answer*. This does.
//
// `auth/whoami` is the request: it is cheap, read-only, answered for any
// caller the agent knows, and refused with a coded error for one it does not.
// A refusal still crossed the wire both ways, so it counts as a round trip —
// what failed there is authority, not transport.

import {
  TYPE_URI as AUTH_WHOAMI,
  RESPONSE_TYPE_URI as AUTH_WHOAMI_RESPONSE,
} from "@openvtc/trust-tasks/auth/whoami/0.1/payload";

import type { TaskParty, TrustTaskSender } from "./channel.js";
import { VtaClientError } from "./errors.js";
import { buildTrustTask } from "./trust-task.js";

export type RoundTrip =
  /** The agent answered. `refusal` is its code when the answer was a no. */
  | { kind: "answered"; ms: number; refusal?: { code: string; message: string } }
  /** Nothing usable came back: a timeout, a network failure, a reply that
   *  failed verification. `message` carries what the channel saw. */
  | { kind: "failed"; ms: number; code?: string; message: string };

/** Send `auth/whoami` and time the answer. Never throws. */
export async function probeRoundTrip(
  sender: TrustTaskSender,
  params: { holder: TaskParty; service: TaskParty; timeoutMs?: number; now?: () => number },
): Promise<RoundTrip> {
  const now = params.now ?? (() => performance.now());
  const started = now();
  const envelope = buildTrustTask(AUTH_WHOAMI, {}, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  try {
    await sender.send(envelope, {
      expectedResponseType: AUTH_WHOAMI_RESPONSE,
      operationLabel: "auth/whoami (round-trip check)",
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    return { kind: "answered", ms: Math.round(now() - started) };
  } catch (err) {
    const ms = Math.round(now() - started);
    const code = err instanceof VtaClientError ? err.code : undefined;
    // `e.client.*` is this side's own reading: it timed out, could not reach,
    // could not parse or verify. Any other code came from the agent.
    if (code !== undefined && !code.startsWith("e.client.")) {
      return {
        kind: "answered",
        ms,
        refusal: { code, message: err instanceof Error ? err.message : String(err) },
      };
    }
    return {
      kind: "failed",
      ms,
      ...(code !== undefined ? { code } : {}),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
