/// <reference types="chrome" />

// A community's offers of its rooms — the offscreen document's half.
//
// The background has decided who may ask (an extension page, or the community's
// own portal for its own offers) and, for an accept, that the member confirmed
// it (`room-offers-background.ts`). This module does the work, as the CLI's
// `pnm rooms offers list|accept` do: each request to the community is built
// unsigned, completed by the member's VTA as the identity the offer is
// addressed to (`rooms/keys/act/0.4`, or 0.3 from a VTA without it, reading
// `vtc/rooms/offers/list/0.2` or — from a party without it — 0.1), and sent to
// the community's
// `TrustTaskHTTPS` endpoint — resolved from its DID document, never guessed —
// unchanged (`@openvtc/pnm-core/rooms`). What goes back is a view the wallet
// built: never an offer's credentials, a KeyPackage or a Welcome.
//
// An accept in progress is journaled here (IndexedDB, which this document has
// and `chrome.storage` it has not) before the acceptance leaves, so a torn-down
// document, a closed console or a lost answer resumes with the same KeyPackage.

import { credVaultReceive, type TrustTaskSender } from "@openvtc/pnm-core";
import {
  acceptCommunityRoomOffer,
  communityRoomOffers,
  offerAcceptKey,
  offerListRefusal,
  readPendingOfferAccept,
  roomsKeysList,
  RoomOfferError,
  type CompletedDocumentSender,
  type OfferAcceptJournal,
  type OfferReader,
} from "@openvtc/pnm-core/rooms";
import { isNoTrustTaskService, RoomHostChannel, roomHostEndpoint } from "@openvtc/pnm-core/rooms/files";

import type { OffscreenRoomOffersOp } from "./bridge-protocol.js";
import {
  isOfferSource,
  NO_ROOM_OFFERS,
  offerDescription,
  offerLabel,
  offerSources,
  type OfferView,
  type SignInVaultEntryLike,
} from "./room-offers-policy.js";

export interface RoomOffersOffscreenDeps {
  /** The member's VTA session and the wallet's DID (the caller of the VTA tasks). */
  agent(vtaDid: string, restBaseUrl?: string): Promise<{ sender: TrustTaskSender; holderDid: string }>;
  /** The member's `didSelfIssued` vault entries, read whole. */
  identities(vtaDid: string, restBaseUrl?: string): Promise<SignInVaultEntryLike[]>;
  journal: OfferAcceptJournal;
  /** The community's dispatcher URL. Defaults to its DID document's `TrustTaskHTTPS`. */
  endpoint?(communityDid: string): Promise<string>;
  /** A channel for documents the VTA completed. Defaults to HTTPS at `endpoint`. */
  completed?(communityDid: string, endpoint: string): CompletedDocumentSender;
  /** Store a credential in the member's VTA vault. Defaults to `vault/credentials/receive`. */
  receive?(sender: TrustTaskSender, holderDid: string, vtaDid: string, credential: Record<string, unknown>): Promise<void>;
  now?(): number;
}

/** A refusal the background can tell apart: the core's code rides along (R3.7). */
export class OfferOpError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OfferOpError";
  }
}

/** Run one offer operation. Throws with a message fit for the member. */
export async function runRoomOffersOp(
  deps: RoomOffersOffscreenDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  op: OffscreenRoomOffersOp,
): Promise<unknown> {
  const resolveEndpoint = deps.endpoint ?? ((did: string) => roomHostEndpoint(did));
  // A party that advertises nowhere to send a room request makes no room
  // offers: a quiet outcome, told apart by its code, never a failure.
  const endpointOf = async (did: string): Promise<string> => {
    try {
      return await resolveEndpoint(did);
    } catch (e) {
      if (isNoTrustTaskService(e)) throw new OfferOpError(e instanceof Error ? e.message : String(e), NO_ROOM_OFFERS);
      throw e;
    }
  };
  if (op.op === "sources") return offerSources(await deps.identities(vta.vtaDid, vta.restBaseUrl));
  if (op.op === "endpoint") return { endpoint: await endpointOf(op.communityDid) };

  // The pair is the wallet's own record of where the member signs in, read
  // again here beside the keys rather than taken from the caller.
  const sources = offerSources(await deps.identities(vta.vtaDid, vta.restBaseUrl));
  if (!isOfferSource(sources, op.communityDid, op.member)) {
    throw new OfferOpError(`${op.member} is not an identity you sign in to ${op.communityDid} with`, "notASource");
  }

  const { sender, holderDid } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
  const endpoint = await endpointOf(op.communityDid);
  const reader: OfferReader = {
    holder: { did: holderDid },
    vta: { did: vta.vtaDid, sender },
    community: {
      did: op.communityDid,
      sender: (deps.completed ?? ((did, ep) => new RoomHostChannel({ hostDid: did, endpoint: ep })))(op.communityDid, endpoint),
    },
    member: op.member,
  };

  if (op.op === "list") {
    let offers;
    try {
      offers = await communityRoomOffers(reader);
    } catch (e) {
      const err = offerListRefusal(e, reader);
      throw new OfferOpError(err.message, err.code);
    }
    const views: OfferView[] = [];
    for (const o of offers) {
      // The community's own rooms only: an offer naming another host is not one
      // this wallet can carry out, so it is not shown as one.
      if (o.host !== op.communityDid) continue;
      const pending = readPendingOfferAccept(
        await deps.journal.get(offerAcceptKey(vta.vtaDid, op.communityDid, op.member, o.roomId)),
      );
      views.push({
        communityDid: op.communityDid,
        member: op.member,
        roomId: o.roomId,
        label: offerLabel(o.label),
        description: offerDescription(o.description),
        visibility: o.visibility,
        actions: [...o.actions],
        validUntil: o.validUntil,
        offeredAt: o.offeredAt,
        state: o.state,
        inProgress: pending !== undefined,
      });
    }
    return views;
  }

  // op.op === "accept"
  const receive =
    deps.receive ??
    (async (s: TrustTaskSender, holder: string, service: string, credential: Record<string, unknown>) => {
      await credVaultReceive(s, { holder: { did: holder }, service: { did: service }, credential });
    });
  try {
    return await acceptCommunityRoomOffer(reader, op.roomId, {
      journal: deps.journal,
      receive: (credential) => receive(sender, holderDid, vta.vtaDid, credential),
      async joined(roomId, member) {
        const held = await roomsKeysList(sender, { holder: { did: holderDid }, service: { did: vta.vtaDid } });
        return held.some((r) => r.roomId === roomId && r.member === member);
      },
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (e) {
    if (e instanceof RoomOfferError) throw new OfferOpError(e.message, e.code);
    throw e;
  }
}
