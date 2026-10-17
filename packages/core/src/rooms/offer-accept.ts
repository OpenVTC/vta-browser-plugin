// Accepting a community's offer of one of its rooms — `vtc/rooms/offers/accept/0.1`,
// as the member, step for step the CLI's `pnm rooms offers accept`
// (`vta-cli-common::commands::rooms::cmd_rooms_offers_accept`).
//
// 1. The offer is read as the member (`communityRoomOffers`, `offers.ts`).
// 2. Its membership and authority credentials go into the member's VTA vault
//    (`vault/credentials/receive`), where the presentation oracle finds them for
//    every later room request. Stored under their own ids, so a repeat replaces.
// 3. On a sealed tier (`attributed`, `private`) the VTA mints a KeyPackage
//    against the offer's invitation (`rooms/keys/key-package`). **Never the
//    wallet**: `rooms/keys/act/0.3` completes an acceptance only with a
//    KeyPackage the same VTA minted for that member and room (its recipient
//    item 10), because a leaf minted anywhere else would have keys somebody
//    else holds.
// 4. The acceptance is built unsigned, completed by the VTA as the member
//    (`rooms/keys/act/0.3`), and sent to the community unchanged.
// 5. The community answers with the Welcome, which goes to the member's own VTA
//    (`rooms/keys/welcome`) and nowhere else.
//
// ## A lost answer is retried with the same KeyPackage
//
// The community keeps the Welcome it got for an offer and answers a repeat that
// carries the **same** KeyPackage with the same Welcome (accept 0.1, "Repeating
// an accept"; its VTA answers its own repeat the same way, group/add 0.2 item
// 8). A repeat with a **different** KeyPackage is `alreadyAccepted`, and the
// member is then stuck until an administrator removes and re-admits them. So the
// KeyPackage is written to the journal **before** the acceptance is sent, and
// every later attempt — after a timeout, a closed tab, a torn-down document —
// sends that one. The journal is dropped only once the VTA has joined.

import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import { roomsKeysAct, unsignedRoomRequest } from "./act.js";
import { communityRoomOffers, OfferReadError, type CommunityRoomOffer, type OfferReader } from "./offers.js";

import {
  TYPE_URI as OFFERS_ACCEPT,
  RESPONSE_TYPE_URI as OFFERS_ACCEPT_RESPONSE,
  type VTCRoomsOffersAcceptPayload,
  type VTCRoomsOffersAcceptResponsePayload,
} from "@openvtc/trust-tasks/vtc/rooms/offers/accept/0.1/payload";
import {
  TYPE_URI as KEYS_KEY_PACKAGE,
  RESPONSE_TYPE_URI as KEYS_KEY_PACKAGE_RESPONSE,
  type RoomsKeysKeyPackagePayload,
  type RoomsKeysKeyPackageResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/key-package/0.1/payload";
import {
  TYPE_URI as KEYS_WELCOME,
  RESPONSE_TYPE_URI as KEYS_WELCOME_RESPONSE,
  type RoomsKeysWelcomePayload,
  type RoomsKeysWelcomeResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/welcome/0.1/payload";

// ── The journal ─────────────────────────────────────────────────────────────

/** Where an accept in progress is kept: as much of a key-value store as it needs. */
export interface OfferAcceptJournal {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Key prefix of an accept in progress. */
export const OFFER_ACCEPT_PREFIX = "pnm/room-offer-accept/v1/";

/** The journal key of one accept: one per (VTA, community, member, room). */
export function offerAcceptKey(vtaDid: string, communityDid: string, member: string, roomId: string): string {
  return `${OFFER_ACCEPT_PREFIX}${[vtaDid, communityDid, member, roomId].map(encodeURIComponent).join("|")}`;
}

/**
 * A sealed-tier accept that has begun. Nothing here is secret: the invitation
 * names the member and opens nothing, and a KeyPackage is public — its private
 * half never leaves the VTA. It is kept so a repeat sends the **same** one.
 */
export interface PendingOfferAccept {
  v: 1;
  vtaDid: string;
  communityDid: string;
  member: string;
  roomId: string;
  visibility: string;
  invitation: string;
  keyPackage?: string;
  /** When the VTA said it lets the KeyPackage's private half go. */
  keyPackageExpiresAt?: string;
  startedAt: string;
}

/** A stored record, or `undefined` for anything this wallet did not write. */
export function readPendingOfferAccept(raw: unknown): PendingOfferAccept | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => typeof r[k] === "string" && (r[k] as string) !== "";
  if (r.v !== 1 || !["vtaDid", "communityDid", "member", "roomId", "visibility", "invitation", "startedAt"].every(str)) {
    return undefined;
  }
  if (r.keyPackage !== undefined && !str("keyPackage")) return undefined;
  return r as unknown as PendingOfferAccept;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type RoomOfferErrorCode =
  /** The VTA does not serve `rooms/keys/act/0.3`. */
  | "actUnsupported"
  /**
   * The party makes no room offers: it does not serve `vtc/rooms/offers/list`
   * (a DID-hosting service, a community without rooms), or advertises no
   * `TrustTaskHTTPS` service to send one to. Nothing the member can act on —
   * a surface shows it quietly, never as a failure.
   */
  | "noRoomOffers"
  /** The community refused to answer the member (a refusal other than `notAMember`). */
  | "communityRefused"
  /** The VTA refused this wallet a capability the step needs. */
  | "capability"
  /** The VTA holds no key of the member this wallet may act as. */
  | "notPersona"
  /** The VTA no longer holds the KeyPackage's private half. */
  | "keyPackageNotHeld"
  | "notAMember"
  | "notFound"
  | "offerExpired"
  | "alreadyAccepted"
  /** The community could not yet tell whether its VTA admitted the member: retry. */
  | "admissionPending"
  | "keyHolderRefused"
  | "keyPackageInvalid"
  /** A sealed room admitted the member and sent no Welcome. */
  | "welcomeMissing"
  /** The VTA did not join from the Welcome. */
  | "joinFailed"
  /** The answer did not arrive: retrying sends the same acceptance. */
  | "noAnswer"
  | "other";

/** A failed step, in words a member can act on, with a stable code (R3.7). */
export class RoomOfferError extends Error {
  constructor(
    readonly code: RoomOfferErrorCode,
    message: string,
    /** Whether running the same accept again may succeed — with the same KeyPackage. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RoomOfferError";
  }
}

/** The Trust-Task error code a refusal carried, by its local part (`…:keyPackageNotHeld` → `keyPackageNotHeld`). */
export function taskErrorLocalCode(e: unknown): string | undefined {
  const details = (e as { details?: unknown } | null)?.details;
  const code = details && typeof details === "object" ? (details as { code?: unknown }).code : undefined;
  if (typeof code !== "string" || code === "") return undefined;
  return code.slice(code.lastIndexOf(":") + 1);
}

function clientCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The command that restores a capability the wallet's entry lost to a narrowing. */
export function capabilityFixCommand(walletDid: string): string {
  return `pnm acl update ${walletDid} --capabilities-all`;
}

/** What the VTA's refusal to sign as the member means, and what fixes it. */
function actRefusal(e: unknown, reader: OfferReader): RoomOfferError {
  const local = taskErrorLocalCode(e);
  if (local === "unsupportedType" || local === "unsupportedVersion") {
    return new RoomOfferError(
      "actUnsupported",
      "Your agent does not serve rooms/keys/act 0.3, the version that signs a reply to a community's offer as " +
        "you. It must be updated before offers can be read or accepted from the wallet.",
    );
  }
  if (local === "permissionDenied" || clientCode(e) === "e.p.msg.forbidden") {
    return new RoomOfferError(
      "capability",
      `Your agent refused to sign as ${reader.member}: this wallet's credential there (${reader.holder.did}) does ` +
        "not carry the room-present capability. Someone holding the whole agent can restore what its role " +
        `carries with \`${capabilityFixCommand(reader.holder.did)}\`. (${text(e)})`,
    );
  }
  if (local === "issuerNotPrincipal" || local === "principalAmbiguous") {
    return new RoomOfferError(
      "notPersona",
      `Your agent holds no authentication key of ${reader.member} that this wallet may act as, so it cannot answer ` +
        `the offer as that identity. (${text(e)})`,
    );
  }
  if (local === "keyPackageNotHeld") {
    return new RoomOfferError(
      "keyPackageNotHeld",
      "Your agent no longer holds the key package it minted for this room (it has been used, or it expired). " +
        `Accept again and it mints a fresh one. (${text(e)})`,
    );
  }
  return new RoomOfferError("other", text(e));
}

/** What the community's refusal of an acceptance means. */
function communityRefusal(e: unknown, reader: OfferReader, roomId: string, sealed: boolean): RoomOfferError {
  const local = taskErrorLocalCode(e);
  const who = reader.community.did;
  switch (local) {
    case "notAMember":
      return new RoomOfferError("notAMember", `${who} says ${reader.member} is not an active member of the community.`);
    case "notFound":
      return new RoomOfferError("notFound", `${who} has no open or recently accepted offer of ${roomId} to ${reader.member}.`);
    case "offerExpired":
      return new RoomOfferError("offerExpired", `The offer of ${roomId} has expired. Ask the community to offer it again.`);
    case "alreadyAccepted":
      return new RoomOfferError(
        "alreadyAccepted",
        `${who} says the offer was already accepted, with another key package or too long ago for it to answer ` +
          "again. Ask an administrator to remove you from the room and offer it again.",
      );
    case "admissionPending":
      return new RoomOfferError(
        "admissionPending",
        `${who} could not yet confirm the admission with its own agent. Accept again: the same key package is sent, ` +
          "and the community settles the admission before answering.",
        true,
      );
    case "keyHolderRefused": {
      const d = (e as { details?: { details?: { code?: unknown; message?: unknown } } }).details?.details;
      const inner = [d?.code, d?.message].filter((v): v is string => typeof v === "string").join(": ");
      return new RoomOfferError(
        "keyHolderRefused",
        `The community's own agent refused to admit you${inner ? ` (${inner})` : ""}. Tell the community.`,
      );
    }
    case "keyPackageInvalid":
    case "keyPackageRequired":
    case "keyPackageNotExpected":
      return new RoomOfferError("keyPackageInvalid", `${who} refused the key package: ${text(e)}`);
  }
  const client = clientCode(e);
  if (client === "e.client.timeout" || client === "e.client.network") {
    return new RoomOfferError(
      "noAnswer",
      `${who} did not answer (${text(e)}). Accept again${sealed ? ": the same key package is sent, so if it did admit you, it answers with the same Welcome" : ""}.`,
      true,
    );
  }
  return new RoomOfferError("other", `${who} did not take the acceptance: ${text(e)}`);
}

// ── The flow ────────────────────────────────────────────────────────────────

/** Where an accept has got to, for a surface to show. */
export type OfferAcceptStage = "reading" | "storing" | "keyPackage" | "accepting" | "joining";

export interface AcceptOfferDeps {
  journal: OfferAcceptJournal;
  /** Store one credential in the member's VTA vault (`vault/credentials/receive`). */
  receive(credential: Record<string, unknown>): Promise<void>;
  /** Whether the VTA already holds the room's group as `member` (`rooms/keys/list`). */
  joined(roomId: string, member: string): Promise<boolean>;
  now?(): number;
  progress?(stage: OfferAcceptStage): void;
}

export interface AcceptedRoomOffer {
  roomId: string;
  member: string;
  communityDid: string;
  visibility: string;
  /** True once the VTA holds the room's group (sealed); false for an open room, which has none. */
  joined: boolean;
  /** The room epoch the member was admitted at, where known. */
  epoch?: number;
  /** The community answered an acceptance this wallet had already sent, or the member was in already. */
  resumed: boolean;
}

/** Whether an offer is to a sealed tier, which has a group to join. */
export function isSealedOffer(visibility: string): boolean {
  return visibility !== "open";
}

/**
 * Accept the offer of `roomId` that `reader.community` made to `reader.member`.
 *
 * Idempotent: an accept that was interrupted is finished, with the KeyPackage
 * it began with; one that already finished answers as such.
 */
export async function acceptCommunityRoomOffer(
  reader: OfferReader,
  roomId: string,
  deps: AcceptOfferDeps,
): Promise<AcceptedRoomOffer> {
  const now = deps.now ?? Date.now;
  const key = offerAcceptKey(reader.vta.did, reader.community.did, reader.member, roomId);
  const pending = readPendingOfferAccept(await deps.journal.get(key));
  const vtaParties = { holder: reader.holder, service: { did: reader.vta.did } };
  const done = (visibility: string, joined: boolean, epoch: number | undefined, resumed: boolean): AcceptedRoomOffer => ({
    roomId,
    member: reader.member,
    communityDid: reader.community.did,
    visibility,
    joined,
    ...(epoch !== undefined ? { epoch } : {}),
    resumed,
  });

  deps.progress?.("reading");
  let offers: CommunityRoomOffer[];
  try {
    offers = await communityRoomOffers(reader);
  } catch (e) {
    throw e instanceof RoomOfferError ? e : listRefusal(e, reader);
  }
  const offer = offers.find((o) => o.roomId === roomId);

  if (!offer && !pending) {
    throw new RoomOfferError("notFound", `${reader.community.did} has no offer of ${roomId} to ${reader.member}.`);
  }
  if (offer && offer.host !== reader.community.did) {
    // The community offers its own rooms; an offer naming another host is not one this flow can carry out.
    throw new RoomOfferError("other", `the offer of ${roomId} names ${offer.host} as its host, not ${reader.community.did}`);
  }
  const visibility = offer?.visibility ?? pending!.visibility;
  const sealed = isSealedOffer(visibility);
  const invitation = offer?.credentials.invitation ?? pending!.invitation;

  // Accepted, and not by this wallet's journal: by another surface (pnm), or a
  // journal that was lost. Done if the VTA is in; otherwise only the community
  // can undo it, since a second KeyPackage is refused.
  if (offer?.state === "accepted" && !pending?.keyPackage) {
    if (!sealed) return done(visibility, false, undefined, true);
    if (await deps.joined(roomId, reader.member)) return done(visibility, true, undefined, true);
    throw new RoomOfferError(
      "alreadyAccepted",
      `This offer was accepted already, from somewhere other than this wallet, and your agent has not joined the ` +
        `room. Finish it where it was started (\`pnm rooms offers accept … --key-package <file>\`), or ask an ` +
        `administrator to remove you from the room and offer it again.`,
    );
  }

  if (offer) {
    deps.progress?.("storing");
    for (const [what, raw] of [
      ["membership", offer.credentials.membership],
      ["authority", offer.credentials.authority],
    ] as const) {
      let credential: Record<string, unknown>;
      try {
        credential = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        throw new RoomOfferError("other", `the offer's ${what} credential is not JSON: ${text(e)}`);
      }
      if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
        throw new RoomOfferError("other", `the offer's ${what} credential is not a credential`);
      }
      try {
        await deps.receive(credential);
      } catch (e) {
        if (taskErrorLocalCode(e) === "permissionDenied" || clientCode(e) === "e.p.msg.forbidden") {
          throw new RoomOfferError(
            "capability",
            `Your agent's credential vault refused the ${what} credential: this wallet's credential there ` +
              `(${reader.holder.did}) does not carry the vault-write capability. Someone holding the whole agent ` +
              `can restore what its role carries with \`${capabilityFixCommand(reader.holder.did)}\`. (${text(e)})`,
          );
        }
        throw new RoomOfferError("other", `Your agent's credential vault refused the ${what} credential: ${text(e)}`);
      }
    }
  }

  let keyPackage: string | undefined;
  if (sealed) {
    const held =
      pending?.keyPackage !== undefined &&
      (pending.keyPackageExpiresAt === undefined || Date.parse(pending.keyPackageExpiresAt) > now());
    if (held) {
      keyPackage = pending!.keyPackage;
    } else {
      if (pending?.keyPackage !== undefined && offer?.state !== "open") {
        throw new RoomOfferError(
          "alreadyAccepted",
          "The key package this accept began with has expired at your agent, and the community has the acceptance " +
            "already. Ask an administrator to remove you from the room and offer it again.",
        );
      }
      deps.progress?.("keyPackage");
      const minted = await mintKeyPackage(reader.vta.sender, vtaParties, roomId, invitation);
      keyPackage = minted.keyPackage;
      // Written before the acceptance leaves: every repeat sends this one.
      const record: PendingOfferAccept = {
        v: 1,
        vtaDid: reader.vta.did,
        communityDid: reader.community.did,
        member: reader.member,
        roomId,
        visibility,
        invitation,
        keyPackage,
        ...(minted.expiresAt !== undefined ? { keyPackageExpiresAt: minted.expiresAt } : {}),
        startedAt: pending?.startedAt ?? new Date(now()).toISOString(),
      };
      await deps.journal.put(key, record);
    }
  }

  deps.progress?.("accepting");
  const payload: VTCRoomsOffersAcceptPayload = { roomId, ...(keyPackage !== undefined ? { keyPackage } : {}) };
  let completed: Record<string, unknown>;
  try {
    ({ document: completed } = await roomsKeysAct(
      reader.vta.sender,
      vtaParties,
      unsignedRoomRequest(OFFERS_ACCEPT, reader.community.did, payload as unknown as Record<string, unknown>, reader.member),
      "0.3",
    ));
  } catch (e) {
    const err = actRefusal(e, reader);
    // The VTA has let this KeyPackage go: a repeat must mint, not resend.
    if (err.code === "keyPackageNotHeld" && pending) await deps.journal.delete(key);
    throw err;
  }
  let accepted: VTCRoomsOffersAcceptResponsePayload;
  try {
    accepted = await reader.community.sender.sendCompleted<VTCRoomsOffersAcceptResponsePayload>(completed, {
      expectedResponseType: OFFERS_ACCEPT_RESPONSE,
      operationLabel: "vtc/rooms/offers/accept/0.1",
    });
  } catch (e) {
    const err = communityRefusal(e, reader, roomId, sealed);
    if (err.code === "alreadyAccepted" && sealed && (await deps.joined(roomId, reader.member).catch(() => false))) {
      await deps.journal.delete(key);
      return done(visibility, true, undefined, true);
    }
    if (!err.retryable && err.code !== "other") await deps.journal.delete(key);
    throw err;
  }
  if (accepted.roomId !== roomId || accepted.state !== "admitted") {
    throw new RoomOfferError("other", `${reader.community.did} answered the acceptance of ${roomId} for ${accepted.roomId} (${accepted.state})`);
  }

  if (!sealed) {
    await deps.journal.delete(key);
    return done(visibility, false, accepted.epoch, pending !== undefined);
  }
  if (typeof accepted.welcome !== "string" || accepted.welcome === "") {
    throw new RoomOfferError(
      "welcomeMissing",
      `${reader.community.did} admitted you to sealed room ${roomId} but sent no Welcome. Accept again to ask for it.`,
      true,
    );
  }

  deps.progress?.("joining");
  try {
    await joinFromWelcome(reader.vta.sender, vtaParties, {
      roomId,
      invitation,
      welcome: accepted.welcome,
      ...(accepted.ratchetTree !== undefined ? { ratchetTree: accepted.ratchetTree } : {}),
    });
  } catch (e) {
    // Joined already — by an earlier attempt whose answer was lost.
    if (taskErrorLocalCode(e) !== "alreadyJoined") {
      throw new RoomOfferError(
        "joinFailed",
        `Admitted at room epoch ${accepted.epoch}, but your agent did not join from the Welcome: ${text(e)}. ` +
          "Accept again: the community answers with the same Welcome.",
        true,
      );
    }
  }
  await deps.journal.delete(key);
  return done(visibility, true, accepted.epoch, pending !== undefined);
}

/**
 * Reading the offers failed: the VTA's refusal, or the community's — each
 * mapped by the party that produced it. `unsupportedType` from the VTA is an
 * agent without act 0.3; from the community it is a party that makes no room
 * offers, which is not the member's agent's fault and not a failure at all.
 */
function listRefusal(e: unknown, reader: OfferReader): RoomOfferError {
  if (e instanceof OfferReadError) {
    return e.stage === "act" ? actRefusal(e.inner, reader) : communityListRefusal(e.inner, reader);
  }
  return new RoomOfferError("other", text(e));
}

/** What the community's refusal to list `reader.member`'s offers means. */
function communityListRefusal(e: unknown, reader: OfferReader): RoomOfferError {
  const local = taskErrorLocalCode(e);
  const who = reader.community.did;
  if (local === "unsupportedType" || local === "unsupportedVersion") {
    return new RoomOfferError("noRoomOffers", `${who} makes no room offers: it does not serve vtc/rooms/offers/list 0.1.`);
  }
  if (local === "notAMember") {
    return new RoomOfferError("notAMember", `${who} says ${reader.member} is not an active member of the community.`);
  }
  if (local === "permissionDenied" || clientCode(e) === "e.p.msg.forbidden") {
    return new RoomOfferError("communityRefused", `${who} refused to list its offers to ${reader.member}: ${text(e)}`);
  }
  const client = clientCode(e);
  if (client === "e.client.timeout" || client === "e.client.network") {
    return new RoomOfferError("noAnswer", `${who} did not answer the request for its offers (${text(e)}).`, true);
  }
  return new RoomOfferError("other", `${who} did not list its offers: ${text(e)}`);
}

/** Why reading `reader.member`'s offers failed, in words a member can act on. */
export function offerListRefusal(e: unknown, reader: OfferReader): RoomOfferError {
  return e instanceof RoomOfferError ? e : listRefusal(e, reader);
}

async function mintKeyPackage(
  sender: TrustTaskSender,
  parties: { holder: { did: string }; service: { did: string } },
  roomId: string,
  invitation: string,
): Promise<RoomsKeysKeyPackageResponsePayload> {
  const payload: RoomsKeysKeyPackagePayload = { roomId, invitation };
  try {
    const res = await sender.send<RoomsKeysKeyPackageResponsePayload>(
      buildTrustTask(KEYS_KEY_PACKAGE, payload, { issuer: parties.holder.did, recipient: parties.service.did }),
      { expectedResponseType: KEYS_KEY_PACKAGE_RESPONSE, operationLabel: "rooms/keys/key-package/0.1" },
    );
    if (typeof res?.keyPackage !== "string" || res.keyPackage === "") {
      throw new Error("the answer carries no key package");
    }
    return res;
  } catch (e) {
    throw new RoomOfferError("other", `Your agent did not mint a key package for ${roomId}: ${text(e)}`);
  }
}

async function joinFromWelcome(
  sender: TrustTaskSender,
  parties: { holder: { did: string }; service: { did: string } },
  payload: RoomsKeysWelcomePayload,
): Promise<RoomsKeysWelcomeResponsePayload> {
  return sender.send<RoomsKeysWelcomeResponsePayload>(
    buildTrustTask(KEYS_WELCOME, payload, { issuer: parties.holder.did, recipient: parties.service.did }),
    { expectedResponseType: KEYS_WELCOME_RESPONSE, operationLabel: "rooms/keys/welcome/0.1" },
  );
}
