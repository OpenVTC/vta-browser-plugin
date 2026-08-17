// Which transport the wallet is actually talking over.
//
// A connection records every transport its agent advertises, but only one of
// them carries traffic. The offscreen `VtaSession` picks in a fixed order —
// TSP > DIDComm > REST — with the `preferTsp` setting able to take TSP out of
// the running. Listing all three, as the popup's status line does, answers
// "what could this use?" when the question a user is actually asking is
// "what is it using right now?".
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

/** Everything the agent advertises, in priority order. */
export function advertisedTransports(c: TransportSources): Transport[] {
  const out: Transport[] = [];
  if (c.tspMediatorDid) out.push("TSP");
  if (c.mediatorDid) out.push("DIDComm");
  if (c.restBaseUrl) out.push("REST");
  return out;
}

/**
 * The transport traffic will actually use.
 *
 * `preferTsp` defaults to on (see `WalletSettings`); turning it off pins the
 * connection to DIDComm/REST, which is the documented workaround for a
 * mediator whose TSP delivery misbehaves. Returns undefined when the agent
 * advertises nothing usable — a real state the UI must be able to show, not
 * an impossible one to assert away.
 */
export function activeTransport(
  c: TransportSources,
  preferTsp: boolean,
): Transport | undefined {
  if (preferTsp && c.tspMediatorDid) return "TSP";
  if (c.mediatorDid) return "DIDComm";
  if (c.restBaseUrl) return "REST";
  // TSP advertised but switched off, with no other transport: nothing usable.
  return undefined;
}

/** One-line summary for a status chip: the active transport, noting when
 *  others are available but idle. */
export function transportSummary(c: TransportSources, preferTsp: boolean): string {
  const active = activeTransport(c, preferTsp);
  if (!active) return "no transport";
  const others = advertisedTransports(c).filter((x) => x !== active);
  return others.length > 0 ? `${active} · ${others.join(", ")} available` : active;
}
