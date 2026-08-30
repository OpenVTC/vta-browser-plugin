// Which transport the wallet is actually talking over.
//
// A connection records every transport its agent advertises, but only one of
// them carries traffic. The offscreen `VtaSession` picks in a fixed order —
// TSP > DIDComm > REST — with the `preferTsp` setting able to take TSP out of
// the running.
//
// **Advertisement is not availability.** `buildVtaSession` skips a channel
// whose mediator it cannot reach and falls through to the next one, so a
// wallet can advertise TSP, DIDComm and REST while every byte goes over REST.
// Deciding the status line from the stored connection alone reported "TSP" in
// exactly that situation — a mediator refusing the extension's origin took
// TSP and DIDComm out silently, and the UI kept naming a transport that had
// not carried a byte. That is worse than saying nothing: it stops anyone
// asking the question. So the selection here takes an optional
// `TransportHealth` — what the last session build actually observed — and a
// transport known to be down is never named as the active one.
//
// Health is *optional* because it genuinely may not exist yet: nothing has
// been observed before the first VTA operation. Absent health reproduces the
// old advertisement-only answer, which is the right guess, and callers that
// want to distinguish "in use" from "expected" can ask `isObserved`.
//
// Kept free of React and `chrome` so the selection rule is testable and so
// both the popup and the app shell resolve it identically. A status display
// that disagrees with the code doing the routing is worse than none.

/** The transport-bearing fields of a stored connection. */
export interface TransportSources {
  /** Mediator from the `#tsp` (`TSPTransport`) service. */
  tspMediatorDid?: string | undefined;
  /** Mediator from the `#vta-didcomm` service. */
  mediatorDid?: string | undefined;
  /** Base URL from the `#vta-rest` service. */
  restBaseUrl?: string | undefined;
}

export type Transport = "TSP" | "DIDComm" | "REST";

/** Priority order, mirroring the offscreen session's own preference. */
export const TRANSPORT_ORDER: Transport[] = ["TSP", "DIDComm", "REST"];

/**
 * What a session build observed for one transport.
 *
 * `"up"` means the channel was constructed — for TSP and DIDComm that
 * includes a completed mediator handshake and an open socket, which is real
 * evidence. `"down"` means it was skipped, and `code`/`detail` say why.
 *
 * `"unknown"` is not a failure. REST reports it: a `RestChannel` is built
 * from a URL without contacting anything, so construction proves nothing and
 * claiming `"up"` would be the same overconfidence this type exists to stop.
 * REST is only ever *proven* by a request completing over it.
 */
export type TransportState = "unknown" | "up" | "down";

export interface TransportObservation {
  state: TransportState;
  /** Stable machine-readable cause when `state` is `"down"` — a
   *  `TRANSPORT_DIAGNOSIS` code. Typed as a plain string to keep this module
   *  dependency-free; match on the constants, never on `detail` (R3.7). */
  code?: string;
  /** One line a person can act on. Safe to render. */
  detail?: string;
}

/** What the last session build observed, per transport. An absent entry means
 *  nothing has been observed — not that the transport is down. */
export type TransportHealth = Partial<Record<Transport, TransportObservation>>;

/** Whether `c` carries the service entry for `t`. The single place the
 *  transport→field mapping lives, so the advertised list and the selection
 *  rule can never drift apart. */
function advertises(c: TransportSources, t: Transport): boolean {
  if (t === "TSP") return Boolean(c.tspMediatorDid);
  if (t === "DIDComm") return Boolean(c.mediatorDid);
  return Boolean(c.restBaseUrl);
}

/** Everything the agent advertises, in priority order. Says nothing about
 *  whether any of it works — see {@link activeTransport}. */
export function advertisedTransports(c: TransportSources): Transport[] {
  return TRANSPORT_ORDER.filter((t) => advertises(c, t));
}

/**
 * The transport traffic will actually use.
 *
 * `preferTsp` defaults to on (see `WalletSettings`); turning it off pins the
 * connection to DIDComm/REST, which is the documented workaround for a
 * mediator whose TSP delivery misbehaves. Returns undefined when nothing
 * usable is left — a real state the UI must be able to show, not an
 * impossible one to assert away.
 *
 * Mirrors `buildVtaSession`'s own order and skip rule: a transport observed
 * `"down"` is passed over exactly as the session passes over it.
 */
export function activeTransport(
  c: TransportSources,
  preferTsp: boolean,
  health: TransportHealth = {},
): Transport | undefined {
  for (const t of TRANSPORT_ORDER) {
    if (!advertises(c, t)) continue;
    // TSP advertised but switched off: the session never builds that channel.
    if (t === "TSP" && !preferTsp) continue;
    if (health[t]?.state === "down") continue;
    return t;
  }
  return undefined;
}

/** Advertised transports the last build could not use, in priority order. */
export function unavailableTransports(
  c: TransportSources,
  health: TransportHealth = {},
): Transport[] {
  return advertisedTransports(c).filter((t) => health[t]?.state === "down");
}

/** Whether anything has actually been observed yet. Lets a caller label the
 *  status honestly — "in use" once a session has been built, "expected"
 *  before that — instead of asserting either way. */
export function isObserved(health: TransportHealth = {}): boolean {
  return TRANSPORT_ORDER.some((t) => {
    const s = health[t]?.state;
    return s === "up" || s === "down";
  });
}

/** One-line summary for a status chip: the active transport, what else is
 *  idle, and — the part that was missing — what is advertised but broken. */
export function transportSummary(
  c: TransportSources,
  preferTsp: boolean,
  health: TransportHealth = {},
): string {
  const active = activeTransport(c, preferTsp, health);
  const down = unavailableTransports(c, health).filter((t) => t !== active);
  const idle = advertisedTransports(c).filter(
    (t) => t !== active && !down.includes(t),
  );

  const parts: string[] = [];
  parts.push(active ?? "no transport");
  if (idle.length > 0) parts.push(`${idle.join(", ")} available`);
  if (down.length > 0) parts.push(`${down.join(", ")} unavailable`);
  return parts.join(" · ");
}
