/**
 * DIDComm v2 protocol — `coordinate-mediation/2.0`.
 *
 * Spec: <https://didcomm.org/coordinate-mediation/2.0/>
 *
 * A wallet uses this protocol to enroll itself with a mediator so
 * the mediator will accept and queue inbound messages on the
 * wallet's behalf. Three exchanges:
 *
 *   mediate-request    → mediate-grant / mediate-deny
 *   keylist-update     → keylist-update-response
 *   keylist-query      → keylist
 *
 * After a successful mediate-grant + keylist-update(add), the
 * mediator will accept and queue messages addressed to any
 * `recipient_did` the wallet registered. The wallet retrieves them
 * via the `pickup/3.0` protocol on the same transport.
 */

const BASE = "https://didcomm.org/coordinate-mediation/2.0";

export const CoordinateMediationProtocol = {
  mediateRequest: `${BASE}/mediate-request`,
  mediateGrant: `${BASE}/mediate-grant`,
  mediateDeny: `${BASE}/mediate-deny`,
  keylistUpdate: `${BASE}/keylist-update`,
  keylistUpdateResponse: `${BASE}/keylist-update-response`,
  keylistQuery: `${BASE}/keylist-query`,
  keylist: `${BASE}/keylist`,
} as const;

export type CoordinateMediationMessageType =
  (typeof CoordinateMediationProtocol)[keyof typeof CoordinateMediationProtocol];

// ---------------------------------------------------------------------------
// Request / response bodies
// ---------------------------------------------------------------------------

/** mediate-request body. Empty per spec. */
export interface MediateRequestBody {
  // intentionally empty
}

/** mediate-grant body. */
export interface MediateGrantBody {
  /**
   * The DID the wallet should publish in its DID document
   * `service` entry's `routingKeys` to indicate "messages for me go
   * via this mediator first".
   */
  routing_did: string[];
}

/** mediate-deny body. */
export interface MediateDenyBody {
  reason?: string;
}

export type KeylistUpdateAction = "add" | "remove";

export interface KeylistUpdateItem {
  recipient_did: string;
  action: KeylistUpdateAction;
}

export interface KeylistUpdateBody {
  updates: KeylistUpdateItem[];
}

export type KeylistUpdateResult =
  | "client_error"
  | "server_error"
  | "no_change"
  | "success";

export interface KeylistUpdateResponseItem {
  recipient_did: string;
  action: KeylistUpdateAction;
  result: KeylistUpdateResult;
}

export interface KeylistUpdateResponseBody {
  updated: KeylistUpdateResponseItem[];
}

export interface KeylistQueryBody {
  /** Optional pagination cursor — opaque to the wallet. */
  paginate?: { limit?: number; offset?: number };
}

export interface KeylistEntry {
  recipient_did: string;
}

export interface KeylistBody {
  keys: KeylistEntry[];
  pagination?: { count: number; offset: number; remaining: number };
}
