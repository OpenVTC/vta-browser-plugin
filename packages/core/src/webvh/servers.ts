// webvh hosting-server registrations — `vta/webvh/servers/*`.
//
// A *hosting server* is a did:webvh host the agent knows how to publish
// through. Registering one here does not create anything on the host: it
// records that the agent holds credentials for it, so a later
// `webvhDidCreate({ serverId })` has somewhere to publish to. Removing a
// registration likewise unpublishes nothing — it only forgets the route.
//
// `reconcile` exists because those two facts drift apart. The agent's record of
// what it hosts where is a local belief, and the host is the authority; a DID
// deleted on the host, or one the host serves that the agent never recorded,
// shows up only when someone compares the two.

import {
  TYPE_URI as SERVERS_LIST,
  RESPONSE_TYPE_URI as SERVERS_LIST_RESPONSE,
  type Payload as ServersListPayload,
  type Response as ServersListResponse,
  type WebvhServerRecord,
} from "@openvtc/trust-tasks/vta/webvh/servers/list/1.0/payload";
import {
  TYPE_URI as SERVERS_REGISTER,
  RESPONSE_TYPE_URI as SERVERS_REGISTER_RESPONSE,
  type Payload as ServersRegisterPayload,
  type Response as ServersRegisterResponse,
} from "@openvtc/trust-tasks/vta/webvh/servers/register/1.0/payload";
import {
  TYPE_URI as SERVERS_REMOVE,
  RESPONSE_TYPE_URI as SERVERS_REMOVE_RESPONSE,
  type Payload as ServersRemovePayload,
  type Response as ServersRemoveResponse,
} from "@openvtc/trust-tasks/vta/webvh/servers/remove/1.0/payload";
import {
  TYPE_URI as SERVERS_DOMAINS,
  RESPONSE_TYPE_URI as SERVERS_DOMAINS_RESPONSE,
  type Payload as ServersDomainsPayload,
  type Response as ServersDomainsResponse,
} from "@openvtc/trust-tasks/vta/webvh/servers/domains/0.1/payload";
import {
  TYPE_URI as SERVERS_RECONCILE,
  RESPONSE_TYPE_URI as SERVERS_RECONCILE_RESPONSE,
  type Payload as ServersReconcilePayload,
  type Response as ServersReconcileResponse,
} from "@openvtc/trust-tasks/vta/webvh/servers/reconcile/0.1/payload";
import {
  TYPE_URI as SERVERS_RETIRE_ORPHAN,
  RESPONSE_TYPE_URI as SERVERS_RETIRE_ORPHAN_RESPONSE,
  type VTAWebVHServersRetireOrphanPayload as ServersRetireOrphanPayload,
  type VTAWebVHServersRetireOrphanResponsePayload as ServersRetireOrphanResponse,
} from "@openvtc/trust-tasks/vta/webvh/servers/retire-orphan/0.1/payload";

import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { WebvhCall } from "./dids.js";

export type { WebvhServerRecord };

const send = <T>(
  sender: TrustTaskSender,
  call: WebvhCall,
  type: string,
  responseType: string,
  label: string,
  payload: unknown,
): Promise<T> =>
  sender.send<T>(
    buildTrustTask(type, payload as Record<string, unknown>, {
      issuer: call.holder.did,
      recipient: call.service.did,
    }),
    { expectedResponseType: responseType, operationLabel: label },
  );

/** List the hosting servers this agent can publish through. */
export async function webvhServerList(
  sender: TrustTaskSender,
  params: WebvhCall,
): Promise<ServersListResponse> {
  const payload: ServersListPayload = {};
  return send(sender, params, SERVERS_LIST, SERVERS_LIST_RESPONSE,
    "vta/webvh/servers/list/1.0", payload);
}

/**
 * Register a hosting server, or relabel one already registered.
 *
 * One task covers both: a payload carrying no credentials is the label-only
 * patch, and the agent refuses to create a registration from one. So calling
 * this on an unknown server with only a label is an error, not a create.
 */
export async function webvhServerRegister(
  sender: TrustTaskSender,
  params: WebvhCall & ServersRegisterPayload,
): Promise<ServersRegisterResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, SERVERS_REGISTER, SERVERS_REGISTER_RESPONSE,
    "vta/webvh/servers/register/1.0", payload);
}

/**
 * Forget a hosting-server registration.
 *
 * Nothing on the host is touched, and DIDs already published through it stay
 * published — what goes is the agent's ability to publish more.
 */
export async function webvhServerRemove(
  sender: TrustTaskSender,
  params: WebvhCall & ServersRemovePayload,
): Promise<ServersRemoveResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, SERVERS_REMOVE, SERVERS_REMOVE_RESPONSE,
    "vta/webvh/servers/remove/1.0", payload);
}

/** The domains a registered hosting server will serve DIDs under. */
export async function webvhServerDomains(
  sender: TrustTaskSender,
  params: WebvhCall & ServersDomainsPayload,
): Promise<ServersDomainsResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, SERVERS_DOMAINS, SERVERS_DOMAINS_RESPONSE,
    "vta/webvh/servers/domains/0.1", payload);
}

/**
 * Compare what the agent believes it hosts on a server with what the server
 * actually serves.
 *
 * Reports both directions of drift — DIDs the host serves that the agent has no
 * record of, and DIDs the agent records that the host does not have. It reports;
 * it does not repair.
 */
export async function webvhServerReconcile(
  sender: TrustTaskSender,
  params: WebvhCall & ServersReconcilePayload,
): Promise<ServersReconcileResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, SERVERS_RECONCILE, SERVERS_RECONCILE_RESPONSE,
    "vta/webvh/servers/reconcile/0.1", payload);
}

/**
 * Retire a slot the host serves and the agent has no record of — the
 * `hostOnly` half of what {@link webvhServerReconcile} reports.
 *
 * Reconcile reports drift and repairs nothing, which leaves one direction of it
 * with no action at all: a slot the host still serves that no agent record
 * claims. Nothing else can retire it, because every other task in this family
 * addresses a DID, and a slot reserved but never published to has no DID — it
 * is exactly as orphaned, and exactly as invisible.
 *
 * **Pass `expectedDid` whenever the reconcile report carried one.** Slot ids
 * are reused. Without it, a report taken before a reuse retires whatever now
 * occupies the slot; with it, the agent refuses on mismatch. Omit it only for a
 * slot that was genuinely never published to, which is the one case where there
 * is no DID to name.
 *
 * There is no undo, which is why `reason` is worth sending even though it is
 * optional: it is recorded in the audit trail and outlives the record of what
 * was retired.
 *
 * `retired: false` in the answer is a real outcome, not an error — an agent
 * that could not confirm removal with the host reports it rather than claiming
 * success. Check it.
 */
export async function webvhServerRetireOrphan(
  sender: TrustTaskSender,
  params: WebvhCall & ServersRetireOrphanPayload,
): Promise<ServersRetireOrphanResponse> {
  const { holder, service, ...payload } = params;
  return send(sender, { holder, service }, SERVERS_RETIRE_ORPHAN,
    SERVERS_RETIRE_ORPHAN_RESPONSE, "vta/webvh/servers/retire-orphan/0.1", payload);
}
