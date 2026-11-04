// A community's offers of its own rooms — `vtc/rooms/offers/list/0.4` — and its
// record of where each admission stands — `vtc/rooms/memberships/list/0.2` — read
// as the member.
//
// A community that owns a room offers its members admission to it
// (`vtc/rooms/community/members/add`), and the offer carries the room's
// `label`, `visibility` and `description` as the community's administrators set them. The
// member reads their offers with a document signed as the DID the offers are
// addressed to — a persona their VTA holds — so the wallet builds the request
// unsigned and has the VTA complete it as that DID (`rooms/keys/act/0.11`, which
// inserts no presentation for the community's types), then sends it to the
// community unchanged. That is the CLI's `pnm rooms offers list`, step for step.
//
// ## One record, every surface
//
// The member reaches these rooms from the community's portal (through this
// wallet), from `pnm`, from OpenVTC. None keeps its own note of which rooms the
// member accepted: each reads the community's record
// (`communityRoomMemberships`) beside the VTA's custody (`roomsKeysList`) and
// derives the same standing (`roomStanding`), so a room accepted in one is joined
// in all of them (`vtc/rooms/memberships/list/0.2`, *One record, every surface*).
//
// The wallet reads offers here only for the **names** of the community's rooms:
// what the room's DID alone does not tell a person. A label is the community's
// metadata about a room it owns, never the room's content. Rooms a member owns
// have no such name (a sealed in-room profile is the answer for those).

import type { TrustTaskSender, TaskParty } from "../vta/channel.js";

import { roomsKeysAct, unsignedRoomRequest, type CompletedDocumentSender } from "./act.js";

import {
  TYPE_URI as OFFERS_LIST,
  RESPONSE_TYPE_URI as OFFERS_LIST_RESPONSE,
  type VTCRoomsOffersListPayload,
  type VTCRoomsOffersListResponsePayload,
  type OfferV2,
  type Renewal,
} from "../specs/vtc/rooms/offers/list/0.4/payload.js";

import {
  TYPE_URI as MEMBERSHIPS_LIST,
  RESPONSE_TYPE_URI as MEMBERSHIPS_LIST_RESPONSE,
  type VTCRoomsMembershipsListPayload,
  type VTCRoomsMembershipsListResponsePayload,
  type RoomMembershipV2 as RoomMembership,
} from "../specs/vtc/rooms/memberships/list/0.2/payload.js";

/** One offer: list 0.4's `OfferV2` — the room's label, tier and, when it has one, its `description`. */
export type { OfferV2 as CommunityRoomOffer };
export type { RoomMembership as CommunityRoomMembership };

/** What reading a member's offers needs: the wallet, the member's VTA, the community, the member. */
export interface OfferReader {
  /** The wallet's DID — the caller of the VTA task. It reaches no community. */
  holder: TaskParty;
  vta: { did: string; sender: TrustTaskSender };
  /** The community that made the offers, and a channel for documents the VTA completed. */
  community: { did: string; sender: CompletedDocumentSender };
  /** The DID the community addressed its offers to: a persona the VTA holds. */
  member: string;
}

/**
 * The party a failed offer read came from: the member's VTA, refusing to
 * complete the request as the member (`act`), or the community, refusing or
 * failing to answer it (`community`).
 *
 * Reading offers talks to two parties in turn, and a refusal means something
 * different from each: `unsupportedType` from the VTA is an agent that must be
 * updated, from the community a party that makes no room offers. So the read
 * says which one answered, and a caller maps the refusal by its source.
 */
export type OfferReadStage = "act" | "community";

/** A failed offer read, tagged with the party that produced it. `inner` is that party's error, unchanged. */
export class OfferReadError extends Error {
  constructor(
    readonly stage: OfferReadStage,
    readonly inner: unknown,
  ) {
    super(inner instanceof Error ? inner.message : String(inner));
    this.name = "OfferReadError";
  }
}

/** Pages read at most: 100 offers a page is more rooms than any member is offered. */
const MAX_PAGES = 10;

/**
 * Every offer `reader.community` has made to `reader.member` and still lists:
 * open ones, and accepted ones while a repeated accept can be answered (the
 * reference community keeps those seven days).
 */
export async function communityRoomOffers(reader: OfferReader): Promise<OfferV2[]> {
  return readPages<VTCRoomsOffersListPayload, VTCRoomsOffersListResponsePayload, OfferV2>(
    reader,
    OFFERS_LIST,
    OFFERS_LIST_RESPONSE,
    "vtc/rooms/offers/list/0.4",
  );
}

/**
 * The community's record of every room it has offered `reader.member`, in every
 * state — `offered`, `admitted`, `suspended`, `removed` — with the room's own
 * state beside each (`roomState`: archived, scheduled for removal, removed),
 * for as long as it keeps the record
 * (`vtc/rooms/memberships/list/0.2`). No credentials: those come with an open
 * offer (`communityRoomOffers`).
 */
export async function communityRoomMemberships(reader: OfferReader): Promise<RoomMembership[]> {
  return readPages<VTCRoomsMembershipsListPayload, VTCRoomsMembershipsListResponsePayload, RoomMembership>(
    reader,
    MEMBERSHIPS_LIST,
    MEMBERSHIPS_LIST_RESPONSE,
    "vtc/rooms/memberships/list/0.2",
  );
}

/** A paged list the community answers as the member, through the VTA. `onPage` sees each reply whole. */
async function readPages<P extends { cursor?: string }, R extends { items: T[]; nextCursor?: string }, T>(
  reader: OfferReader,
  type: string,
  responseType: string,
  label: string,
  onPage?: (reply: R) => void,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = (cursor !== undefined ? { cursor } : {}) as P;
    let document: Record<string, unknown>;
    try {
      ({ document } = await roomsKeysAct(
        reader.vta.sender,
        { holder: reader.holder, service: { did: reader.vta.did } },
        unsignedRoomRequest(type, reader.community.did, payload as Record<string, unknown>, reader.member),
      ));
    } catch (e) {
      throw new OfferReadError("act", e);
    }
    let reply: R;
    try {
      reply = await reader.community.sender.sendCompleted<R>(document, {
        expectedResponseType: responseType,
        operationLabel: label,
      });
    } catch (e) {
      throw new OfferReadError("community", e);
    }
    if (!reply || !Array.isArray(reply.items)) {
      throw new OfferReadError("community", new Error(`${reader.community.did} answered ${label} without items`));
    }
    items.push(...reply.items);
    onPage?.(reply);
    if (typeof reply.nextCursor !== "string" || reply.nextCursor === "") return items;
    cursor = reply.nextCursor;
  }
  return items;
}

/**
 * Where one room stands, as every surface shows it
 * (`vtc/rooms/memberships/list/0.2`, *One record, every surface*).
 *
 * - `offered` — an offer to accept;
 * - `joined` — admitted, and openable: an open room, or a sealed one the VTA holds;
 * - `unfinished` — admitted to a sealed room the VTA does not hold, while the
 *   community keeps the Welcome: an acceptance begun somewhere, to finish;
 * - `needsReadmission` — the same after the community stopped keeping it: only an
 *   administrator re-admitting the member repairs it;
 * - `suspended` — admitted, but the room was closed to every member (archived with
 *   no access, or scheduled for removal): the host refuses the member's
 *   credentials until the community reopens the room and re-issues them, which
 *   the wallet collects as a renewal (`collectRoomRenewals`);
 * - `removed`.
 *
 * The room's own state — read-only, closed, going away — is `roomState` /
 * `roomAccess` / `purgeAt` on the record, and a surface shows it beside the
 * standing (`roomCondition`).
 */
export type RoomStanding = "offered" | "joined" | "unfinished" | "needsReadmission" | "suspended" | "removed";

/** The table: the community's `state` and tier, and whether the VTA holds the room's group for the member. */
export function roomStanding(room: Pick<RoomMembership, "state" | "visibility" | "repeatAcceptUntil">, held: boolean): RoomStanding {
  if (room.state === "offered") return "offered";
  if (room.state === "removed") return "removed";
  if (room.state === "suspended") return "suspended";
  if (room.visibility === "open" || held) return "joined";
  return room.repeatAcceptUntil !== undefined ? "unfinished" : "needsReadmission";
}

/** Whether accepting is what the member can do next. */
export function isAcceptable(standing: RoomStanding): boolean {
  return standing === "offered" || standing === "unfinished";
}

/** A room's state in its owner's lifecycle (`vtc/rooms/memberships/list/0.2` `roomState`). */
export type RoomOwnerState = "active" | "archived" | "removalScheduled" | "purging" | "removed";

const ROOM_OWNER_STATES: readonly string[] = ["active", "archived", "removalScheduled", "purging", "removed"];

/**
 * A community room's name, as its record carries it — and, from
 * `vtc/rooms/memberships/list/0.2`, the room's own state beside it.
 */
export interface CommunityRoomName {
  label: string;
  visibility?: string;
  roomState?: RoomOwnerState;
  roomAccess?: "readOnly" | "noAccess";
  purgeAt?: string;
}

/** The room-state members of a record, each only when it is one the schema allows. */
export function roomStateOf(o: Record<string, unknown>): Pick<CommunityRoomName, "roomState" | "roomAccess" | "purgeAt"> {
  return {
    ...(typeof o.roomState === "string" && ROOM_OWNER_STATES.includes(o.roomState)
      ? { roomState: o.roomState as RoomOwnerState }
      : {}),
    ...(o.roomAccess === "readOnly" || o.roomAccess === "noAccess" ? { roomAccess: o.roomAccess } : {}),
    ...(typeof o.purgeAt === "string" && !Number.isNaN(Date.parse(o.purgeAt)) ? { purgeAt: o.purgeAt } : {}),
  };
}

/**
 * The names in `offers` — a community's answer, already verified as signed by
 * it — room by room. A label must be a non-empty string; it is trimmed and cut
 * to 200 characters, and is shown, never interpreted.
 */
export function roomNamesFromOffers(offers: readonly unknown[]): Record<string, CommunityRoomName> {
  const out: Record<string, CommunityRoomName> = {};
  for (const raw of offers) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.roomId !== "string" || !o.roomId.startsWith("did:")) continue;
    if (typeof o.label !== "string") continue;
    const label = [...o.label.trim()].slice(0, 200).join("");
    if (label === "") continue;
    out[o.roomId] = {
      label,
      ...(typeof o.visibility === "string" ? { visibility: o.visibility } : {}),
      ...roomStateOf(o),
    };
  }
  return out;
}

/**
 * What a room's own state means to a member, beside their standing
 * (`vtc/rooms/memberships/list/0.2` `roomState` / `roomAccess` / `purgeAt`):
 * `active` says nothing; `readOnly` is an archived room they can still read;
 * `closed` one archived with no access, restored if it reopens; `goingAway` one
 * scheduled for removal (or being purged), with when; `removed` is gone.
 */
export type RoomCondition =
  | { kind: "active" }
  | { kind: "readOnly" }
  | { kind: "closed" }
  | { kind: "goingAway"; purgeAt?: string }
  | { kind: "removed" };

export function roomCondition(room: Pick<RoomMembership, "roomState" | "roomAccess" | "purgeAt">): RoomCondition {
  switch (room.roomState) {
    case "archived":
      return room.roomAccess === "readOnly" ? { kind: "readOnly" } : { kind: "closed" };
    case "removalScheduled":
    case "purging":
      return room.purgeAt !== undefined ? { kind: "goingAway", purgeAt: room.purgeAt } : { kind: "goingAway" };
    case "removed":
      return { kind: "removed" };
    default:
      return { kind: "active" };
  }
}

// ── Renewals ────────────────────────────────────────────────────────────────
//
// A community renews an admission it keeps — and, when a room it archived with
// no access reopens, re-issues every suspended member's credentials — by listing
// a **renewal** beside the member's offers (`vtc/rooms/offers/list/0.4`
// `renewals`): a fresh membership and authority for a room the member is
// already in. The member's surface stores each in the member's VTA **in place
// of** the one it renews, never beside it (Surface items 1–3). Until it does,
// the room's host goes on refusing the withdrawn ones. This is what `pnm rooms
// offers renew` does by hand, and what this wallet does by itself.

/** One of a renewal's credentials, as the member's VTA's vault is asked about it. */
export type RenewalKind = "membership" | "authority";

const RENEWAL_TYPE_TAG: Record<RenewalKind, string> = {
  membership: "MembershipCredential",
  authority: "AuthorityCredential",
};

/** The vault operations collecting a renewal needs, at the member's VTA. */
export interface RenewalVault {
  /** Handles of stored credentials of `type` issued by `issuerDid` to `subjectDid`. */
  query(filter: { type: string; issuerDid: string; subjectDid: string }): Promise<string[]>;
  /** The stored body under `id`, when it is a JSON credential. */
  get(id: string): Promise<Record<string, unknown> | undefined>;
  /** Verify and store `credential`, in place of `replaces` when given. */
  receive(credential: Record<string, unknown>, replaces?: string): Promise<void>;
}

/** What one collection pass did. */
export interface RenewalsCollected {
  /** Rooms whose renewal was stored now. */
  stored: string[];
  /** Rooms whose renewal the vault already held: nothing was sent. */
  alreadyHeld: string[];
  /** Rooms whose renewal could not be stored, and why. Tried again on the next pass. */
  failed: { roomId: string; error: string }[];
}

/**
 * The renewals `reader.community` lists for `reader.member` — the
 * `renewals` member of `vtc/rooms/offers/list/0.4`, across its pages.
 */
export async function communityRoomRenewals(reader: OfferReader): Promise<Renewal[]> {
  const renewals: Renewal[] = [];
  await readPages<VTCRoomsOffersListPayload, VTCRoomsOffersListResponsePayload, OfferV2>(
    reader,
    OFFERS_LIST,
    OFFERS_LIST_RESPONSE,
    "vtc/rooms/offers/list/0.4",
    (reply) => {
      if (Array.isArray(reply.renewals)) renewals.push(...reply.renewals);
    },
  );
  return renewals;
}

/** What identifies a credential body for "is this the one already held": its `id`, else its proof value. */
function credentialIdentity(c: Record<string, unknown>): string | undefined {
  if (typeof c.id === "string" && c.id !== "") return `id:${c.id}`;
  const proof = (Array.isArray(c.proof) ? c.proof[0] : c.proof) as Record<string, unknown> | undefined;
  if (proof && typeof proof.proofValue === "string") return `proof:${proof.proofValue}`;
  return undefined;
}

/**
 * Store every renewal `reader.community` lists for `reader.member` in the
 * member's VTA, each credential in place of the one it renews.
 *
 * Idempotent: a credential the vault already holds is not sent again, so a
 * pass that runs every time the wallet reads the member's rooms costs only the
 * vault reads once everything is collected. A renewal whose room issued the
 * member more than one credential of a kind is not stored — the key holder
 * could not choose which it replaces, and nor can this wallet — and is reported
 * in `failed`, as is any other refusal; the next pass tries again.
 */
export async function collectRoomRenewals(
  reader: OfferReader,
  vault: RenewalVault,
  renewals?: readonly Renewal[],
): Promise<RenewalsCollected> {
  const out: RenewalsCollected = { stored: [], alreadyHeld: [], failed: [] };
  const list = renewals ?? (await communityRoomRenewals(reader));
  for (const r of list) {
    if (typeof r.roomId !== "string" || !r.roomId.startsWith("did:")) continue;
    try {
      let stored = false;
      for (const kind of ["membership", "authority"] as const) {
        const raw = r.credentials?.[kind];
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new Error(`the renewal's ${kind} credential is not JSON`);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error(`the renewal's ${kind} credential is not a JSON object`);
        }
        const held = await vault.query({ type: RENEWAL_TYPE_TAG[kind], issuerDid: r.roomId, subjectDid: reader.member });
        if (held.length > 1) {
          throw new Error(
            `your agent holds ${held.length} ${RENEWAL_TYPE_TAG[kind]}s from this room for ${reader.member}; ` +
              "it cannot tell which the renewal replaces",
          );
        }
        const replaces = held[0];
        if (replaces !== undefined) {
          const current = await vault.get(replaces);
          const want = credentialIdentity(body);
          if (current && want !== undefined && credentialIdentity(current) === want) continue;
        }
        await vault.receive(body, replaces);
        stored = true;
      }
      (stored ? out.stored : out.alreadyHeld).push(r.roomId);
    } catch (e) {
      out.failed.push({ roomId: r.roomId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
