// Data rooms — `rooms/*`.
//
// A room is a shared, credential-governed space: a set of records readable and
// writable by exactly the parties its credentials admit. Two things about the
// shape of this module follow from the design and are worth stating before the
// functions, because neither is guessable from the call signatures.
//
// ## Two services, and a call goes to exactly one of them
//
// `rooms/keys/*` go to the member's **own VTA**, which holds the group keys and
// opens and seals records. `rooms/{create,records,epoch,owner}/*` go to the
// room's **host**, which stores ciphertext it cannot read and authorises every
// operation against credentials the *room* issued — never against a list of its
// own. That is why a room can move hosts without reissuing anything, and it is
// why these helpers take `service` per call rather than binding one up front.
//
// The split is not cosmetic. Sealing a record and being allowed to store it are
// different questions asked of different parties: the VTA knows the key and
// nothing about the room's ACL; the host knows the credentials and cannot read a
// byte. A surface that wrote to a sealed room does both, in that order.
//
// ## Writing to a sealed room is two calls
//
//     roomsKeysSeal(vta, …)   → ciphertext
//     roomsRecordsPut(host, …) → stored
//
// and the `version` passed to the first must be the version the second will
// take, because it is bound into the ciphertext. Get it wrong and the record
// stores fine and never opens. `roomsWriteSealed` below does the pair correctly
// for the create-only case, which is the shape that works.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as KEYS_LIST,
  RESPONSE_TYPE_URI as KEYS_LIST_RESPONSE,
  type RoomsKeysListPayload,
  type RoomsKeysListResponsePayload,
  type PersonalLabel,
} from "@openvtc/trust-tasks/rooms/keys/list/0.2/payload";
import {
  TYPE_URI as KEYS_LIST_V01,
  RESPONSE_TYPE_URI as KEYS_LIST_V01_RESPONSE,
  type RoomsKeysListResponsePayload as RoomsKeysListV01ResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/list/0.1/payload";
import {
  TYPE_URI as KEYS_LABEL,
  RESPONSE_TYPE_URI as KEYS_LABEL_RESPONSE,
  type RoomsKeysLabelPayload,
  type RoomsKeysLabelResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/label/0.1/payload";
import {
  TYPE_URI as KEYS_OPEN,
  RESPONSE_TYPE_URI as KEYS_OPEN_RESPONSE,
  type RoomsKeysOpenPayload,
  type RoomsKeysOpenResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/open/0.1/payload";
import {
  TYPE_URI as KEYS_SEAL,
  RESPONSE_TYPE_URI as KEYS_SEAL_RESPONSE,
  type RoomsKeysSealPayload,
  type RoomsKeysSealResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/seal/0.1/payload";

/** Who is calling, and which service is being asked. */
export interface RoomsCaller {
  holder: TaskParty;
  /** The member's own VTA for `keys/*`; the room's host for everything else. */
  service: TaskParty;
}

async function call<Res>(
  sender: TrustTaskSender,
  parties: RoomsCaller,
  type: string,
  responseType: string,
  label: string,
  payload: unknown,
): Promise<Res> {
  const envelope = buildTrustTask(type, payload, {
    issuer: parties.holder.did,
    recipient: parties.service.did,
  });
  return sender.send<Res>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}

import { ROOMS_MEMBER_EXT, memberExt } from "./member.js";
export { ROOMS_MEMBER_EXT, memberExt };

export type { PersonalLabel };

/**
 * One room this VTA can open, **for one member**.
 *
 * `member` is the persona DID the entry is held as (`rooms/keys/list/0.2`).
 * `context` is the trust context its key lives in, and `actions` what the
 * room's grant to it confers — read from the listing's
 * `ext["org.openvtc.rooms"].held`, index for index with `rooms`. An `admin`
 * grant is the room's administering place (a community's own, for a room it
 * owns), anything else a member's. Both are descriptions, never authority: the
 * host decides what a member may do.
 *
 * `personal` is the member's own private label for the room, present only when
 * the list was asked for with `includePersonal` and the member has one.
 */
export type HeldRoom = RoomsKeysListResponsePayload["rooms"][number] & {
  context?: string;
  actions?: string[];
};

/** The trust context and grant of each `rooms/keys/list` entry, read from `ext`. */
function heldBy(ext: unknown, i: number): { context?: string; actions?: string[]; member?: string } {
  const held = (ext as Record<string, { held?: unknown } | undefined> | undefined)?.[ROOMS_MEMBER_EXT]?.held;
  const h = Array.isArray(held) ? (held[i] as Record<string, unknown> | undefined) : undefined;
  if (!h || typeof h !== "object") return {};
  const out: { context?: string; actions?: string[]; member?: string } = {};
  if (typeof h.member === "string") out.member = h.member;
  if (typeof h.context === "string") out.context = h.context;
  if (Array.isArray(h.actions)) out.actions = h.actions.filter((a): a is string => typeof a === "string");
  return out;
}

/** A row key for a held room: the room and the member it is held as. */
export function heldRoomKey(r: Pick<HeldRoom, "roomId" | "member">): string {
  return `${r.roomId}|${r.member}`;
}

export interface RoomsListOptions {
  /**
   * Ask for each entry's personal label (`rooms/keys/label`). **Only for the
   * member's own surfaces.** A label is what the member calls a room for
   * themselves, and a list that will be handed on — to a member portal, or any
   * page — is asked for without it, so the wallet never holds a label it is not
   * going to show (`rooms/keys/list/0.2` consumer item 3). Default `false`.
   */
  includePersonal?: boolean;
}

/**
 * The rooms this VTA holds keys for — **custody, not membership** — one entry
 * per room and member (`rooms/keys/list/0.2`).
 *
 * A room whose Welcome never arrived is absent even where a good membership
 * credential is held, and a VTA not yet told of a removal still lists a room it
 * can open but can no longer write to. Present this as what can be *read*, never
 * as authority to act: the host decides that, from credentials the room issued.
 *
 * Each entry carries two epochs and a surface wants both. `epoch` behind the
 * room's own means a commit has not been delivered; `earliestReadableEpoch`
 * equal to `epoch` means the chain has not arrived. Different repairs, and
 * without both a member reads "less than I expected" as loss rather than as a
 * delivery that has not happened.
 */
export async function roomsKeysList(
  sender: TrustTaskSender,
  parties: RoomsCaller,
  options: RoomsListOptions = {},
): Promise<HeldRoom[]> {
  const payload: RoomsKeysListPayload = options.includePersonal === true ? { includePersonal: true } : {};
  let res: RoomsKeysListResponsePayload;
  try {
    res = await call<RoomsKeysListResponsePayload>(
      sender,
      parties,
      KEYS_LIST,
      KEYS_LIST_RESPONSE,
      "rooms/keys/list/0.2",
      payload,
    );
  } catch (e) {
    if (!servesOnlyAnOlderList(e)) throw e;
    return roomsKeysListV01(sender, parties);
  }
  return (res.rooms ?? []).map((r, i) => {
    const { member: _fromExt, ...held } = heldBy(res.ext, i);
    const room: HeldRoom = { ...r, ...held };
    // Never carry a label the caller did not ask for, whatever came back.
    if (options.includePersonal !== true) delete room.personal;
    return room;
  });
}

/**
 * Whether the member's VTA refused `rooms/keys/list/0.2` for its version, which a
 * VTA one release behind does: it serves 0.1. Members update their VTAs on their
 * own schedule, so the wallet does not stop listing rooms until they do.
 */
function servesOnlyAnOlderList(e: unknown): boolean {
  const details = (e as { details?: unknown } | null)?.details;
  const code = details && typeof details === "object" ? (details as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return false;
  const local = code.slice(code.lastIndexOf(":") + 1);
  return local === "unsupportedVersion" || local === "unsupportedType";
}

/**
 * `rooms/keys/list/0.1`, for a VTA that does not serve 0.2. It names each
 * entry's member in `ext["org.openvtc.rooms"].held` rather than on the entry, and
 * has no personal labels, so none are returned whatever was asked.
 */
async function roomsKeysListV01(sender: TrustTaskSender, parties: RoomsCaller): Promise<HeldRoom[]> {
  const res = await call<RoomsKeysListV01ResponsePayload>(
    sender,
    parties,
    KEYS_LIST_V01,
    KEYS_LIST_V01_RESPONSE,
    "rooms/keys/list/0.1",
    {},
  );
  return (res.rooms ?? []).map((r, i) => {
    const held = heldBy(res.ext, i);
    return { ...r, ...held } as HeldRoom;
  });
}

/** What {@link roomsKeysLabel} changes; a detail left out stays as it is. */
export interface RoomLabelEdit {
  /** The member's name for the room: one line, up to 128 characters. */
  label?: string;
  /** Up to 1000 characters; line breaks allowed. */
  description?: string;
  /** Up to 4000 characters; line breaks allowed. */
  notes?: string;
  /** One to sixteen tags of up to 32 characters, replacing the whole set. */
  tags?: string[];
  removeLabel?: boolean;
  removeDescription?: boolean;
  removeNotes?: boolean;
  removeTags?: boolean;
}

export interface RoomsLabelParams extends RoomsCaller, RoomLabelEdit {
  roomId: string;
  /** The member the label is for — the row's `member`; never inferred. */
  member: string;
}

/**
 * The `rooms/keys/label/0.1` payload for an edit: each detail given replaces
 * the stored one, each removal removes one, and the rest stay. Refuses an edit
 * that changes nothing or both gives and removes one detail, before anything is
 * sent.
 */
export function roomLabelPayload(roomId: string, member: string, edit: RoomLabelEdit): RoomsKeysLabelPayload {
  const out: RoomsKeysLabelPayload = { roomId, member };
  let changes = 0;
  const pair = <K extends "label" | "description" | "notes">(key: K, remove: boolean | undefined) => {
    const v = edit[key];
    if (v !== undefined && remove === true) throw new Error(`rooms/keys/label: \`${key}\` is both given and removed`);
    if (v !== undefined) {
      out[key] = v;
      changes++;
    } else if (remove === true) {
      changes++;
    }
  };
  pair("label", edit.removeLabel);
  if (edit.removeLabel === true && edit.label === undefined) out.removeLabel = true;
  pair("description", edit.removeDescription);
  if (edit.removeDescription === true && edit.description === undefined) out.removeDescription = true;
  pair("notes", edit.removeNotes);
  if (edit.removeNotes === true && edit.notes === undefined) out.removeNotes = true;
  if (edit.tags !== undefined && edit.removeTags === true) throw new Error("rooms/keys/label: `tags` is both given and removed");
  if (edit.tags !== undefined) {
    if (edit.tags.length === 0) throw new Error("rooms/keys/label: give at least one tag, or remove them all");
    if (edit.tags.length > 16) throw new Error("rooms/keys/label: at most 16 tags");
    // One to sixteen, checked just above — the tuple type the schema generates.
    out.tags = edit.tags as NonNullable<RoomsKeysLabelPayload["tags"]>;
    changes++;
  } else if (edit.removeTags === true) {
    out.removeTags = true;
    changes++;
  }
  if (changes === 0) throw new Error("rooms/keys/label: the edit changes nothing");
  return out;
}

/**
 * Set, change or remove the member's own private name, description, notes and
 * tags for a room they hold (`rooms/keys/label/0.1`). Kept by their VTA beside
 * the room's keys and sent nowhere else. Idempotent: a repeat answers
 * `changed: false`. Returns the label as it now stands (`personal` absent once
 * the last detail is removed).
 *
 * A label is the member's alone: never put one in anything sent to a room, its
 * host or a community, and never hand one to a page the member has not chosen
 * to show it to.
 */
export async function roomsKeysLabel(
  sender: TrustTaskSender,
  params: RoomsLabelParams,
): Promise<RoomsKeysLabelResponsePayload> {
  const { holder, service, roomId, member, ...edit } = params;
  return call<RoomsKeysLabelResponsePayload>(
    sender,
    { holder, service },
    KEYS_LABEL,
    KEYS_LABEL_RESPONSE,
    "rooms/keys/label/0.1",
    roomLabelPayload(roomId, member, edit),
  );
}

export interface RoomsOpenParams extends RoomsCaller {
  roomId: string;
  /** The member to open as, where the VTA holds more than one of the room ({@link memberExt}). */
  member?: string;
  key: string;
  version: number;
  sealed: { ciphertext: string; nonce: string; epoch: number };
}

/**
 * Decrypt one sealed record. The key never crosses — ciphertext goes to the
 * VTA and plaintext comes back.
 *
 * A failure here is worth reading carefully rather than showing raw: the VTA
 * distinguishes "you are behind a commit" from "this history was severed or
 * never delivered", and the two have different repairs.
 */
export async function roomsKeysOpen(
  sender: TrustTaskSender,
  params: RoomsOpenParams,
): Promise<string> {
  const { holder, service, member, ...rest } = params;
  const res = await call<RoomsKeysOpenResponsePayload>(
    sender,
    { holder, service },
    KEYS_OPEN,
    KEYS_OPEN_RESPONSE,
    "rooms/keys/open/0.1",
    { ...rest, ...memberExt(member) } as unknown as RoomsKeysOpenPayload,
  );
  return res.plaintext;
}

export interface RoomsSealParams extends RoomsCaller {
  roomId: string;
  key: string;
  /**
   * The version the record will take — bound into the ciphertext, so it must
   * be the version the host is about to assign. For a create-only write that
   * is 1; for a rewrite, read the current version first.
   */
  version: number;
  /** The record body, base64url. */
  plaintext: string;
  /** The member whose group seals it, where the VTA holds more than one of the room. */
  member?: string;
}

/** Seal a record body for storage. Does not write — see the module note. */
export async function roomsKeysSeal(
  sender: TrustTaskSender,
  params: RoomsSealParams,
): Promise<RoomsKeysSealResponsePayload["sealed"]> {
  const { holder, service, member, ...rest } = params;
  const res = await call<RoomsKeysSealResponsePayload>(
    sender,
    { holder, service },
    KEYS_SEAL,
    KEYS_SEAL_RESPONSE,
    "rooms/keys/seal/0.1",
    { ...rest, ...memberExt(member) } as unknown as RoomsKeysSealPayload,
  );
  return res.sealed;
}

import {
  TYPE_URI as KEYS_PRESENT,
  RESPONSE_TYPE_URI as KEYS_PRESENT_RESPONSE,
  type RoomsKeysPresentPayload,
  type RoomsKeysPresentResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/present/0.2/payload";
import {
  TYPE_URI as KEYS_CHAIN,
  RESPONSE_TYPE_URI as KEYS_CHAIN_RESPONSE,
  type RoomsKeysChainPayload,
  type RoomsKeysChainResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/chain/0.1/payload";

export interface RoomsPresentParams extends RoomsCaller {
  roomId: string;
  /** The action the presentation must confer, and no more. */
  action: RoomAction;
}

// `audience` and `nonce` were members of `rooms/keys/present/0.1` and are gone
// from `0.2`. Neither was doing what its name suggested: `audience` at the task
// layer names the *destination* of the document, which is the agent being asked,
// not the host the presentation will later be shown to — and a room
// presentation needs no nonce, because a host binds it to whoever signed the
// envelope rather than to a challenge it issued. Removing them is what
// `dtgwg-trust-tasks-tf#418`'s cutover did; a caller that still sends them is
// refused by `additionalProperties: false`.

/**
 * Ask this agent's own VTA for a presentation of the room's credentials.
 *
 * **Every host call needs one, and only this produces one.** The credentials
 * themselves never cross — the VTA holds them and hands back a presentation
 * bound to one operation, which is why `action` and `audience` are asked for
 * rather than defaulted: a presentation minted for `read` should not open a
 * `write`, and one minted for everything hands the caller the holder's whole
 * standing.
 *
 * `nonce` is optional because a room host does not issue one. Freshness there is
 * anchored by the request document's own proof and `issuedAt` — the host binds
 * the presentation to the DID that signed the envelope, so an observed
 * presentation is not replayable by anyone else. Pass a nonce when some other
 * verifier supplies one; its absence here is a property of the host, not an
 * omission.
 *
 * ## Why the answer is checked before it is returned
 *
 * The published schemas type the two ends of this value differently: this
 * response declares `presentation` as a bare open object, while every host task
 * `$ref`s `AuthorityPresentation`, whose `membership` and `authority` are
 * REQUIRED. So the type that comes back does not fit the parameter it exists to
 * fill, and the only ways past that are a blind cast or a check.
 *
 * A blind cast moves the failure: a presentation missing its chain reaches the
 * host and comes back "no authority chain presented; a room operation is
 * authorized by the chain" — an accusation aimed at the member, three hops from
 * the agent that actually produced the empty answer. Checking here names the
 * party that did.
 */
export async function roomsKeysPresent(
  sender: TrustTaskSender,
  params: RoomsPresentParams,
): Promise<{ presentation: Presentation; expiresAt?: string }> {
  // Built as a typed literal rather than spread-and-cast: the casts elsewhere in
  // this module hide a misspelled member, and this one has moved once already.
  const payload: RoomsKeysPresentPayload = {
    roomId: params.roomId,
    action: params.action,
  };
  const res = await call<RoomsKeysPresentResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_PRESENT,
    KEYS_PRESENT_RESPONSE,
    "rooms/keys/present/0.2",
    payload,
  );

  const got = res.presentation as Partial<Presentation> | undefined;
  if (!got || typeof got.membership !== "string" || !Array.isArray(got.authority)) {
    throw new Error(
      `${params.service.did} returned a presentation for room ${params.roomId} with no ` +
        `membership credential or no authority chain. A host authorizes from the chain ` +
        `alone, so it would refuse this — and the refusal would read as if the member ` +
        `lacked authority rather than as an agent that answered incompletely.`,
    );
  }

  return {
    presentation: got as Presentation,
    ...(res.expiresAt ? { expiresAt: res.expiresAt } : {}),
  };
}

/**
 * Hand this agent's own VTA the rungs its principal fetched from the host.
 *
 * The last leg of a joining member's backfill, and the repair for a room that
 * reads only from the epoch its holder joined at. The VTA accrues a rung for
 * every membership change it lives through; this is for the history it did not.
 *
 * **The response is the answer worth having.** `earliestReadableEpoch` is not a
 * restatement of what was sent — a rung extends reach only if every rung above
 * it is present too, so a set with a gap in it is reported here rather than at
 * the first record that will not open, which reads like corruption.
 */
import {
  TYPE_URI as KEYS_BACKFILL,
  RESPONSE_TYPE_URI as KEYS_BACKFILL_RESPONSE,
  type RoomsKeysBackfillPayload,
  type RoomsKeysBackfillResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/backfill/0.1/payload";

/**
 * Ask this agent to fetch the room's history from its host, and keep it.
 *
 * **The repair for a room that reads only from where its holder joined**, and
 * the one call a surface can make for it. What it folds together is three hops
 * — mint a presentation, ask the host for the rungs, store them — of which a
 * browser can make the first and third and not the second. The agent makes all
 * three, being the party with a channel to the host.
 *
 * `host` is named because nothing maps a room to one. A room is portable, so a
 * host a surface remembered would go stale the moment the room moved; the agent
 * holds key custody, which is a different fact. A member learned the host from
 * whoever invited them.
 *
 * **Read the three numbers together.** `fetched` is what the host served,
 * `stored` how many were new, and `earliestReadableEpoch` how far back the agent
 * can now actually derive a key — which is the only one that answers the
 * question. Rungs that arrive below a gap extend reach not at all, so a surface
 * reporting `stored` alone would celebrate over a room that still cannot open a
 * word of its history.
 */
export async function roomsKeysBackfill(
  sender: TrustTaskSender,
  params: RoomsCaller & { roomId: string; host: string; fromEpoch?: number; limit?: number; member?: string },
): Promise<RoomsKeysBackfillResponsePayload> {
  const payload: RoomsKeysBackfillPayload = {
    roomId: params.roomId,
    host: params.host,
    ...(params.fromEpoch !== undefined ? { fromEpoch: params.fromEpoch } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...memberExt(params.member),
  };
  return call<RoomsKeysBackfillResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_BACKFILL,
    KEYS_BACKFILL_RESPONSE,
    "rooms/keys/backfill/0.1",
    payload,
  );
}

import {
  TYPE_URI as KEYS_READ,
  RESPONSE_TYPE_URI as KEYS_READ_RESPONSE,
  type RoomsKeysReadPayload,
  type RoomsKeysReadResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/read/0.1/payload";
import {
  TYPE_URI as KEYS_BROWSE,
  RESPONSE_TYPE_URI as KEYS_BROWSE_RESPONSE,
  type RoomsKeysBrowsePayload,
  type RoomsKeysBrowseResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/browse/0.1/payload";

/**
 * Ask this agent to read one record from a room's host — and to check what the
 * host said about it on the way through.
 *
 * **This is how a console reads a record at all.** `rooms/records/*` is served
 * by the host, and `carrierParams` passes only `{type, payload}` while the
 * offscreen document supplies its own agent as the recipient — so a `service`
 * naming a host is dropped and the call lands somewhere that does not serve it.
 * The same reason `roomsKeysBackfill` exists.
 *
 * **The agent verifies; this renders.** Do not re-implement the check here. The
 * epoch key never leaves the agent, so it is the only party that can open the
 * record, and it is the only party on the member's side that remembers what this
 * host said last time. `verification` is its account of both.
 *
 * **`verification` is a verdict, never a failure.** An adverse value still
 * returns the record — a member's own agent refusing because the *host*
 * misbehaved would punish them for somebody else's act, and lock them out of
 * the room holding the records that would show what happened. The consequence
 * belongs on the write path. A surface that treats an adverse verdict as an
 * error has inverted the design.
 */
export async function roomsKeysRead(
  sender: TrustTaskSender,
  params: RoomsCaller & { roomId: string; host: string; key: string; member?: string },
): Promise<RoomsKeysReadResponsePayload> {
  const payload: RoomsKeysReadPayload = {
    roomId: params.roomId,
    host: params.host,
    key: params.key,
    ...memberExt(params.member),
  };
  return call<RoomsKeysReadResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_READ,
    KEYS_READ_RESPONSE,
    "rooms/keys/read/0.1",
    payload,
  );
}

/**
 * Ask this agent to list a room's records at its host, and to check the listing
 * against what the host committed to.
 *
 * Metadata, never bodies — a property of the task rather than of the tier, and
 * why this and {@link roomsKeysRead} are two calls: looking at a room's shelf
 * should not decrypt the room.
 *
 * **`limit` is the page size to ask the host for, never a cap on the result.**
 * The agent follows the host's cursor and reports `complete`. A caller that
 * treats `limit` as "give me N" gets N and a listing that is not comparable
 * against anything — see below.
 *
 * **`verification.count` is the check this call exists for**, and it is narrow.
 * A reader cannot recompute a room's root from a listing, but it can *count*: a
 * host that omits a record while committing to a tree that holds it contradicts
 * itself inside one exchange, with no second party and no anchor. It means
 * something **only** when `complete` is true and neither `prefix` nor
 * `sinceVersion` was set; anything else is `notComparable`, which will be the
 * common answer and is not a fault.
 */
export async function roomsKeysBrowse(
  sender: TrustTaskSender,
  params: RoomsCaller & {
    roomId: string;
    host: string;
    prefix?: string;
    sinceVersion?: number;
    limit?: number;
    /** The member to read as, where the VTA holds more than one of the room. */
    member?: string;
  },
): Promise<RoomsKeysBrowseResponsePayload> {
  const payload: RoomsKeysBrowsePayload = {
    roomId: params.roomId,
    host: params.host,
    ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
    ...(params.sinceVersion !== undefined ? { sinceVersion: params.sinceVersion } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...memberExt(params.member),
  };
  return call<RoomsKeysBrowseResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_BROWSE,
    KEYS_BROWSE_RESPONSE,
    "rooms/keys/browse/0.1",
    payload,
  );
}

export async function roomsKeysChain(
  sender: TrustTaskSender,
  params: RoomsCaller & { roomId: string; links: EpochLink[]; member?: string },
): Promise<RoomsKeysChainResponsePayload> {
  const payload: RoomsKeysChainPayload = {
    ...memberExt(params.member),
    roomId: params.roomId,
    // `links` is `[EpochLink, ...EpochLink[]]` — the schema's `minItems: 1`. A
    // caller with nothing to deliver must not send an empty delivery, so the
    // narrowing is here rather than left to the agent to reject.
    links: params.links as RoomsKeysChainPayload["links"],
  };
  return call<RoomsKeysChainResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_CHAIN,
    KEYS_CHAIN_RESPONSE,
    "rooms/keys/chain/0.1",
    payload,
  );
}

// ── The host side ────────────────────────────────────────────────────────
//
// Everything below goes to the room's HOST and carries an authority
// presentation — the credentials the room issued, which is the only thing a
// host consults. Mint one with `roomsKeysPresent` above; nothing else in this
// library produces one, and a caller that has none cannot do these at all.
//
// **The browser console cannot call any of these, and that is a property of the
// extension rather than of this module.** Its bridge (`manager/carrier.ts`)
// passes exactly `{type, payload}` — so that the offscreen document mints and
// signs the envelope rather than counter-signing one composed in a page — and
// the background then addresses it to the wallet's own VTA. A `service` naming a
// host is therefore dropped, and the call lands at an agent that does not serve
// it. Nothing type-checks as wrong; it simply goes to the wrong party.
//
// A surface holding a channel to a host of its own — a server-side consumer, a
// CLI — uses these directly. A surface that only reaches its own agent asks the
// agent to make the call: `rooms/keys/backfill` and `rooms/owner/register`
// (trustoverip/dtgwg-trust-tasks-tf#402) exist for exactly that, and will appear
// above, in the VTA-terminating half, once they ship.

import {
  TYPE_URI as ROOMS_CREATE,
  RESPONSE_TYPE_URI as ROOMS_CREATE_RESPONSE,
  type RoomsCreatePayload,
  type RoomsCreateResponsePayload,
} from "@openvtc/trust-tasks/rooms/create/0.1/payload";
import {
  TYPE_URI as RECORDS_LIST,
  RESPONSE_TYPE_URI as RECORDS_LIST_RESPONSE,
  type RoomsRecordsListPayload,
  type RoomsRecordsListResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/list/0.1/payload";
import {
  TYPE_URI as RECORDS_GET,
  RESPONSE_TYPE_URI as RECORDS_GET_RESPONSE,
  type RoomsRecordsGetPayload,
  type RoomsRecordsGetResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/get/0.1/payload";
import {
  TYPE_URI as RECORDS_PUT,
  RESPONSE_TYPE_URI as RECORDS_PUT_RESPONSE,
  type RoomsRecordsPutPayload,
  type RoomsRecordsPutResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/put/0.1/payload";
import {
  TYPE_URI as EPOCH_MINT,
  RESPONSE_TYPE_URI as EPOCH_MINT_RESPONSE,
  type RoomsEpochMintPayload,
  type RoomsEpochMintResponsePayload,
} from "@openvtc/trust-tasks/rooms/epoch/mint/0.1/payload";
import {
  TYPE_URI as EPOCH_CHAIN,
  RESPONSE_TYPE_URI as EPOCH_CHAIN_RESPONSE,
  type RoomsEpochChainPayload,
  type RoomsEpochChainResponsePayload,
  type EpochLink,
} from "@openvtc/trust-tasks/rooms/epoch/chain/0.1/payload";

/** One rung of the epoch key chain: an epoch's storage key sealed under the next. */
export type { EpochLink };

/** The credentials a caller presents to a host. Opaque here. */
export type Presentation = RoomsRecordsListPayload["presentation"];

export interface RoomsHostCall extends RoomsCaller {
  roomId: string;
  presentation: Presentation;
}

/** Register a room with a host. The room's DID is minted before this call. */
export async function roomsCreate(
  sender: TrustTaskSender,
  params: RoomsCaller & {
    roomId: string;
    ownerDid: string;
    visibility: "open" | "attributed" | "private";
    retentionDays?: number;
  },
): Promise<RoomsCreateResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    ROOMS_CREATE,
    ROOMS_CREATE_RESPONSE,
    "rooms/create/0.1",
    rest as unknown as RoomsCreatePayload,
  );
}

/** Record metadata. Bodies come from `roomsRecordsGet`, one at a time. */
export async function roomsRecordsList(
  sender: TrustTaskSender,
  params: RoomsHostCall & { prefix?: string; sinceVersion?: number; limit?: number },
): Promise<RoomsRecordsListResponsePayload["records"]> {
  const { holder, service, ...rest } = params;
  const res = await call<RoomsRecordsListResponsePayload>(
    sender,
    { holder, service },
    RECORDS_LIST,
    RECORDS_LIST_RESPONSE,
    "rooms/records/list/0.1",
    rest as unknown as RoomsRecordsListPayload,
  );
  return res.records ?? [];
}

/** One record. On a sealed tier the body is ciphertext — open it with the VTA. */
export async function roomsRecordsGet(
  sender: TrustTaskSender,
  params: RoomsHostCall & { key: string },
): Promise<RoomsRecordsGetResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    RECORDS_GET,
    RECORDS_GET_RESPONSE,
    "rooms/records/get/0.1",
    rest as unknown as RoomsRecordsGetPayload,
  );
}

/** Store a record. `sealed` on the sealed tiers, `cleartext` on `open`. */
export async function roomsRecordsPut(
  sender: TrustTaskSender,
  params: RoomsHostCall & {
    key: string;
    expectedVersion?: number;
    sealed?: { ciphertext: string; nonce: string; epoch: number };
    cleartext?: { title?: string; description?: string; body: string; tags?: string[] };
  },
): Promise<RoomsRecordsPutResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    RECORDS_PUT,
    RECORDS_PUT_RESPONSE,
    "rooms/records/put/0.1",
    rest as unknown as RoomsRecordsPutPayload,
  );
}

/**
 * Fetch the room's epoch key chain from its host.
 *
 * The first of the two hops that repair a member who can only read from where
 * they joined. This gets the rungs; [`roomsKeysChain`] hands them to the
 * member's own VTA, which is the only party that can say how far back they
 * actually reach.
 *
 * **Needs a `read` presentation, not a special one.** Reading the room and
 * reading the parts written earlier are the same act, so they take the same
 * grant — a separate one would be a grant nobody could explain.
 *
 * What comes back is ciphertext the host cannot read: a rung is an epoch's
 * storage key sealed under the next, and no host holds either. Serving them to a
 * party with no epoch key discloses only how many epochs there have been, which
 * the room's epoch number already said.
 */
export async function roomsEpochChain(
  sender: TrustTaskSender,
  params: RoomsHostCall & { fromEpoch?: number; limit?: number },
): Promise<EpochLink[]> {
  const { holder, service, ...rest } = params;
  const res = await call<RoomsEpochChainResponsePayload>(
    sender,
    { holder, service },
    EPOCH_CHAIN,
    EPOCH_CHAIN_RESPONSE,
    "rooms/epoch/chain/0.1",
    rest as unknown as RoomsEpochChainPayload,
  );
  return res.links ?? [];
}

/**
 * Renew the room by minting its next epoch. Needs `admin`.
 *
 * This is the whole lifecycle clock: a room in use renews itself in the course
 * of being used, and one nobody has committed to in a year has said something
 * real about itself. There is no separate "renew" verb and there should not be
 * — one that could be called without committing would let a room look live
 * while its key material stood still.
 */
export async function roomsEpochMint(
  sender: TrustTaskSender,
  params: RoomsHostCall & {
    epoch: number;
    link?: { epoch: number; wrapped: string; nonce: string };
    reason?: string;
  },
): Promise<RoomsEpochMintResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    EPOCH_MINT,
    EPOCH_MINT_RESPONSE,
    "rooms/epoch/mint/0.1",
    rest as unknown as RoomsEpochMintPayload,
  );
}

import {
  TYPE_URI as OWNER_REGISTER,
  RESPONSE_TYPE_URI as OWNER_REGISTER_RESPONSE,
  type RoomsOwnerRegisterPayload,
  type RoomsOwnerRegisterResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/register/0.1/payload";

/**
 * Ask this agent to register a room with a host.
 *
 * `rooms/create` performed by the agent, and the reason to prefer it over
 * calling `roomsCreate` directly is not convenience: a surface that reaches only
 * its own agent **cannot** call `roomsCreate` at all, because the recipient it
 * names never travels. This one is addressed to the agent, which can.
 *
 * The order it belongs in is unchanged: the room's identity is minted first —
 * a separate act this does not perform — and a host is then told about a room
 * that already exists. A host that named the room would be a host the room could
 * not leave.
 *
 * `host` in the response is what the agent actually reached, which is the value
 * worth recording. Normally identical to what was asked for; where it is not, a
 * caller storing its own request would hold a host it never spoke to.
 */
export async function roomsOwnerRegister(
  sender: TrustTaskSender,
  params: RoomsCaller & {
    roomId: string;
    host: string;
    visibility: "open" | "attributed" | "private";
    ownerDid?: string;
    retentionDays?: number;
  },
): Promise<RoomsOwnerRegisterResponsePayload> {
  const payload = {
    roomId: params.roomId,
    host: params.host,
    visibility: params.visibility,
    ...(params.ownerDid ? { ownerDid: params.ownerDid } : {}),
    ...(params.retentionDays !== undefined ? { retentionDays: params.retentionDays } : {}),
  } as RoomsOwnerRegisterPayload;
  return call<RoomsOwnerRegisterResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    OWNER_REGISTER,
    OWNER_REGISTER_RESPONSE,
    "rooms/owner/register/0.1",
    payload,
  );
}

// ── Owner issuance ───────────────────────────────────────────────────────
//
// These go to the owner's own VTA, which signs AS the room with a key it
// holds. `signingKeyId` names that key — it is not looked up from `roomId`,
// because nothing maps a DID to the key it was minted with, and a mapping
// invented for convenience is a mapping that goes stale after a rotation.
//
// The pair you need comes from minting the room's DID: `vta/webvh/dids/create`
// with `template: "room"` returns both `did` and `signingKeyId`. Keep them
// together — the DID alone cannot issue anything.

import {
  TYPE_URI as OWNER_INVITE,
  RESPONSE_TYPE_URI as OWNER_INVITE_RESPONSE,
  type RoomsOwnerInvitePayload,
  type RoomsOwnerInviteResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/invite/0.1/payload";
import {
  TYPE_URI as OWNER_MEMBERSHIP,
  RESPONSE_TYPE_URI as OWNER_MEMBERSHIP_RESPONSE,
  type RoomsOwnerIssueMembershipPayload,
  type RoomsOwnerIssueMembershipResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/issue-membership/0.1/payload";
import {
  TYPE_URI as OWNER_AUTHORITY,
  RESPONSE_TYPE_URI as OWNER_AUTHORITY_RESPONSE,
  type RoomsOwnerIssueAuthorityPayload,
  type RoomsOwnerIssueAuthorityResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/issue-authority/0.2/payload";

/** What every issuance names: the room, and the key that signs as it. */
export interface RoomsIssueCall extends RoomsCaller {
  roomId: string;
  signingKeyId: string;
  subject: string;
  validUntil?: string;
}

/** A signed credential, and its id. */
export interface IssuedCredential {
  credential: string;
  credentialId: string;
}

/**
 * Mint an invitation. **Joining is consent, and this is the artefact.**
 *
 * Without it an owner seals a room key to somebody's agent and they are simply
 * in — holding keys to material they may not want, having agreed to nothing.
 * Single-use, and consumed on entry rather than presented per access, because
 * it names its subject and presenting it would disclose the member.
 */
export async function roomsOwnerInvite(
  sender: TrustTaskSender,
  params: RoomsIssueCall,
): Promise<IssuedCredential> {
  const { holder, service, ...rest } = params;
  return call<RoomsOwnerInviteResponsePayload>(
    sender,
    { holder, service },
    OWNER_INVITE,
    OWNER_INVITE_RESPONSE,
    "rooms/owner/invite/0.1",
    rest as unknown as RoomsOwnerInvitePayload,
  );
}

/**
 * Mint the membership credential a member presents on every operation.
 *
 * The host holds no roster, so **this credential is the membership**. Omitting
 * `validUntil` means it does not lapse — and removal is then an epoch advance
 * rather than an expiry, which is the honest mechanism: letting a credential
 * lapse stops a member presenting it and does not stop them reading what they
 * could already read.
 */
export async function roomsOwnerIssueMembership(
  sender: TrustTaskSender,
  params: RoomsIssueCall,
): Promise<IssuedCredential> {
  const { holder, service, ...rest } = params;
  return call<RoomsOwnerIssueMembershipResponsePayload>(
    sender,
    { holder, service },
    OWNER_MEMBERSHIP,
    OWNER_MEMBERSHIP_RESPONSE,
    "rooms/owner/issue-membership/0.1",
    rest as unknown as RoomsOwnerIssueMembershipPayload,
  );
}

/** What a grant may confer. `curate` is not implied by `write`. */
export type RoomAction = "read" | "write" | "curate" | "admin";

/**
 * Grant authority — a chain root at the room's scope.
 *
 * `admin` is the authority to mint epochs and hand the room on, so it is not a
 * larger `write`. A holder who wants to give an agent less than they hold does
 * not come back here: they attenuate their own grant, which needs no issuer and
 * is what makes a leaked agent capability not a leaked member capability.
 */
export async function roomsOwnerIssueAuthority(
  sender: TrustTaskSender,
  params: RoomsIssueCall & { actions: RoomAction[] },
): Promise<IssuedCredential> {
  const { holder, service, ...rest } = params;
  return call<RoomsOwnerIssueAuthorityResponsePayload>(
    sender,
    { holder, service },
    OWNER_AUTHORITY,
    OWNER_AUTHORITY_RESPONSE,
    "rooms/owner/issue-authority/0.2",
    rest as unknown as RoomsOwnerIssueAuthorityPayload,
  );
}

// Acting as the member — the persona, never this wallet (`rooms/keys/act`).
export * from "./act.js";

// A community's offers of its own rooms, read as the member — for their names.
export * from "./offers.js";

// Accepting one of those offers: credentials into the VTA, a KeyPackage it
// mints, the acceptance as the member, and the Welcome back to the VTA.
export * from "./offer-accept.js";

// The room's own profile — what it calls itself, read through the member's VTA.
export * from "./profile.js";
