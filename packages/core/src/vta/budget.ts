// How long the wallet must wait for a Trust Task, given what the VTA may do
// with it on the way.
//
// A port of `vta_sdk::budget` (verifiable-trust-infrastructure). Read that
// module for the whole story; the short version:
//
// Some tasks the VTA answers by calling a third party and waiting — minting a
// did:webvh relays onward to the DID hosting server. The VTA waits up to
// `TSP_REPLY_TIMEOUT_MS` for that hop, and if the hosting server has lost its
// half of the TSP relationship the frame is dropped silently (Rev 3 §7.2.2),
// so the VTA only learns of it when that wait expires. It then re-forms the
// relationship and resends, spending a second full window. A caller that
// allows less than that does not fail faster: the work still happens, the
// answer still comes, and the caller has stopped listening. Observed live — a
// DID created from the manager "timed out" at 30s while the VTA's recovered
// answer arrived at 30.07s.
//
// > A caller's budget must strictly exceed the worst case of whoever it is
// > waiting on.
//
// The numbers mirror the Rust module exactly. The list is the Rust list less
// the tasks this wallet never sends (`vault/proxy-login/0.1`, superseded;
// `vta/services/update/1.1`; `rooms/owner/anchor/0.1`) — a budget only matters for a task that leaves
// here, and `task-surface` holds this file to the tasks the wallet speaks. If
// either side changes, change the other.

import { TYPE_URI as WEBVH_DIDS_CREATE } from "@openvtc/trust-tasks/vta/webvh/dids/create/1.0/payload";
import { TYPE_URI as WEBVH_DIDS_DELETE } from "@openvtc/trust-tasks/vta/webvh/dids/delete/1.0/payload";
import { TYPE_URI as WEBVH_DIDS_UPDATE } from "@openvtc/trust-tasks/vta/webvh/dids/update/1.0/payload";
import { TYPE_URI as WEBVH_DIDS_ROTATE_KEYS } from "@openvtc/trust-tasks/vta/webvh/dids/rotate-keys/1.0/payload";
import { TYPE_URI as WEBVH_DIDS_REGISTER_WITH_SERVER } from "@openvtc/trust-tasks/vta/webvh/dids/register-with-server/1.0/payload";
import { TYPE_URI as WEBVH_AGENT_NAME_LIST } from "@openvtc/trust-tasks/vta/webvh/agent-name/list/1.0/payload";
import { TYPE_URI as WEBVH_AGENT_NAME_CHECK } from "@openvtc/trust-tasks/vta/webvh/agent-name/check/1.0/payload";
import { TYPE_URI as WEBVH_AGENT_NAME_SET } from "@openvtc/trust-tasks/vta/webvh/agent-name/set/1.0/payload";
import { TYPE_URI as WEBVH_AGENT_NAME_REMOVE } from "@openvtc/trust-tasks/vta/webvh/agent-name/remove/1.0/payload";
import { TYPE_URI as WEBVH_AGENT_NAME_DISABLE } from "@openvtc/trust-tasks/vta/webvh/agent-name/disable/1.0/payload";
import { TYPE_URI as WEBVH_AGENT_NAME_ENABLE } from "@openvtc/trust-tasks/vta/webvh/agent-name/enable/1.0/payload";
import { TYPE_URI as WEBVH_SERVERS_DOMAINS } from "@openvtc/trust-tasks/vta/webvh/servers/domains/0.1/payload";
import { TYPE_URI as WEBVH_SERVERS_RECONCILE } from "@openvtc/trust-tasks/vta/webvh/servers/reconcile/0.1/payload";
import { TYPE_URI as WEBVH_SERVERS_RETIRE_ORPHAN } from "@openvtc/trust-tasks/vta/webvh/servers/retire-orphan/0.1/payload";
import { TYPE_URI as ROOMS_OWNER_REGISTER } from "@openvtc/trust-tasks/rooms/owner/register/0.1/payload";
import { TYPE_URI as ROOMS_KEYS_BACKFILL } from "@openvtc/trust-tasks/rooms/keys/backfill/0.1/payload";
import { TYPE_URI as ROOMS_KEYS_READ } from "@openvtc/trust-tasks/rooms/keys/read/0.1/payload";
import { TYPE_URI as ROOMS_KEYS_BROWSE } from "@openvtc/trust-tasks/rooms/keys/browse/0.1/payload";
import { TYPE_URI as VAULT_PROXY_LOGIN } from "@openvtc/trust-tasks/vault/proxy-login/0.2/payload";
import { TYPE_URI as SERVICES_ENABLE } from "@openvtc/trust-tasks/vta/services/enable/1.0/payload";
import { TYPE_URI as SERVICES_UPDATE } from "@openvtc/trust-tasks/vta/services/update/1.0/payload";
import { TYPE_URI as PROVISION_INTEGRATION } from "@openvtc/trust-tasks/provision/integration/0.3/payload";

/** How long the VTA waits for a peer's reply on one TSP hop
 *  (`vta_sdk::budget::TSP_REPLY_TIMEOUT_SECS`). */
export const TSP_REPLY_TIMEOUT_MS = 30_000;

/** The first send, then the §7.2.2 self-repair resend. The resend is not
 *  optional: the floor must cover it. */
const RELAY_HOPS = 2;

/** Slack for the relationship re-form between the two hops. */
const REFORM_MARGIN_MS = 10_000;

/** Headroom for the legs the VTA's arithmetic does not model: mediator
 *  queueing either way, and this wallet's own send before the VTA's clock
 *  starts. */
const CLIENT_MARGIN_MS = 10_000;

/** The longest the VTA can take on a task it relays onward before answering. */
export function relayWorstCaseMs(): number {
  return RELAY_HOPS * TSP_REPLY_TIMEOUT_MS + REFORM_MARGIN_MS;
}

/** The smallest budget on which a relayed task's real answer — success or the
 *  VTA's diagnosis — is reachable at all. */
export function minRelayBudgetMs(): number {
  return relayWorstCaseMs() + CLIENT_MARGIN_MS;
}

/**
 * Tasks the VTA may answer by waiting on a third party
 * (`vta_sdk::budget::RELAYS_ONWARD`).
 *
 * Conservative by construction: several relay only for some payloads, and a
 * URI cannot say which, so a task that relays under *any* payload is listed.
 * Over-listing costs a slower report of a peer that is genuinely gone;
 * under-listing costs the silent timeout this module exists to prevent.
 */
export const RELAYS_ONWARD: ReadonlySet<string> = new Set([
  // did:webvh, server-managed: each publishes to or reads from the hosting server.
  WEBVH_DIDS_CREATE,
  WEBVH_DIDS_DELETE,
  WEBVH_DIDS_UPDATE,
  WEBVH_DIDS_ROTATE_KEYS,
  WEBVH_DIDS_REGISTER_WITH_SERVER,
  // Agent names live on the hosting server, reads included.
  WEBVH_AGENT_NAME_LIST,
  WEBVH_AGENT_NAME_CHECK,
  WEBVH_AGENT_NAME_SET,
  WEBVH_AGENT_NAME_REMOVE,
  WEBVH_AGENT_NAME_DISABLE,
  WEBVH_AGENT_NAME_ENABLE,
  WEBVH_SERVERS_DOMAINS,
  WEBVH_SERVERS_RECONCILE,
  WEBVH_SERVERS_RETIRE_ORPHAN,
  // Rooms: registration reaches the room's host; the reads fetch epoch state.
  ROOMS_OWNER_REGISTER,
  ROOMS_KEYS_BACKFILL,
  ROOMS_KEYS_READ,
  ROOMS_KEYS_BROWSE,
  // A `password` entry logs in to the third-party site and waits on it.
  VAULT_PROXY_LOGIN,
  // Enabling or updating `didcomm` runs the mediator handshake.
  SERVICES_ENABLE,
  SERVICES_UPDATE,
  // A template naming a `WEBVH_SERVER` mints through the `dids/create` path.
  PROVISION_INTEGRATION,
]);

/** Whether the VTA may answer `type` by waiting on a third party. */
export function relaysOnward(type: string): boolean {
  return RELAYS_ONWARD.has(type);
}

/**
 * The budget to actually use for `type`, given the one a caller asked for.
 *
 * Raises a relaying task to {@link minRelayBudgetMs}; never lowers anything. A
 * caller that deliberately allows longer stays in charge of its own patience,
 * and a task the VTA serves from its own storage keeps the caller's number, so
 * a local failure still reports as promptly as before.
 */
export function clientBudgetMs(type: string, requestedMs: number): number {
  return relaysOnward(type) ? Math.max(requestedMs, minRelayBudgetMs()) : requestedMs;
}
