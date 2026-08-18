// DID hosting — `did-management/did/*`.
//
// **A different counterparty.** Everything else in this library talks to an
// agent; these talk to a did:webvh *hosting service*, which is what actually
// publishes a DID document at a URL and serves its log. An agent is a client of
// one, which is why `vta-sdk` declares these tasks — but the recipient of every
// envelope here is the hosting service, not the agent, and the two have
// separate ACLs.
//
// A DID is addressed by its **mnemonic** — the hosting service's own handle for
// the record, not the BIP-39 phrase that the `keys/*` family means by that
// word. They are unrelated, and the collision is the specification's; it is
// called out here because confusing the two would be an unpleasant surprise in
// either direction.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskNotifier, TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as DID_REGISTER,
  RESPONSE_TYPE_URI as DID_REGISTER_RESPONSE,
  type DIDManagementRegisterPayload,
  type DIDManagementRegisterResponsePayload,
  type DidRecord,
} from "@openvtc/trust-tasks/did-management/did/register/0.1/payload";
import {
  TYPE_URI as DID_PUBLISH,
  RESPONSE_TYPE_URI as DID_PUBLISH_RESPONSE,
  type DIDManagementPublishPayload,
  type DIDManagementPublishResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/publish/0.1/payload";
import {
  TYPE_URI as DID_INFO,
  RESPONSE_TYPE_URI as DID_INFO_RESPONSE,
  type DIDManagementInfoPayload,
  type DIDManagementInfoResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/info/0.1/payload";
import {
  TYPE_URI as DID_LIST,
  RESPONSE_TYPE_URI as DID_LIST_RESPONSE,
  type DIDManagementListPayload,
  type DIDManagementListResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/list/0.1/payload";
import {
  TYPE_URI as DID_CHECK_NAME,
  RESPONSE_TYPE_URI as DID_CHECK_NAME_RESPONSE,
  type DIDManagementCheckNamePayload,
  type DIDManagementCheckNameResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/check-name/0.1/payload";
import {
  TYPE_URI as DID_ENABLE,
  RESPONSE_TYPE_URI as DID_ENABLE_RESPONSE,
  type DIDManagementEnablePayload,
  type DIDManagementEnableResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/enable/0.1/payload";
import {
  TYPE_URI as DID_DISABLE,
  RESPONSE_TYPE_URI as DID_DISABLE_RESPONSE,
  type DIDManagementDisablePayload,
  type DIDManagementDisableResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/disable/0.1/payload";
import {
  TYPE_URI as DID_DELETE,
  RESPONSE_TYPE_URI as DID_DELETE_RESPONSE,
  type DIDManagementDeletePayload,
  type DIDManagementDeleteResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/delete/0.1/payload";
import {
  TYPE_URI as DID_ROLLBACK,
  RESPONSE_TYPE_URI as DID_ROLLBACK_RESPONSE,
  type DIDManagementRollbackPayload,
  type DIDManagementRollbackResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/rollback/0.1/payload";
import {
  TYPE_URI as DID_CHANGE_OWNER,
  RESPONSE_TYPE_URI as DID_CHANGE_OWNER_RESPONSE,
  type DIDManagementChangeOwnerPayload,
  type DIDManagementChangeOwnerResponsePayload,
} from "@openvtc/trust-tasks/did-management/did/change-owner/0.1/payload";
import {
  TYPE_URI as DID_PROBLEM_REPORT,
  type DIDManagementProblemReportPayload,
} from "@openvtc/trust-tasks/did-management/did/problem-report/0.1/payload";

export type { DidRecord };

export interface DidHostingCallerParams {
  /** Envelope `issuer` — the caller's identity. */
  holder: Identity;
  /** The **hosting service** — envelope `recipient`. Not the agent. */
  service: RemoteDidcommEndpoint;
  /** Hosting domain, when the service serves more than one. Omit for its
   *  default — which is a different DID namespace, not a synonym. */
  domain?: string;
}

/** Addressed by the hosting service's record handle. */
export interface DidRecordParams extends DidHostingCallerParams {
  mnemonic: string;
}

export interface DidRegisterParams extends DidHostingCallerParams {
  /** Path the DID will be served at. */
  path: string;
  /** DID method, e.g. `webvh`. */
  method: string;
  /** The initial DID document or log entry. */
  didData: DIDManagementRegisterPayload["didData"];
  /** Overwrite an existing registration at this path. Off by default, and
   *  worth keeping that way: the path is somebody's identity. */
  force?: boolean;
}

/** Register a new DID with the hosting service. */
export async function registerHostedDid(
  sender: TrustTaskSender,
  params: DidRegisterParams,
): Promise<DidRecord> {
  const payload: DIDManagementRegisterPayload = {
    path: params.path,
    method: params.method,
    didData: params.didData,
    ...(params.domain ? { domain: params.domain } : {}),
    ...(params.force !== undefined ? { force: params.force } : {}),
  };
  const res = await sender.send<DIDManagementRegisterResponsePayload>(
    buildTrustTask(DID_REGISTER, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_REGISTER_RESPONSE, operationLabel: "did-management/did/register/0.1" },
  );
  return res.record;
}

export interface DidPublishParams extends DidRecordParams {
  method: string;
  didData: DIDManagementPublishPayload["didData"];
}

/** Publish a new version of an existing DID. */
export async function publishHostedDid(
  sender: TrustTaskSender,
  params: DidPublishParams,
): Promise<DidRecord> {
  const payload: DIDManagementPublishPayload = {
    mnemonic: params.mnemonic,
    method: params.method,
    didData: params.didData,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  const res = await sender.send<DIDManagementPublishResponsePayload>(
    buildTrustTask(DID_PUBLISH, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_PUBLISH_RESPONSE, operationLabel: "did-management/did/publish/0.1" },
  );
  return res.record;
}

/** A record plus its log summary. */
export async function hostedDidInfo(
  sender: TrustTaskSender,
  params: DidRecordParams,
): Promise<DIDManagementInfoResponsePayload> {
  const payload: DIDManagementInfoPayload = {
    mnemonic: params.mnemonic,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  return sender.send<DIDManagementInfoResponsePayload>(
    buildTrustTask(DID_INFO, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_INFO_RESPONSE, operationLabel: "did-management/did/info/0.1" },
  );
}

export interface DidListParams extends DidHostingCallerParams {
  /** Only DIDs owned by this DID. */
  owner?: string;
  limit?: number;
  offset?: number;
}

export interface DidListResult {
  records: DidRecord[];
  /** Total matching the filter, not the page length. */
  total: number;
}

/** List hosted DIDs. */
export async function listHostedDids(
  sender: TrustTaskSender,
  params: DidListParams,
): Promise<DidListResult> {
  const payload: DIDManagementListPayload = {
    ...(params.owner ? { owner: params.owner } : {}),
    ...(params.domain ? { domain: params.domain } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  };
  const res = await sender.send<DIDManagementListResponsePayload>(
    buildTrustTask(DID_LIST, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_LIST_RESPONSE, operationLabel: "did-management/did/list/0.1" },
  );
  return { records: res.records ?? [], total: res.total ?? 0 };
}

export interface CheckNameParams extends DidHostingCallerParams {
  path?: string;
  /**
   * Hold the name if it is free.
   *
   * A reservation is a claim on somebody else's behalf-of-nobody: it takes the
   * name out of circulation. Ask only when the caller means to use it.
   */
  reserve?: boolean;
}

/** Is a path available, and optionally reserve it. */
export async function checkHostedDidName(
  sender: TrustTaskSender,
  params: CheckNameParams,
): Promise<DIDManagementCheckNameResponsePayload> {
  const payload: DIDManagementCheckNamePayload = {
    ...(params.path ? { path: params.path } : {}),
    ...(params.domain ? { domain: params.domain } : {}),
    ...(params.reserve !== undefined ? { reserve: params.reserve } : {}),
  };
  return sender.send<DIDManagementCheckNameResponsePayload>(
    buildTrustTask(DID_CHECK_NAME, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DID_CHECK_NAME_RESPONSE,
      operationLabel: "did-management/did/check-name/0.1",
    },
  );
}

/** Stop serving a DID without deleting it. Resolution fails; the log survives. */
export async function disableHostedDid(
  sender: TrustTaskSender,
  params: DidRecordParams,
): Promise<DidRecord> {
  const payload: DIDManagementDisablePayload = {
    mnemonic: params.mnemonic,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  const res = await sender.send<DIDManagementDisableResponsePayload>(
    buildTrustTask(DID_DISABLE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_DISABLE_RESPONSE, operationLabel: "did-management/did/disable/0.1" },
  );
  return res.record;
}

/** Serve a disabled DID again. */
export async function enableHostedDid(
  sender: TrustTaskSender,
  params: DidRecordParams,
): Promise<DidRecord> {
  const payload: DIDManagementEnablePayload = {
    mnemonic: params.mnemonic,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  const res = await sender.send<DIDManagementEnableResponsePayload>(
    buildTrustTask(DID_ENABLE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_ENABLE_RESPONSE, operationLabel: "did-management/did/enable/0.1" },
  );
  return res.record;
}

/**
 * Delete a hosted DID.
 *
 * The DID stops resolving for everyone who ever trusted it, and its log goes
 * with it. Anything that recorded this DID as an issuer or a subject is left
 * pointing at nothing — prefer {@link disableHostedDid} unless erasure is the
 * actual requirement.
 */
export async function deleteHostedDid(
  sender: TrustTaskSender,
  params: DidRecordParams,
): Promise<DidRecord> {
  const payload: DIDManagementDeletePayload = {
    mnemonic: params.mnemonic,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  const res = await sender.send<DIDManagementDeleteResponsePayload>(
    buildTrustTask(DID_DELETE, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_DELETE_RESPONSE, operationLabel: "did-management/did/delete/0.1" },
  );
  return res.record;
}

export interface DidRollbackParams extends DidRecordParams {
  /** The version to return to. Everything after it is removed. */
  targetVersion: number;
}

/**
 * Roll a DID's log back to an earlier version.
 *
 * `removedVersions` in the response is how many entries were destroyed. A
 * resolver that already read a later version has seen a document that no longer
 * exists, so this is not an undo — it is a fork that only the hosting service
 * remembers.
 */
export async function rollbackHostedDid(
  sender: TrustTaskSender,
  params: DidRollbackParams,
): Promise<DIDManagementRollbackResponsePayload> {
  const payload: DIDManagementRollbackPayload = {
    mnemonic: params.mnemonic,
    targetVersion: params.targetVersion,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  return sender.send<DIDManagementRollbackResponsePayload>(
    buildTrustTask(DID_ROLLBACK, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { expectedResponseType: DID_ROLLBACK_RESPONSE, operationLabel: "did-management/did/rollback/0.1" },
  );
}

export interface ChangeOwnerParams extends DidRecordParams {
  /** DID of the new owner. */
  newOwner: string;
}

/** Hand a hosted DID to a new owner. The old owner loses control of it. */
export async function changeHostedDidOwner(
  sender: TrustTaskSender,
  params: ChangeOwnerParams,
): Promise<DidRecord> {
  const payload: DIDManagementChangeOwnerPayload = {
    mnemonic: params.mnemonic,
    newOwner: params.newOwner,
    ...(params.domain ? { domain: params.domain } : {}),
  };
  const res = await sender.send<DIDManagementChangeOwnerResponsePayload>(
    buildTrustTask(DID_CHANGE_OWNER, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    {
      expectedResponseType: DID_CHANGE_OWNER_RESPONSE,
      operationLabel: "did-management/did/change-owner/0.1",
    },
  );
  return res.record;
}

export interface ProblemReportParams extends DidRecordParams {
  /** Machine-readable problem code. */
  code: string;
  message: string;
  ctx?: DIDManagementProblemReportPayload["ctx"];
}

/**
 * Report a problem with a hosted DID.
 *
 * **One-way**: the task defines no response, so this takes a notifier and
 * resolves on delivery. Nothing comes back to say the report was read, which
 * is the correct shape for it — a report is a courtesy to the operator, not a
 * request for a decision.
 */
export async function reportHostedDidProblem(
  notifier: TrustTaskNotifier,
  params: ProblemReportParams,
): Promise<void> {
  const payload: DIDManagementProblemReportPayload = {
    mnemonic: params.mnemonic,
    code: params.code,
    message: params.message,
    ...(params.domain ? { domain: params.domain } : {}),
    ...(params.ctx !== undefined ? { ctx: params.ctx } : {}),
  };
  await notifier.notify(
    buildTrustTask(DID_PROBLEM_REPORT, payload, {
      issuer: params.holder.did,
      recipient: params.service.did,
    }),
    { operationLabel: "did-management/did/problem-report/0.1" },
  );
}
