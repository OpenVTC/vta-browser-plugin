// Why a transport failed — turning `TypeError: Failed to fetch` into
// something a person can act on.
//
// The problem this solves
// -----------------------
// When a mediator refuses the extension's origin, the browser blocks the
// request and hands JavaScript a bare `TypeError: Failed to fetch`. The
// reason — "Response to preflight request doesn't pass access control check:
// No 'Access-Control-Allow-Origin' header is present" — goes to the devtools
// console and **nowhere else**. There is no API that returns it: the fetch
// spec deliberately makes a CORS failure opaque to the page so a script
// cannot use cross-origin errors to probe a network it has no access to. An
// extension cannot read its own console either.
//
// So the reason can never be recovered from the exception. It has to be
// *inferred*, and the inference is cheap:
//
//   - a request that fails at the network layer, against a host that answers
//     an opaque (`no-cors`) request a moment later, was refused by browser
//     policy, not by the network;
//   - a host that answers neither is unreachable.
//
// That single bit separates "your mediator is down" from "your mediator will
// not talk to this extension", which is the entire distinction an operator
// needs and the one the raw error destroys.
//
// Discriminating the error
// ------------------------
// R3.7 says match on stable machine-readable codes, never on strings, and
// nothing here matches a message. `TypeError` is the platform's own structural
// signal for "the fetch never produced a response" (network failure, CORS
// refusal, DNS, blocked scheme); `DOMException.name === "TimeoutError"` is the
// abort from `withFetchTimeout`. Anything else means the mediator *answered*
// and the failure came from its reply, which is a different class entirely and
// keeps its original message.
//
// Known limitation, deliberately accepted: the probe proves the host is up,
// not that CORS specifically refused us. A request that failed for an
// unrelated transient reason against a healthy host reads as
// `originNotAllowed`. The wording of `detail` therefore says what was
// observed rather than asserting a cause, and every remediation it suggests
// is safe to attempt if the guess is wrong.

import { isFetchTimeout } from "@openvtc/pnm-core";

/**
 * Stable causes a transport failure is classified into. Match on these —
 * never on `detail`, which is prose for a human and may be reworded (R3.7).
 */
export const TRANSPORT_DIAGNOSIS = {
  /** The host answered an opaque probe but refused the real request. Almost
   *  always a CORS allowlist that does not carry this extension's origin. */
  originNotAllowed: "mediator/origin-not-allowed",
  /** Nothing answered: DNS, TLS, a wrong endpoint, or a mediator that is down. */
  unreachable: "mediator/unreachable",
  /** The request outlived its deadline (R1.2). */
  timeout: "mediator/timeout",
  /** The mediator replied, and the reply was the failure — auth, ACL, a bad
   *  challenge. Not a connectivity problem. */
  rejected: "mediator/rejected",
  /** Classification did not apply; the original message is all there is. */
  unknown: "mediator/unknown",
} as const;

export type TransportDiagnosisCode =
  (typeof TRANSPORT_DIAGNOSIS)[keyof typeof TRANSPORT_DIAGNOSIS];

export interface TransportDiagnosis {
  code: TransportDiagnosisCode;
  /** One line naming what was observed. Rendered in the UI as-is. */
  detail: string;
  /** What to change to fix it, when there is a specific answer. Aimed at
   *  whoever operates the service — which is usually not the person reading
   *  it, so it names the config key rather than describing it. */
  remediation?: string;
}

/** Whether the host answered at all, when a probe was possible. */
export type Reachability = "reachable" | "unreachable" | "unprobed";

/**
 * Classify a transport failure. Pure — the caller does the IO and passes what
 * it learned, so the rule itself is testable without a network.
 *
 * `origin` is the extension's own origin, quoted into the remediation because
 * the operator has to paste it into a config file exactly.
 */
export function classifyTransportFailure(args: {
  error: unknown;
  reachable: Reachability;
  /** Host the failing request was aimed at, for the message. */
  host?: string;
  /** This extension's origin (`chrome-extension://<id>`). */
  origin?: string;
}): TransportDiagnosis {
  const { error, reachable, host, origin } = args;
  const where = host ? ` at ${host}` : "";

  if (isFetchTimeout(error)) {
    return {
      code: TRANSPORT_DIAGNOSIS.timeout,
      detail: `The mediator${where} did not answer before the request deadline.`,
    };
  }

  // Not a network-layer failure ⇒ the mediator answered and its reply was the
  // problem. Keep what it said; a connectivity story here would be a lie.
  if (!(error instanceof TypeError)) {
    return {
      code: TRANSPORT_DIAGNOSIS.rejected,
      detail: `The mediator${where} answered and refused the request: ${messageOf(error)}`,
    };
  }

  if (reachable === "reachable") {
    return {
      code: TRANSPORT_DIAGNOSIS.originNotAllowed,
      detail:
        `The mediator${where} is up and answering, but refused this request. ` +
        `A browser extension is a cross-origin caller, so the mediator has to ` +
        `allow this wallet's origin explicitly${origin ? ` (${origin})` : ""}.`,
      remediation:
        `Whoever operates this mediator needs to add the origin to ` +
        `\`[security] cors_allow_origin\` in its \`mediator.toml\` and restart it. ` +
        `The same setting also gates the WebSocket upgrade, so nothing this ` +
        `wallet can grant locally substitutes for it.`,
    };
  }

  if (reachable === "unreachable") {
    return {
      code: TRANSPORT_DIAGNOSIS.unreachable,
      detail: `Nothing answered at the mediator's address${where}.`,
      remediation:
        `Check the mediator is running and that the endpoint in its DID ` +
        `document is the one it actually serves.`,
    };
  }

  return {
    code: TRANSPORT_DIAGNOSIS.unknown,
    detail: `The connection to the mediator${where} failed before it produced a response.`,
  };
}

/**
 * Ask whether a host answers at all, without needing its permission to read
 * the answer.
 *
 * `mode: "no-cors"` yields an opaque response — status and headers are
 * unreadable, which is fine, because the question is only "did something
 * answer". It resolves for a 200 and equally for a 404 or a 500; it rejects
 * when the request never reached a server. That is exactly the bit we want,
 * and it is obtainable with no CORS cooperation from the host at all.
 *
 * Never throws: a probe that fails to run reports `"unprobed"` so the
 * classifier degrades to a weaker answer rather than replacing the original
 * failure with its own.
 */
export async function probeReachable(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Reachability> {
  try {
    await fetchImpl(url, {
      method: "GET",
      mode: "no-cors",
      // A cached opaque response would answer for a host that has since gone
      // away, which is the one wrong answer this probe must not give.
      cache: "no-store",
      redirect: "follow",
    });
    return "reachable";
  } catch (err: unknown) {
    // A timeout means the host did not answer in time — for this question
    // that is "unreachable", not "the probe broke".
    if (isFetchTimeout(err) || err instanceof TypeError) return "unreachable";
    return "unprobed";
  }
}

/** The scheme+host of a URL, for a message. Returns undefined rather than
 *  throwing on input that is not a URL. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
