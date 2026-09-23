// Mediator operations — the `messaging/*` surface a mediator serves about itself.
//
// An Affinidi messaging mediator answers Trust Tasks addressed to *its own*
// DID: its statistics, every account's queues, one account's messages and
// settings, and a live traffic monitor. They arrive over the same authenticated
// session a holder already keeps open with that mediator for its inbox, which
// is what lets a wallet inspect the relay carrying its mail without a second
// socket or a key leaving the device.
//
// Three facts shape this module, and none is visible from a call signature.
//
// ## The mediator decides what you are, from its own record
//
// Every call names the caller's standing implicitly — the mediator reads it off
// the authenticated session, never off the document. `standingOf` turns the
// account the mediator returns into what a surface may *offer*; it never
// decides what is *allowed*, which stays the mediator's call on every task.
// An account the mediator calls `standard` is served its own queues and nothing
// else, and asking for more is refused (`permissionDenied`), not narrowed.
//
// ## The mediator knows an account only by `sha256(did)`
//
// Targets (`did` on almost every payload) and the `from`/`to` of every monitor
// event are lowercase-hex SHA-256 of a DID. The mediator cannot map them back,
// by design; a client that holds DIDs can, which is what `accountHash` is for.
//
// ## A destructive call is previewed first, and the preview is binding
//
// `queue/purge` takes `dryRun`. `purgeWithPlan` re-previews before it acts and
// refuses — removing nothing — when the queue no longer matches what the human
// confirmed, so no one approves one count and loses another.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { sha256 } from "../trust-tasks/canonical.js";

import {
  TYPE_URI as STATS_SHOW,
  RESPONSE_TYPE_URI as STATS_SHOW_RESPONSE,
  type MessagingShowMediatorStatisticsResponsePayload,
} from "@openvtc/trust-tasks/messaging/stats/show/0.1/payload";
import {
  TYPE_URI as QUEUE_LIST,
  RESPONSE_TYPE_URI as QUEUE_LIST_RESPONSE,
  type MessagingListQueuesPayload,
  type MessagingListQueuesResponsePayload,
} from "@openvtc/trust-tasks/messaging/queue/list/0.1/payload";
import {
  TYPE_URI as QUEUE_STATUS,
  RESPONSE_TYPE_URI as QUEUE_STATUS_RESPONSE,
  type MessagingShowQueueStatusPayload,
  type MessagingShowQueueStatusResponsePayload,
} from "@openvtc/trust-tasks/messaging/queue/status/0.1/payload";
import {
  TYPE_URI as QUEUE_PURGE,
  RESPONSE_TYPE_URI as QUEUE_PURGE_RESPONSE,
  type MessagingPurgeQueuePayload,
  type MessagingPurgeQueueResponsePayload,
} from "@openvtc/trust-tasks/messaging/queue/purge/0.1/payload";
import {
  TYPE_URI as ACCOUNT_GET,
  RESPONSE_TYPE_URI as ACCOUNT_GET_RESPONSE,
  type MessagingGetAccountPayload,
  type MessagingGetAccountResponsePayload,
} from "@openvtc/trust-tasks/messaging/account/get/0.1/payload";
import {
  TYPE_URI as ACCOUNT_LIST,
  RESPONSE_TYPE_URI as ACCOUNT_LIST_RESPONSE,
  type MessagingListAccountsPayload,
  type MessagingListAccountsResponsePayload,
} from "@openvtc/trust-tasks/messaging/account/list/0.1/payload";
import {
  TYPE_URI as ACCOUNT_UPDATE,
  RESPONSE_TYPE_URI as ACCOUNT_UPDATE_RESPONSE,
  type MessagingUpdateAccountPayload,
  type MessagingUpdateAccountResponsePayload,
} from "@openvtc/trust-tasks/messaging/account/update/0.1/payload";
import {
  TYPE_URI as MESSAGE_LIST,
  RESPONSE_TYPE_URI as MESSAGE_LIST_RESPONSE,
  type MessagingListMessagesPayload,
  type MessagingListMessagesResponsePayload,
} from "@openvtc/trust-tasks/messaging/message/list/0.1/payload";
import {
  TYPE_URI as MESSAGE_DELETE,
  RESPONSE_TYPE_URI as MESSAGE_DELETE_RESPONSE,
  type MessagingDeleteMessagesPayload,
  type MessagingDeleteMessagesResponsePayload,
} from "@openvtc/trust-tasks/messaging/message/delete/0.1/payload";
import {
  TYPE_URI as MONITOR_SUBSCRIBE,
  RESPONSE_TYPE_URI as MONITOR_SUBSCRIBE_RESPONSE,
  type MessagingSubscribeToTrafficMonitorPayload,
  type MessagingSubscribeToTrafficMonitorResponsePayload,
} from "@openvtc/trust-tasks/messaging/monitor/subscribe/0.1/payload";
import {
  TYPE_URI as MONITOR_UNSUBSCRIBE,
  RESPONSE_TYPE_URI as MONITOR_UNSUBSCRIBE_RESPONSE,
  type MessagingUnsubscribeFromTrafficMonitorResponsePayload,
} from "@openvtc/trust-tasks/messaging/monitor/unsubscribe/0.1/payload";
import {
  TYPE_URI as MONITOR_EVENT,
  type MessagingTrafficMonitorEventPayload,
} from "@openvtc/trust-tasks/messaging/monitor/event/0.1/payload";
import type {
  Account,
  AccountStats,
  AccountType,
  MediatorAcl,
  MessageMeta,
  MonitorEvent,
  MonitorFilter,
  PeerDepth,
  Queue,
  QueueDepth,
  QueueLimits,
  QueueSummary,
  TrafficStage,
} from "@openvtc/trust-tasks/_shared/components";

export type {
  Account,
  AccountStats,
  AccountType,
  MediatorAcl,
  MessageMeta,
  MonitorEvent,
  MonitorFilter,
  PeerDepth,
  Queue,
  QueueDepth,
  QueueLimits,
  QueueSummary,
  TrafficStage,
};
export type MediatorStats = MessagingShowMediatorStatisticsResponsePayload;
export type QueueListResult = MessagingListQueuesResponsePayload;
export type QueueStatusResult = MessagingShowQueueStatusResponsePayload;
export type MessageListResult = MessagingListMessagesResponsePayload;
export type AccountListResult = MessagingListAccountsResponsePayload;
export type MonitorGrant = MessagingSubscribeToTrafficMonitorResponsePayload;
export type MonitorBatch = MessagingTrafficMonitorEventPayload;
export type MonitorEnded = MessagingUnsubscribeFromTrafficMonitorResponsePayload;
export type PurgeResult = MessagingPurgeQueueResponsePayload;
export type DeleteResult = MessagingDeleteMessagesResponsePayload;

/** The type URI of a traffic-monitor batch — pushed, never requested. */
export const MONITOR_EVENT_TYPE = MONITOR_EVENT;

/**
 * Every task URI this module can send. A bundle guard reads this list, so a
 * task added here is covered by it without anyone remembering to.
 */
export const MEDIATOR_TASK_TYPES = [
  STATS_SHOW,
  QUEUE_LIST,
  QUEUE_STATUS,
  QUEUE_PURGE,
  ACCOUNT_GET,
  ACCOUNT_LIST,
  ACCOUNT_UPDATE,
  MESSAGE_LIST,
  MESSAGE_DELETE,
  MONITOR_SUBSCRIBE,
  MONITOR_UNSUBSCRIBE,
] as const;

/** Who is asking, and which mediator is being asked. */
export interface MediatorCaller {
  /** The DID the session with the mediator is authenticated as. */
  holder: TaskParty;
  /** The mediator itself — the recipient of every task here. */
  mediator: TaskParty;
}

async function call<Res>(
  sender: TrustTaskSender,
  parties: MediatorCaller,
  type: string,
  responseType: string,
  label: string,
  payload: unknown,
): Promise<Res> {
  const envelope = buildTrustTask(type, payload, {
    issuer: parties.holder.did,
    recipient: parties.mediator.did,
  });
  return sender.send<Res>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * The identifier a mediator knows an account by: lowercase-hex SHA-256 of the
 * DID's UTF-8 bytes, exactly as the mediator computes it (`sha256::digest`).
 */
export async function accountHash(did: string): Promise<string> {
  const bytes = await sha256(did);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Turn a set of DIDs this client knows into a hash → DID lookup, so a surface
 * can name the accounts a mediator reports by hash. Anything the client does
 * not know stays a hash — which is the honest answer, not a gap.
 */
export async function accountBook(dids: Iterable<string>): Promise<Map<string, string>> {
  const book = new Map<string, string>();
  for (const did of dids) book.set(await accountHash(did), did);
  return book;
}

// ── Standing ─────────────────────────────────────────────────────────────────

/** What a surface may offer, read from the mediator's record of the caller. */
export interface MediatorStanding {
  /** `admin` and `rootAdmin` see the whole mediator; `self` sees its own
   *  account. `mediator` is the mediator's own account and is not something a
   *  holder can be, but is reported rather than folded into `self`. */
  role: "self" | "admin" | "rootAdmin" | "mediator";
  /** Mediator-wide views: statistics, every account, the audit log, config. */
  mediatorWide: boolean;
  /** Messages for this account are held here for pickup — the precondition for
   *  listing one's own messages. */
  local: boolean;
  selfManageList: boolean;
  selfManageSendQueueLimit: boolean;
  selfManageReceiveQueueLimit: boolean;
}

/** Standing from the account the mediator returned for the caller — never from
 *  anything the caller asked to be. */
export function standingOf(account: Pick<Account, "accountType" | "acl">): MediatorStanding {
  const role: MediatorStanding["role"] =
    account.accountType === "standard" ? "self" : account.accountType;
  return {
    role,
    mediatorWide: role === "admin" || role === "rootAdmin",
    local: account.acl.local === true,
    selfManageList: account.acl.selfManageList === true,
    selfManageSendQueueLimit: account.acl.selfManageSendQueueLimit === true,
    selfManageReceiveQueueLimit: account.acl.selfManageReceiveQueueLimit === true,
  };
}

// ── Version floor ────────────────────────────────────────────────────────────

/**
 * The oldest mediator this client drives.
 *
 * 0.28.36 is the first release carrying everything the surface here uses at
 * once: the operations tasks (0.28.20), refusals threaded to their request so a
 * `permissionDenied` arrives as one rather than as a timeout (0.28.26), and the
 * activity and lifetime counters on `account/get` (0.28.33 / 0.28.36) — request
 * members an older mediator refuses the whole call over rather than ignoring.
 * One floor rather than a gate per member: there is no older mediator anyone
 * here runs.
 */
export const MEDIATOR_VERSION_FLOOR = [0, 28, 36] as const;

/** `major.minor.patch`, ignoring a pre-release or build suffix. */
export function parseMediatorVersion(v: string): [number, number, number] | undefined {
  const core = v.split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 3) return undefined;
  const nums = parts.slice(0, 3).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return undefined;
  return nums as [number, number, number];
}

/** Whether `version` meets {@link MEDIATOR_VERSION_FLOOR}. An unreadable
 *  version does not — the surface says what it found instead of guessing. */
export function meetsMediatorFloor(version: string | undefined): boolean {
  const v = version ? parseMediatorVersion(version) : undefined;
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    const a = v[i]!;
    const b = MEDIATOR_VERSION_FLOOR[i]!;
    if (a !== b) return a > b;
  }
  return true;
}

// ── Mediator-wide (administrators) ───────────────────────────────────────────

export async function mediatorStats(
  sender: TrustTaskSender,
  caller: MediatorCaller,
): Promise<MediatorStats> {
  return call(sender, caller, STATS_SHOW, STATS_SHOW_RESPONSE, "messaging/stats/show", {});
}

export interface QueueListParams {
  queue?: Queue;
  sort?: NonNullable<MessagingListQueuesPayload["sort"]>;
  minCount?: number;
  cursor?: string;
  limit?: number;
}

/** One page of accounts ranked by queue depth. Served from the mediator's
 *  periodic survey, so `snapshotAt` says how old the ranking is. */
export async function mediatorQueueList(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: QueueListParams = {},
): Promise<QueueListResult> {
  const payload: MessagingListQueuesPayload = {
    ...(params.queue ? { queue: params.queue } : {}),
    ...(params.sort ? { sort: params.sort } : {}),
    ...(params.minCount !== undefined ? { minCount: params.minCount } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  };
  return call(sender, caller, QUEUE_LIST, QUEUE_LIST_RESPONSE, "messaging/queue/list", payload);
}

export interface AccountListParams {
  accountType?: AccountType;
  cursor?: string;
  limit?: number;
  includeStats?: boolean;
  includeActivity?: boolean;
}

export async function mediatorAccountList(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: AccountListParams = {},
): Promise<AccountListResult> {
  const payload: MessagingListAccountsPayload = {
    ...(params.accountType ? { accountType: params.accountType } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.includeStats ? { includeStats: true } : {}),
    ...(params.includeActivity ? { includeActivity: true } : {}),
  };
  return call(sender, caller, ACCOUNT_LIST, ACCOUNT_LIST_RESPONSE, "messaging/account/list", payload);
}

// ── One account (the caller's own, or any for an administrator) ─────────────

export interface AccountGetParams {
  /** Account hash; the caller's own when omitted. */
  did?: string;
  includeStats?: boolean;
  includeActivity?: boolean;
}

export async function mediatorAccountGet(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: AccountGetParams = {},
): Promise<Account> {
  const payload: MessagingGetAccountPayload = {
    did: params.did ?? (await accountHash(caller.holder.did)),
    ...(params.includeStats ? { includeStats: true } : {}),
    ...(params.includeActivity ? { includeActivity: true } : {}),
  };
  const res = await call<MessagingGetAccountResponsePayload>(
    sender,
    caller,
    ACCOUNT_GET,
    ACCOUNT_GET_RESPONSE,
    "messaging/account/get",
    payload,
  );
  return res.account;
}

export interface QueueStatusParams {
  /** Account hash; the caller's own when omitted. */
  did?: string;
  /** Break each queue down by its top N counterparties. */
  includePeers?: number;
}

/** Both queues of one account, read live (not from the survey). */
export async function mediatorQueueStatus(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: QueueStatusParams = {},
): Promise<QueueStatusResult> {
  const payload: MessagingShowQueueStatusPayload = {
    ...(params.did ? { did: params.did } : {}),
    ...(params.includePeers !== undefined ? { includePeers: params.includePeers } : {}),
  };
  return call(sender, caller, QUEUE_STATUS, QUEUE_STATUS_RESPONSE, "messaging/queue/status", payload);
}

export interface MessageListParams {
  did?: string;
  queue: Queue;
  peer?: string;
  cursor?: string;
  limit?: number;
}

/** One page of a queue: metadata only, oldest first. Never a body. */
export async function mediatorMessageList(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: MessageListParams,
): Promise<MessageListResult> {
  const payload: MessagingListMessagesPayload = {
    queue: params.queue,
    ...(params.did ? { did: params.did } : {}),
    ...(params.peer ? { peer: params.peer } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  };
  return call(sender, caller, MESSAGE_LIST, MESSAGE_LIST_RESPONSE, "messaging/message/list", payload);
}

export interface MessageDeleteParams {
  did?: string;
  msgIds: [string, ...string[]];
}

export async function mediatorMessageDelete(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: MessageDeleteParams,
): Promise<DeleteResult> {
  const payload: MessagingDeleteMessagesPayload = {
    msgIds: params.msgIds,
    ...(params.did ? { did: params.did } : {}),
  };
  return call(sender, caller, MESSAGE_DELETE, MESSAGE_DELETE_RESPONSE, "messaging/message/delete", payload);
}

export interface AccountUpdateParams {
  /** Account hash. Required: an update names what it changes. */
  did: string;
  accountType?: AccountType;
  acl?: MediatorAcl;
  queueLimits?: QueueLimits;
}

/** A partial update; omitted members are unchanged. */
export async function mediatorAccountUpdate(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: AccountUpdateParams,
): Promise<Account> {
  const payload: MessagingUpdateAccountPayload = {
    did: params.did,
    ...(params.accountType ? { accountType: params.accountType } : {}),
    ...(params.acl ? { acl: params.acl } : {}),
    ...(params.queueLimits ? { queueLimits: params.queueLimits } : {}),
  };
  const res = await call<MessagingUpdateAccountResponsePayload>(
    sender,
    caller,
    ACCOUNT_UPDATE,
    ACCOUNT_UPDATE_RESPONSE,
    "messaging/account/update",
    payload,
  );
  return res.account;
}

// ── Purge: preview, then confirm ─────────────────────────────────────────────

export interface PurgeRequest {
  /** Account hash; the caller's own when omitted. */
  did?: string;
  queue: Queue;
  /** Only messages to or from this account hash. */
  peer?: string;
  olderThanSeconds?: number;
}

/** What a human is shown and confirms. */
export interface PurgePlan {
  request: PurgeRequest;
  matched: number;
  matchedBytes: number;
}

/** The queue changed between the preview a human confirmed and the purge. */
export class PurgePlanStaleError extends Error {
  readonly code = "mediator/purge-plan-stale";
  constructor(
    readonly previewed: number,
    readonly now: number,
  ) {
    super(
      `the queue changed since it was previewed: ${previewed} matched then, ${now} now. ` +
        `Nothing was removed — preview it again.`,
    );
    this.name = "PurgePlanStaleError";
  }
}

async function runPurge(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  request: PurgeRequest,
  dryRun: boolean,
): Promise<PurgeResult> {
  const payload: MessagingPurgeQueuePayload = {
    queue: request.queue,
    dryRun,
    ...(request.did ? { did: request.did } : {}),
    ...(request.peer ? { peer: request.peer } : {}),
    ...(request.olderThanSeconds !== undefined ? { olderThanSeconds: request.olderThanSeconds } : {}),
  };
  return call(sender, caller, QUEUE_PURGE, QUEUE_PURGE_RESPONSE, "messaging/queue/purge", payload);
}

/** Count what a purge would remove, without removing anything. */
export async function purgePreview(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  request: PurgeRequest,
): Promise<PurgePlan> {
  const r = await runPurge(sender, caller, request, true);
  return { request, matched: r.matched, matchedBytes: r.matchedBytes ?? 0 };
}

/**
 * Carry out a previewed purge. Re-previews first and throws
 * {@link PurgePlanStaleError} — having removed nothing — when the count moved.
 */
export async function purgeWithPlan(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  plan: PurgePlan,
): Promise<PurgeResult> {
  const now = await runPurge(sender, caller, plan.request, true);
  if (now.matched !== plan.matched) throw new PurgePlanStaleError(plan.matched, now.matched);
  return runPurge(sender, caller, plan.request, false);
}

// ── Traffic monitor ──────────────────────────────────────────────────────────

export interface MonitorSubscribeParams {
  filter?: MonitorFilter;
  leaseSeconds?: number;
  maxEventsPerSecond?: number;
  /** Renew this subscription rather than opening a new one. */
  subscriptionId?: string;
}

/** Open (or renew) a traffic-monitor subscription. The mediator narrows the
 *  filter to what the caller may see and says so in the grant. */
export async function monitorSubscribe(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  params: MonitorSubscribeParams = {},
): Promise<MonitorGrant> {
  const payload: MessagingSubscribeToTrafficMonitorPayload = {
    ...(params.filter ? { filter: params.filter } : {}),
    ...(params.leaseSeconds !== undefined ? { leaseSeconds: params.leaseSeconds } : {}),
    ...(params.maxEventsPerSecond !== undefined
      ? { maxEventsPerSecond: params.maxEventsPerSecond }
      : {}),
    ...(params.subscriptionId ? { subscriptionId: params.subscriptionId } : {}),
  };
  return call(
    sender,
    caller,
    MONITOR_SUBSCRIBE,
    MONITOR_SUBSCRIBE_RESPONSE,
    "messaging/monitor/subscribe",
    payload,
  );
}

export async function monitorUnsubscribe(
  sender: TrustTaskSender,
  caller: MediatorCaller,
  subscriptionId: string,
): Promise<MonitorEnded> {
  return call(
    sender,
    caller,
    MONITOR_UNSUBSCRIBE,
    MONITOR_UNSUBSCRIBE_RESPONSE,
    "messaging/monitor/unsubscribe",
    { subscriptionId },
  );
}

/** A monitor batch, when `doc` (a Trust-Task document) is one. */
export function monitorBatchOf(doc: unknown): MonitorBatch | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as { type?: unknown; payload?: unknown };
  if (d.type !== MONITOR_EVENT) return undefined;
  const p = d.payload as Partial<MonitorBatch> | undefined;
  if (
    !p ||
    typeof p.subscriptionId !== "string" ||
    typeof p.seq !== "number" ||
    !Array.isArray(p.events) ||
    typeof p.dropped !== "number"
  ) {
    return undefined;
  }
  return p as MonitorBatch;
}

/** What a monitor feed reports, after sequencing. */
export type MonitorUpdate =
  | { kind: "events"; events: MonitorEvent[]; dropped: number }
  /** Batches that never arrived: the mediator sent them and they were lost. */
  | { kind: "gap"; missing: number }
  /** An empty batch — the tap is alive and nothing matched. */
  | { kind: "heartbeat" };

/**
 * Tracks one subscription's sequence numbers and turns batches into updates,
 * reporting a skipped `seq` as a gap before the batch that revealed it.
 *
 * A gap and `dropped` are different facts and both are shown: `dropped` is the
 * mediator saying it declined to send (a rate ceiling, or this client briefly
 * not live); a gap is batches it *did* send that did not arrive.
 */
export class MonitorSequencer {
  private last = 0;

  push(batch: MonitorBatch): MonitorUpdate[] {
    const out: MonitorUpdate[] = [];
    if (this.last > 0 && batch.seq > this.last + 1) {
      out.push({ kind: "gap", missing: batch.seq - this.last - 1 });
    }
    if (batch.seq > this.last) this.last = batch.seq;
    if (batch.events.length === 0 && batch.dropped === 0) out.push({ kind: "heartbeat" });
    else out.push({ kind: "events", events: batch.events, dropped: batch.dropped });
    return out;
  }
}

// ── Reading a queue ──────────────────────────────────────────────────────────

/** Fraction of the limit in use, 0–1. `undefined` when the mediator reports no
 *  limit — an unlimited queue has no saturation, which is not the same as 0. */
export function saturationOf(depth: Pick<QueueDepth, "count" | "limit" | "saturation">): number | undefined {
  if (typeof depth.saturation === "number") return depth.saturation;
  if (typeof depth.limit === "number" && depth.limit > 0) return depth.count / depth.limit;
  return undefined;
}
