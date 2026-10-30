// A community's offers of its own rooms — `vtc/rooms/offers/list/0.4` — and its
// record of where each admission stands — `vtc/rooms/memberships/list/0.1` — read
// as the member.
//
// A community that owns a room offers its members admission to it
// (`vtc/rooms/community/members/add`), and the offer carries the room's
// `label`, `visibility` and `description` as the community's administrators set them. The
// member reads their offers with a document signed as the DID the offers are
// addressed to — a persona their VTA holds — so the wallet builds the request
// unsigned and has the VTA complete it as that DID (`rooms/keys/act/0.9`, which
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
// in all of them (`vtc/rooms/memberships/list/0.1`, *One record, every surface*).
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
} from "../specs/vtc/rooms/offers/list/0.4/payload.js";

import {
  TYPE_URI as MEMBERSHIPS_LIST,
  RESPONSE_TYPE_URI as MEMBERSHIPS_LIST_RESPONSE,
  type VTCRoomsMembershipsListPayload,
  type VTCRoomsMembershipsListResponsePayload,
  type RoomMembership,
} from "../specs/vtc/rooms/memberships/list/0.1/payload.js";

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
 * state — `offered`, `admitted`, `removed` — for as long as it keeps the record
 * (`vtc/rooms/memberships/list/0.1`). No credentials: those come with an open
 * offer (`communityRoomOffers`).
 */
export async function communityRoomMemberships(reader: OfferReader): Promise<RoomMembership[]> {
  return readPages<VTCRoomsMembershipsListPayload, VTCRoomsMembershipsListResponsePayload, RoomMembership>(
    reader,
    MEMBERSHIPS_LIST,
    MEMBERSHIPS_LIST_RESPONSE,
    "vtc/rooms/memberships/list/0.1",
  );
}

/** A paged list the community answers as the member, through the VTA. */
async function readPages<P extends { cursor?: string }, R extends { items: T[]; nextCursor?: string }, T>(
  reader: OfferReader,
  type: string,
  responseType: string,
  label: string,
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
    if (typeof reply.nextCursor !== "string" || reply.nextCursor === "") return items;
    cursor = reply.nextCursor;
  }
  return items;
}

/**
 * Where one room stands, as every surface shows it
 * (`vtc/rooms/memberships/list/0.1`, *One record, every surface*).
 *
 * - `offered` — an offer to accept;
 * - `joined` — admitted, and openable: an open room, or a sealed one the VTA holds;
 * - `unfinished` — admitted to a sealed room the VTA does not hold, while the
 *   community keeps the Welcome: an acceptance begun somewhere, to finish;
 * - `needsReadmission` — the same after the community stopped keeping it: only an
 *   administrator re-admitting the member repairs it;
 * - `removed`.
 */
export type RoomStanding = "offered" | "joined" | "unfinished" | "needsReadmission" | "removed";

/** The table: the community's `state` and tier, and whether the VTA holds the room's group for the member. */
export function roomStanding(room: Pick<RoomMembership, "state" | "visibility" | "repeatAcceptUntil">, held: boolean): RoomStanding {
  if (room.state === "offered") return "offered";
  if (room.state === "removed") return "removed";
  if (room.visibility === "open" || held) return "joined";
  return room.repeatAcceptUntil !== undefined ? "unfinished" : "needsReadmission";
}

/** Whether accepting is what the member can do next. */
export function isAcceptable(standing: RoomStanding): boolean {
  return standing === "offered" || standing === "unfinished";
}

/** A community room's name, as its offer carries it. */
export interface CommunityRoomName {
  label: string;
  visibility?: string;
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
    };
  }
  return out;
}
