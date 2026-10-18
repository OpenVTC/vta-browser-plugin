// A community's offers of its own rooms — `vtc/rooms/offers/list/0.2` (0.1
// where a party does not serve it yet), read as the member.
//
// A community that owns a room offers its members admission to it
// (`vtc/rooms/community/members/add`), and the offer carries the room's
// `label`, `visibility` and — from list 0.2 — its `description`, as the
// community's administrators set them. The member reads their offers with a
// document signed as the DID the offers are addressed to — a persona their VTA
// holds — so the wallet builds the request unsigned and has the VTA complete it
// as that DID (`rooms/keys/act`, which inserts no presentation for the offer
// types), then sends it to the community unchanged. That is the CLI's
// `pnm rooms offers list`, step for step.
//
// ## Two parties, two versions, two schedules
//
// List 0.2 is completed only by `rooms/keys/act/0.4`: 0.3's table is closed
// and refuses it `typeNotActable`. Members and communities upgrade on their own
// schedules, so the read asks act 0.4 + list 0.2 first and falls back to list
// 0.1 when either party does not serve the newer version:
//
// - the member's **VTA** answers act 0.4 `unsupportedType` /
//   `unsupportedVersion` → act 0.3 + list 0.1;
// - the **community** answers list 0.2 `unsupportedType` /
//   `unsupportedVersion` → act 0.4 + list 0.1 (the VTA has just shown it
//   serves 0.4).
//
// The versions that answered are kept for the rest of the read (every page) and
// handed to the accept, which signs its acceptance at the same act version. A
// failure after the fallback is tagged with the party that produced it, as
// before (`OfferReadError`): an agent without act 0.3, or a party that makes no
// room offers at all.
//
// The wallet reads offers for the **names** of the community's rooms and what
// each is for: what the room's DID alone does not tell a person. A label and a
// description are the community's metadata about a room it owns, never the
// room's content, and are shown as text, never interpreted. A room's `tags` are
// its administrators' filing and the community never sends them.

import type { TrustTaskSender, TaskParty } from "../vta/channel.js";

import { roomsKeysAct, unsignedRoomRequest, type CompletedDocumentSender } from "./act.js";

import {
  TYPE_URI as OFFERS_LIST_V1,
  RESPONSE_TYPE_URI as OFFERS_LIST_V1_RESPONSE,
  type VTCRoomsOffersListPayload as OffersListV1Payload,
  type VTCRoomsOffersListResponsePayload as OffersListV1Response,
} from "@openvtc/trust-tasks/vtc/rooms/offers/list/0.1/payload";
import {
  TYPE_URI as OFFERS_LIST_V2,
  RESPONSE_TYPE_URI as OFFERS_LIST_V2_RESPONSE,
  type VTCRoomsOffersListPayload as OffersListV2Payload,
  type VTCRoomsOffersListResponsePayload as OffersListV2Response,
  type OfferV2,
} from "@openvtc/trust-tasks/vtc/rooms/offers/list/0.2/payload";

/**
 * One offer: list 0.2's `OfferV2`, which is 0.1's `Offer` plus the room's
 * `description` when it has one. An offer read at 0.1 has none.
 */
export type { OfferV2 as CommunityRoomOffer };

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

/** The `rooms/keys/act` version that signs a reply to a community's offer. */
export type OfferActVersion = "0.4" | "0.3";

/** The `vtc/rooms/offers/list` version a community answered. */
export type OffersListVersion = "0.2" | "0.1";

/** A member's offers, and the versions that read them. */
export interface CommunityRoomOffers {
  offers: OfferV2[];
  /** The act version the member's VTA completed the listing at — the one to sign an acceptance at. */
  act: OfferActVersion;
  /** The listing version the community answered. At `0.1` no offer carries a description. */
  list: OffersListVersion;
}

/** Pages read at most: 100 offers a page is more rooms than any member is offered. */
const MAX_PAGES = 10;

/**
 * Whether `e` is a refusal saying the party does not serve the task at the
 * version asked (`unsupportedType` / `unsupportedVersion`, by its local part).
 */
export function isUnsupportedRefusal(e: unknown): boolean {
  const details = (e as { details?: unknown } | null)?.details;
  const code = details && typeof details === "object" ? (details as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return false;
  const local = code.slice(code.lastIndexOf(":") + 1);
  return local === "unsupportedType" || local === "unsupportedVersion";
}

/**
 * Every offer `reader.community` has made to `reader.member` and still lists:
 * open ones, and accepted ones while a repeated accept can be answered (the
 * reference community keeps those seven days).
 */
export async function communityRoomOffers(reader: OfferReader): Promise<OfferV2[]> {
  return (await readCommunityRoomOffers(reader)).offers;
}

/**
 * {@link communityRoomOffers}, with the versions that answered: act 0.4 + list
 * 0.2 where both parties serve them, else list 0.1 (through act 0.3 when the
 * VTA lacks 0.4).
 */
export async function readCommunityRoomOffers(reader: OfferReader): Promise<CommunityRoomOffers> {
  try {
    return { offers: await readAt(reader, "0.4", "0.2"), act: "0.4", list: "0.2" };
  } catch (e) {
    if (!(e instanceof OfferReadError) || !isUnsupportedRefusal(e.inner)) throw e;
    // The VTA without act 0.4 → act 0.3, which completes list 0.1; the
    // community without list 0.2 → list 0.1, still through act 0.4.
    const act: OfferActVersion = e.stage === "act" ? "0.3" : "0.4";
    return { offers: await readAt(reader, act, "0.1"), act, list: "0.1" };
  }
}

/** Every page of the listing at `list`, each completed by the VTA at `act`. */
async function readAt(reader: OfferReader, act: OfferActVersion, list: OffersListVersion): Promise<OfferV2[]> {
  const type = list === "0.2" ? OFFERS_LIST_V2 : OFFERS_LIST_V1;
  const responseType = list === "0.2" ? OFFERS_LIST_V2_RESPONSE : OFFERS_LIST_V1_RESPONSE;
  const items: OfferV2[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // The two versions' requests are the same: an optional cursor.
    const payload: OffersListV1Payload & OffersListV2Payload = cursor !== undefined ? { cursor } : {};
    let document: Record<string, unknown>;
    try {
      ({ document } = await roomsKeysAct(
        reader.vta.sender,
        { holder: reader.holder, service: { did: reader.vta.did } },
        unsignedRoomRequest(type, reader.community.did, payload as Record<string, unknown>, reader.member),
        act,
      ));
    } catch (e) {
      throw new OfferReadError("act", e);
    }
    let reply: OffersListV1Response | OffersListV2Response;
    try {
      reply = await reader.community.sender.sendCompleted<OffersListV1Response | OffersListV2Response>(document, {
        expectedResponseType: responseType,
        operationLabel: `vtc/rooms/offers/list/${list}`,
      });
    } catch (e) {
      throw new OfferReadError("community", e);
    }
    if (!reply || !Array.isArray(reply.items)) {
      throw new OfferReadError(
        "community",
        new Error(`${reader.community.did} answered vtc/rooms/offers/list without items`),
      );
    }
    // A 0.1 `Offer` is an `OfferV2` without `description`.
    items.push(...(reply.items as OfferV2[]));
    if (typeof reply.nextCursor !== "string" || reply.nextCursor === "") return items;
    cursor = reply.nextCursor;
  }
  return items;
}

/** A community room's name, as its offer carries it. */
export interface CommunityRoomName {
  label: string;
  visibility?: string;
}

/** The longest description a surface shows: `RoomDescription`'s own bound. */
export const ROOM_DESCRIPTION_MAX = 1000;

/**
 * A room description as the community sent it, made safe to show: a string,
 * trimmed and cut to {@link ROOM_DESCRIPTION_MAX} characters; `""` for
 * anything else. Shown as text, never interpreted as markup or instructions.
 */
export function roomDescriptionText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return [...raw.trim()].slice(0, ROOM_DESCRIPTION_MAX).join("");
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
