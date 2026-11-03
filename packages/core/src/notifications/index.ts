// Notifications held for the principal (VTI-NTF-001 – 074), the member's side.
//
// A notification is a signed statement by an originator that a thing exists
// which the addressee, or the parties it stands for, may take part in: where it
// is held (`subject.heldBy`), its identifier there (`subject.id`), the Trust
// Task that opens it (`subject.openWith`) and the audience it concerns. It
// carries nothing of the thing, confers no authority and is no evidence that
// anyone may take part (VTI-NTF-003, VTI-NTF-004).
//
// The principal's VTA holds what it accepts, in the trust context of the DID it
// was addressed to (VTI-NTF-050). A client with standing there lists, reads and
// dismisses them (`vta/notifications/{list,show,dismiss}/0.1`). None of those
// tells anybody anything, and opening the thing is the client's step, taken
// only at the principal's choice (VTI-NTF-053).
//
// **Deposit.** A client that receives a `notifications/notify` or
// `notifications/relay` for a DID whose keys its VTA holds — a persona DID
// whose mediator socket the client holds — hands it to the VTA exactly as
// received (`vta/notifications/deposit/0.1`, VTI-NTF-054): the received JSON
// itself, never a value rebuilt from a typed form or re-signed, and every such
// document, because not depositing one is declining it, which is the VTA's
// acceptance policy's decision. It answers the sender itself with
// {@link notificationReceiptOf}, the same whatever the VTA answered.
//
// The reference client is `pnm notifications` (verifiable-trust-infrastructure
// `vta-cli-common/src/commands/notifications.rs`).

import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import type {
  HeldNotification,
  Notification,
  VTANotificationsListPayload,
  VTANotificationsListResponsePayload,
} from "../specs/vta/notifications/list/0.1/payload.js";
import {
  TYPE_URI as LIST,
  RESPONSE_TYPE_URI as LIST_RESPONSE,
} from "../specs/vta/notifications/list/0.1/payload.js";
import {
  TYPE_URI as SHOW,
  RESPONSE_TYPE_URI as SHOW_RESPONSE,
  type VTANotificationsShowResponsePayload,
} from "../specs/vta/notifications/show/0.1/payload.js";
import {
  TYPE_URI as DISMISS,
  RESPONSE_TYPE_URI as DISMISS_RESPONSE,
  type VTANotificationsDismissResponsePayload,
} from "../specs/vta/notifications/dismiss/0.1/payload.js";
import {
  TYPE_URI as DEPOSIT,
  RESPONSE_TYPE_URI as DEPOSIT_RESPONSE,
  type VTANotificationsDepositResponsePayload,
} from "../specs/vta/notifications/deposit/0.1/payload.js";
import { TYPE_URI as NOTIFY } from "../specs/notifications/notify/0.1/payload.js";
import { TYPE_URI as RELAY } from "../specs/notifications/relay/0.1/payload.js";
import { TYPE_URI as ELECTIONS_SHOW } from "../specs/vtc/elections/show/0.6/payload.js";

export type { HeldNotification, Notification };
export {
  NOTIFY as NOTIFICATIONS_NOTIFY_TYPE,
  RELAY as NOTIFICATIONS_RELAY_TYPE,
  LIST as NOTIFICATIONS_LIST_TYPE,
  SHOW as NOTIFICATIONS_SHOW_TYPE,
  DISMISS as NOTIFICATIONS_DISMISS_TYPE,
  DEPOSIT as NOTIFICATIONS_DEPOSIT_TYPE,
};

/** The registered kind of an election notification (Appendix G, VTI-NTF-060). */
export const ELECTION_KIND = "election";

/** A relay carries at most four relays in all (`notifications/relay/0.1`). */
const MAX_RELAYS = 4;

/** Who the VTA is asked as, and which VTA. */
export interface NotificationsAgent {
  holder: { did: string };
  service: { did: string };
}

function ask<R>(
  sender: TrustTaskSender,
  agent: NotificationsAgent,
  type: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<R> {
  const envelope = buildTrustTask(type, payload, { issuer: agent.holder.did, recipient: agent.service.did });
  return sender.send<R>(envelope, { expectedResponseType: responseType, operationLabel: type.slice(type.indexOf("/spec/") + 6) });
}

/** The filters `vta/notifications/list/0.1` takes, beside its context. */
export type NotificationsListFilter = Omit<VTANotificationsListPayload, "contextId" | "ext">;

/** One page of the notifications the VTA holds in `contextId` — active ones,
 *  whose thing can still be acted on, unless asked for more. */
export function notificationsList(
  sender: TrustTaskSender,
  agent: NotificationsAgent,
  contextId: string,
  filter: NotificationsListFilter = {},
): Promise<VTANotificationsListResponsePayload> {
  return ask(sender, agent, LIST, LIST_RESPONSE, { contextId, ...filter });
}

/** Every page of {@link notificationsList}, up to `max` items. A VTA that
 *  hands back a cursor it handed back before is not followed round again. */
export async function notificationsListAll(
  sender: TrustTaskSender,
  agent: NotificationsAgent,
  contextId: string,
  filter: Omit<NotificationsListFilter, "cursor"> = {},
  max = 1000,
): Promise<HeldNotification[]> {
  const items: HeldNotification[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await notificationsList(sender, agent, contextId, { ...filter, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }
  } while (cursor !== undefined && items.length < max);
  return items.slice(0, max);
}

/** One held notification, with the document that delivered it exactly as the
 *  VTA received it — for the reader to verify, not to re-serialise. */
export function notificationsShow(
  sender: TrustTaskSender,
  agent: NotificationsAgent,
  contextId: string,
  recordId: string,
): Promise<VTANotificationsShowResponsePayload> {
  return ask(sender, agent, SHOW, SHOW_RESPONSE, { contextId, recordId });
}

/** Dismiss one: it leaves the default list, stays readable, and nobody is told. */
export function notificationsDismiss(
  sender: TrustTaskSender,
  agent: NotificationsAgent,
  contextId: string,
  recordId: string,
): Promise<VTANotificationsDismissResponsePayload> {
  return ask(sender, agent, DISMISS, DISMISS_RESPONSE, { contextId, recordId });
}

/**
 * Hand the VTA a notify or relay this client received for a DID whose keys it
 * holds in `contextId` (VTI-NTF-054). `document` is the received JSON object
 * itself and is carried unchanged: never rebuild it from a typed form, never
 * sign it. The VTA applies its acceptance window at the deposit, so deposit
 * promptly — late is `vta/notifications/deposit:documentInvalid`.
 *
 * The VTA answers the same receipt whether it held, declined or discarded the
 * notification (VTI-NTF-023), so the answer says nothing a caller should act
 * on; {@link notificationReceiptOf} is what the sender is answered with.
 */
export function notificationsDeposit(
  sender: TrustTaskSender,
  agent: NotificationsAgent,
  contextId: string,
  document: Record<string, unknown>,
): Promise<VTANotificationsDepositResponsePayload> {
  return ask(sender, agent, DEPOSIT, DEPOSIT_RESPONSE, { contextId, document });
}

/** A received `notifications/notify/0.1` or `notifications/relay/0.1` document,
 *  as received. */
export interface InboundNotification {
  /** The received document, the same object — what a deposit carries. */
  document: Record<string, unknown>;
  /** The document's `recipient`: the DID it was delivered to. */
  recipient: string;
  type: typeof NOTIFY | typeof RELAY;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The notify or relay a Trust-Task document is, or `null`. Recognises the
 * document by its `type` alone, which is what decides that a deposit is owed:
 * whether it verifies, and whether it is accepted, is the VTA's to decide
 * (VTI-NTF-054, VTI-NTF-055), so nothing else is checked here. Returns the same
 * object it was given.
 */
export function inboundNotificationOf(document: unknown): InboundNotification | null {
  if (!isObject(document)) return null;
  const type = document.type;
  if (type !== NOTIFY && type !== RELAY) return null;
  if (typeof document.recipient !== "string") return null;
  return { document, recipient: document.recipient, type };
}

/**
 * What the sender of a notify or relay is answered with: the innermost
 * notification's `notificationId` and `revision` (`notifications/notify/0.1`
 * and `notifications/relay/0.1` responses). The same whatever the VTA did with
 * a deposit, and never saying which (VTI-NTF-023). `null` when the document
 * does not carry a notification within four relays.
 */
export function notificationReceiptOf(document: unknown): { notificationId: string; revision: number } | null {
  let doc: unknown = document;
  for (let relays = 0; relays <= MAX_RELAYS; relays++) {
    if (!isObject(doc) || !isObject(doc.payload)) return null;
    if (doc.type === NOTIFY) {
      const n = doc.payload.notification;
      if (!isObject(n) || typeof n.notificationId !== "string" || typeof n.revision !== "number") return null;
      return { notificationId: n.notificationId, revision: n.revision };
    }
    if (doc.type !== RELAY) return null;
    doc = doc.payload.forwarded;
  }
  return null;
}

/** A held notification of the kind `election`, as VTI-NTF-063 lets a member's
 *  agent show it until the member opens it: its community, identifier,
 *  audience and period — and nothing else. */
export interface NotifiedElection {
  recordId: string;
  contextId: string;
  /** The community holding the election: where it is read from. */
  community: string;
  electionId: string;
  /** The DID whose members the election is put to — under a credential roll,
   *  the party whose membership credential a reader presents (VTI-VOT-016). */
  audience: string;
  /** The DID the notification, or the relay that delivered it, was addressed to. */
  addressee: string;
  /** Who said the election exists, and who passed it on, in order. */
  originator: string;
  relayedBy: string[];
  status: "available" | "withdrawn";
  /** When voting opens and closes, where the notification states it. */
  votingOpensAt?: string;
  votingClosesAt?: string;
  /** Whether the notification names a version of `vtc/elections/show` other
   *  than the one this library reads with. It is read with this library's. */
  openWith: string;
  dismissed: boolean;
}

/** {@link NotifiedElection} from a held notification, or `null` when it is not
 *  of the kind `election`. */
export function notifiedElectionOf(held: HeldNotification): NotifiedElection | null {
  const n = held.notification;
  if (n.kind !== ELECTION_KIND) return null;
  return {
    recordId: held.recordId,
    contextId: held.contextId,
    community: n.subject.heldBy,
    electionId: n.subject.id,
    audience: n.audience,
    addressee: held.addressee,
    originator: held.originator,
    relayedBy: [...held.relayedBy],
    status: n.status,
    ...(n.validFrom !== undefined ? { votingOpensAt: n.validFrom } : {}),
    ...(n.validUntil !== undefined ? { votingClosesAt: n.validUntil } : {}),
    openWith: n.subject.openWith,
    dismissed: held.state === "dismissed",
  };
}

/** The `vtc/elections/show` version this library opens an election with. */
export const ELECTION_OPEN_WITH = ELECTIONS_SHOW;
