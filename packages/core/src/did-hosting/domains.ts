// DID hosting — `did-management/domain/*` and the service registry.
//
// A hosting service serves DIDs under one or more domains, spread across
// server instances. These tasks are the control plane for that: which domains
// exist, which instances serve them, and which instance is answering.
//
// Two operations here are irreversible in a way the rest are not, and both say
// so on the function: purging a domain, and deregistering an instance.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as DOMAIN_CREATE,
  RESPONSE_TYPE_URI as DOMAIN_CREATE_RESPONSE,
  type DomainCreatePayload,
  type DomainCreateResponsePayload,
  type DomainEntry,
} from "../specs/did-management/domain/create/0.1/payload.js";
import {
  TYPE_URI as DOMAIN_UPDATE,
  RESPONSE_TYPE_URI as DOMAIN_UPDATE_RESPONSE,
  type DomainUpdatePayload,
  type DomainUpdateResponsePayload,
} from "../specs/did-management/domain/update/0.1/payload.js";
import {
  TYPE_URI as DOMAIN_SET_STATE,
  RESPONSE_TYPE_URI as DOMAIN_SET_STATE_RESPONSE,
  type DomainSetStatePayload,
  type DomainSetStateResponsePayload,
} from "../specs/did-management/domain/set-state/0.1/payload.js";
import {
  TYPE_URI as DOMAIN_SET_DEFAULT,
  RESPONSE_TYPE_URI as DOMAIN_SET_DEFAULT_RESPONSE,
  type DomainSetDefaultPayload,
  type DomainSetDefaultResponsePayload,
} from "../specs/did-management/domain/set-default/0.1/payload.js";
import {
  TYPE_URI as DOMAIN_PURGE,
  RESPONSE_TYPE_URI as DOMAIN_PURGE_RESPONSE,
  type DomainPurgePayload,
  type DomainPurgeResponsePayload,
} from "../specs/did-management/domain/purge/0.1/payload.js";
import {
  TYPE_URI as DOMAIN_ASSIGN,
  RESPONSE_TYPE_URI as DOMAIN_ASSIGN_RESPONSE,
  type DomainAssignPayload,
  type DomainAssignResponsePayload,
} from "../specs/did-management/domain/assign/0.1/payload.js";
import {
  TYPE_URI as DOMAIN_UNASSIGN,
  RESPONSE_TYPE_URI as DOMAIN_UNASSIGN_RESPONSE,
  type DomainUnassignPayload,
  type DomainUnassignResponsePayload,
} from "../specs/did-management/domain/unassign/0.1/payload.js";
import {
  TYPE_URI as REGISTRY_ADMIN_REGISTER,
  RESPONSE_TYPE_URI as REGISTRY_ADMIN_REGISTER_RESPONSE,
  type RegistryAdminRegisterPayload,
  type RegistryAdminRegisterResponsePayload,
  type RegisteredInstance,
} from "../specs/did-management/registry/admin-register/0.2/payload.js";
import {
  TYPE_URI as REGISTRY_DEREGISTER,
  RESPONSE_TYPE_URI as REGISTRY_DEREGISTER_RESPONSE,
  type RegistryDeregisterPayload,
  type RegistryDeregisterResponsePayload,
} from "../specs/did-management/registry/deregister/0.1/payload.js";
import {
  TYPE_URI as SERVER_REGISTER,
  RESPONSE_TYPE_URI as SERVER_REGISTER_RESPONSE,
  type ServerRegisterPayload,
  type ServerRegisterResponsePayload,
} from "../specs/did-management/server/register/0.2/payload.js";
import {
  TYPE_URI as SERVER_HEALTH,
  RESPONSE_TYPE_URI as SERVER_HEALTH_RESPONSE,
  type ServerHealthPayload,
  type ServerHealthResponsePayload,
} from "../specs/did-management/server/health/0.1/payload.js";
import {
  TYPE_URI as SERVER_STATS_SYNC,
  RESPONSE_TYPE_URI as SERVER_STATS_SYNC_RESPONSE,
  type ServerStatsSyncPayload,
  type ServerStatsSyncResponsePayload,
} from "../specs/did-management/server/stats-sync/0.1/payload.js";

export type { DomainEntry, RegisteredInstance };

export interface DomainCallerParams {
  holder: Identity;
  /** The hosting service — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
}

export interface DomainCreateParams extends DomainCallerParams {
  /** The domain name, e.g. `example.com`. */
  name: string;
  label?: string;
  /** Make this the domain used when a call names none. Changing the default
   *  changes where every unqualified registration lands. */
  setAsDefault?: boolean;
}

/** Create a hosting domain. */
export async function createDomain(
  sender: TrustTaskSender,
  params: DomainCreateParams,
): Promise<DomainEntry> {
  const payload: DomainCreatePayload = {
    name: params.name,
    ...(params.label ? { label: params.label } : {}),
    ...(params.setAsDefault !== undefined ? { setAsDefault: params.setAsDefault } : {}),
  };
  const res = await sender.send<DomainCreateResponsePayload>(
    buildTrustTask(DOMAIN_CREATE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_CREATE_RESPONSE,
      operationLabel: "did-management/domain/create/0.1",
    },
  );
  return res.entry;
}

export interface DomainNameParams extends DomainCallerParams {
  name: string;
}

/** Rename a domain's label. */
export async function updateDomain(
  sender: TrustTaskSender,
  params: DomainNameParams & { label?: string },
): Promise<DomainEntry> {
  const payload: DomainUpdatePayload = {
    name: params.name,
    ...(params.label ? { label: params.label } : {}),
  };
  const res = await sender.send<DomainUpdateResponsePayload>(
    buildTrustTask(DOMAIN_UPDATE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_UPDATE_RESPONSE,
      operationLabel: "did-management/domain/update/0.1",
    },
  );
  return res.entry;
}

/**
 * The two states a hosting domain can be set to (`domain/set-state/0.1`).
 *
 * `disabled` stops new DIDs being hosted under it; the ones already there stay
 * readable for the host's grace period, and the entry then carries a `purgeAt`
 * — a disabled domain is on a clock, not parked indefinitely, so show that date
 * to whoever disabled it. `active` returns it to service and cancels the
 * pending purge. Declarative: the state it is already in is a no-op. This
 * replaced `domain/disable`, which the hosting service no longer serves. The
 * default domain cannot be disabled (`isDefault`).
 */
export type DomainState = DomainSetStatePayload["state"];

/** Set a domain's state. See {@link DomainState}. */
export async function setDomainState(
  sender: TrustTaskSender,
  params: DomainNameParams & { state: DomainState },
): Promise<DomainEntry> {
  const payload: DomainSetStatePayload = { name: params.name, state: params.state };
  const res = await sender.send<DomainSetStateResponsePayload>(
    buildTrustTask(DOMAIN_SET_STATE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_SET_STATE_RESPONSE,
      operationLabel: "did-management/domain/set-state/0.1",
    },
  );
  return res.entry;
}

/** Make a domain the default. The response names what it displaced. */
export async function setDefaultDomain(
  sender: TrustTaskSender,
  params: DomainNameParams,
): Promise<DomainSetDefaultResponsePayload> {
  const payload: DomainSetDefaultPayload = { name: params.name };
  return sender.send<DomainSetDefaultResponsePayload>(
    buildTrustTask(DOMAIN_SET_DEFAULT, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_SET_DEFAULT_RESPONSE,
      operationLabel: "did-management/domain/set-default/0.1",
    },
  );
}

export interface DomainPurgeParams extends DomainNameParams {
  /** Also purge the domain from the server instances serving it. */
  purgeServers?: boolean;
}

/**
 * Purge a domain and everything under it.
 *
 * Irreversible, and wider than it looks: every DID served under the domain
 * goes, and with `purgeServers` the instances are told to drop it too. The
 * response's `fanout` says which instances acted — read it, because a partial
 * fanout means some server is still serving what was just erased.
 */
export async function purgeDomain(
  sender: TrustTaskSender,
  params: DomainPurgeParams,
): Promise<DomainPurgeResponsePayload> {
  const payload: DomainPurgePayload = {
    name: params.name,
    ...(params.purgeServers !== undefined ? { purgeServers: params.purgeServers } : {}),
  };
  return sender.send<DomainPurgeResponsePayload>(
    buildTrustTask(DOMAIN_PURGE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_PURGE_RESPONSE,
      operationLabel: "did-management/domain/purge/0.1",
    },
  );
}

export interface DomainInstanceParams extends DomainCallerParams {
  instanceId: string;
  domain: string;
}

/** Assign a domain to a server instance. `status: "queued"` — the instance
 *  picks it up asynchronously, so this is a request, not a fact. */
export async function assignDomainToInstance(
  sender: TrustTaskSender,
  params: DomainInstanceParams,
): Promise<DomainAssignResponsePayload> {
  const payload: DomainAssignPayload = {
    instanceId: params.instanceId,
    domain: params.domain,
  };
  return sender.send<DomainAssignResponsePayload>(
    buildTrustTask(DOMAIN_ASSIGN, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_ASSIGN_RESPONSE,
      operationLabel: "did-management/domain/assign/0.1",
    },
  );
}

/** Unassign a domain from an instance. Also queued. */
export async function unassignDomainFromInstance(
  sender: TrustTaskSender,
  params: DomainInstanceParams,
): Promise<DomainUnassignResponsePayload> {
  const payload: DomainUnassignPayload = {
    instanceId: params.instanceId,
    domain: params.domain,
  };
  return sender.send<DomainUnassignResponsePayload>(
    buildTrustTask(DOMAIN_UNASSIGN, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DOMAIN_UNASSIGN_RESPONSE,
      operationLabel: "did-management/domain/unassign/0.1",
    },
  );
}

export interface RegistryRegisterParams extends DomainCallerParams {
  instanceId: string;
  /** The instance's own DID. */
  did: string;
  publicUrl: string;
  servedDomains?: string[];
  label?: string;
}

/** Register a server instance on someone else's behalf (admin path). */
export async function adminRegisterInstance(
  sender: TrustTaskSender,
  params: RegistryRegisterParams,
): Promise<RegisteredInstance> {
  const payload: RegistryAdminRegisterPayload = {
    instanceId: params.instanceId,
    did: params.did,
    publicUrl: params.publicUrl,
    ...(params.servedDomains ? { servedDomains: params.servedDomains } : {}),
    ...(params.label ? { label: params.label } : {}),
  };
  const res = await sender.send<RegistryAdminRegisterResponsePayload>(
    buildTrustTask(REGISTRY_ADMIN_REGISTER, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: REGISTRY_ADMIN_REGISTER_RESPONSE,
      operationLabel: "did-management/registry/admin-register/0.2",
    },
  );
  return res.entry;
}

/**
 * Remove a server instance from the registry.
 *
 * Whatever it was serving stops being reachable through the registry. Move its
 * domains first, or the DIDs under them go dark at the moment this returns.
 */
export async function deregisterInstance(
  sender: TrustTaskSender,
  params: DomainCallerParams & { instanceId: string },
): Promise<RegistryDeregisterResponsePayload> {
  const payload: RegistryDeregisterPayload = { instanceId: params.instanceId };
  return sender.send<RegistryDeregisterResponsePayload>(
    buildTrustTask(REGISTRY_DEREGISTER, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: REGISTRY_DEREGISTER_RESPONSE,
      operationLabel: "did-management/registry/deregister/0.1",
    },
  );
}

export interface ServerRegisterParams extends DomainCallerParams {
  instanceId: string;
  did: string;
  publicUrl: string;
  /** Domains this instance serves. Required — an instance serving nothing is
   *  registered but useless, and the schema says as much. */
  servedDomains: string[];
  label?: string;
  enabledMethods?: string[];
  protocolVersion?: string;
}

/** A server instance registering itself. */
export async function registerServerInstance(
  sender: TrustTaskSender,
  params: ServerRegisterParams,
): Promise<ServerRegisterResponsePayload> {
  const payload: ServerRegisterPayload = {
    instanceId: params.instanceId,
    did: params.did,
    publicUrl: params.publicUrl,
    servedDomains: params.servedDomains,
    ...(params.label ? { label: params.label } : {}),
    ...(params.enabledMethods ? { enabledMethods: params.enabledMethods } : {}),
    ...(params.protocolVersion ? { protocolVersion: params.protocolVersion } : {}),
  };
  return sender.send<ServerRegisterResponsePayload>(
    buildTrustTask(SERVER_REGISTER, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: SERVER_REGISTER_RESPONSE,
      operationLabel: "did-management/server/register/0.2",
    },
  );
}

/** Health of one instance. `ok: false` with an `observedAt` is an answer, not
 *  a failure — the registry is reporting what it saw, and it is still up. */
export async function serverInstanceHealth(
  sender: TrustTaskSender,
  params: DomainCallerParams & { instanceId: string },
): Promise<ServerHealthResponsePayload> {
  const payload: ServerHealthPayload = { instanceId: params.instanceId };
  return sender.send<ServerHealthResponsePayload>(
    buildTrustTask(SERVER_HEALTH, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: SERVER_HEALTH_RESPONSE,
      operationLabel: "did-management/server/health/0.1",
    },
  );
}

export interface StatsSyncParams extends DomainCallerParams {
  instanceId: string;
  /** Resolve counts per DID record. */
  perMnemonic: ServerStatsSyncPayload["perMnemonic"];
  buckets?: ServerStatsSyncPayload["buckets"];
}

/** Push resolve statistics from an instance to the registry. `accepted` is how
 *  many rows were taken — compare it with what was sent before reporting a
 *  clean sync. */
export async function syncServerStats(
  sender: TrustTaskSender,
  params: StatsSyncParams,
): Promise<ServerStatsSyncResponsePayload> {
  const payload: ServerStatsSyncPayload = {
    instanceId: params.instanceId,
    perMnemonic: params.perMnemonic,
    ...(params.buckets !== undefined ? { buckets: params.buckets } : {}),
  };
  return sender.send<ServerStatsSyncResponsePayload>(
    buildTrustTask(SERVER_STATS_SYNC, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: SERVER_STATS_SYNC_RESPONSE,
      operationLabel: "did-management/server/stats-sync/0.1",
    },
  );
}
