/// <reference types="chrome" />

// The room work behind a page's `window.vtaWallet.rooms.*` call — the offscreen
// document's half (P7b; VTI `data-rooms-files.md` §8.5).
//
// The background has already checked, before anything reaches here, that the
// page is the community's own portal and that the member shared the room with
// it (`room-page-policy.ts`). This module does the work and builds the **view**
// the page receives: never a task result as such, never a presentation, never a
// signed document. Record bodies are verified (signature, location, author)
// before a word of them goes into a view; a body that fails is refused, not
// shown with a warning.
//
// Every request a host receives is the member's, completed by their VTA as the
// persona (`@openvtc/pnm-core/rooms`'s `actAndSend`); the VTA's own reads
// (`rooms/keys/{browse,read}`) go out as the persona too.

import { CONTACT_METHODS, type TrustTaskSender } from "@openvtc/pnm-core";
import { resolveCommunityDocument, selectSignInServices, verifyDomainLinkage } from "@openvtc/pnm-core/vtc";
import {
  communityRoomMemberships,
  opaqueRecordKey,
  putCleartextAsMember,
  roomInfoAsMember,
  roomNamesFromOffers,
  type CommunityRoomName,
  roomsKeysBrowse,
  roomsKeysList,
  roomsKeysRead,
  roomProfileView,
  roomsKeysProfileRead,
  writeSealedAsMember,
  type PersonaRoom,
} from "@openvtc/pnm-core/rooms";
import { RoomHostChannel, verifyRecordBody } from "@openvtc/pnm-core/rooms/files";
import { base64url } from "@openvtc/vti-didcomm-js";

import { admittedOpenRooms, membersAt } from "./room-page-policy.js";
import type {
  OffscreenRoomsPageOp,
  PageListingView,
  PageRecordSummary,
  PageRecordView,
  PageRoomInfoView,
  RoomProfileSummary,
} from "./bridge-protocol.js";

export interface RoomPageDeps {
  /** The member's VTA session and the wallet's DID (the caller of the VTA tasks). */
  agent(vtaDid: string, restBaseUrl?: string): Promise<{ sender: TrustTaskSender; holderDid: string }>;
  /** The host's portal and endpoint. Defaults to its verified DID document. */
  portal?(hostDid: string): Promise<{ portalOrigin: string; endpoint: string }>;
  /** A channel for documents the VTA completed. Defaults to HTTPS at `endpoint`. */
  completed?(hostDid: string, endpoint: string): PersonaRoom["host"]["sender"];
  /** The member's `didSelfIssued` vault entries, read whole: the identities they sign in with. */
  identities?(
    vtaDid: string,
    restBaseUrl?: string,
  ): Promise<{ secretKind: string; principalDid?: string; targets: ReadonlyArray<{ kind: string; did?: string }> }[]>;
  now?(): number;
}

/**
 * The community's portal origin and Trust-Task endpoint, from its DID document,
 * resolved and verified afresh — as the trigger-link sign-in does. A
 * domain-linked contact must also be linked by its portal's DID Configuration.
 */
export async function resolvePortal(
  hostDid: string,
  now: () => number = Date.now,
): Promise<{ portalOrigin: string; endpoint: string }> {
  const resolved = await resolveCommunityDocument(hostDid, { contactMethods: CONTACT_METHODS });
  if (!resolved.ok) throw new Error(`${hostDid}'s DID document could not be verified (${resolved.reason})`);
  const selected = selectSignInServices(resolved.doc);
  if (!selected.ok) {
    throw new Error(`${hostDid}'s DID document names no usable ${selected.service} service`);
  }
  if (resolved.route === "domain-linked") {
    const linkage = await verifyDomainLinkage({
      did: hostDid,
      didDocument: resolved.doc,
      origin: selected.services.portalOrigin,
      now: now(),
    });
    if (!linkage.ok) throw new Error(`${selected.services.portalOrigin} is not linked to ${hostDid}`);
  }
  return { portalOrigin: selected.services.portalOrigin, endpoint: selected.services.trustTaskEndpoint };
}

/** Run one page operation. Throws with a message fit for the page. */
export async function runRoomsPageOp(
  deps: RoomPageDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  op: OffscreenRoomsPageOp,
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  if (op.op === "portal") return (deps.portal ?? ((d) => resolvePortal(d, now)))(op.hostDid);

  if (op.op === "members") {
    if (!deps.identities) throw new Error("the wallet cannot read which identities you use at this community");
    return membersAt(await deps.identities(vta.vtaDid, vta.restBaseUrl), op.hostDid);
  }

  const { sender, holderDid } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
  const parties = { holder: { did: holderDid }, service: { did: vta.vtaDid } };
  if (op.op === "held") {
    const rooms = await roomsKeysList(sender, parties);
    // One entry per (room, member), each saying whose it is.
    return rooms.map((r) => ({
      roomId: r.roomId,
      epoch: r.epoch,
      earliestReadableEpoch: r.earliestReadableEpoch,
      member: r.member,
      ...(r.context !== undefined ? { context: r.context } : {}),
      ...(r.actions !== undefined ? { actions: r.actions } : {}),
    }));
  }

  if (op.op === "roomNames") {
    // The community's own record, member by member: each read is signed as that
    // member, and one that fails (an identity with no rooms, a VTA without
    // act 0.8) costs only its own names. The record lists a room for as long as
    // the community keeps it — an accepted one too, long after its offer closed.
    const { endpoint } = await (deps.portal ?? ((d) => resolvePortal(d, now)))(op.hostDid);
    const community = {
      did: op.hostDid,
      sender: (deps.completed ?? ((hostDid, ep) => new RoomHostChannel({ hostDid, endpoint: ep })))(op.hostDid, endpoint),
    };
    const names: Record<string, CommunityRoomName> = {};
    for (const member of new Set(op.members)) {
      try {
        const rooms = await communityRoomMemberships({
          holder: { did: holderDid },
          vta: { did: vta.vtaDid, sender },
          community,
          member,
        });
        Object.assign(names, roomNamesFromOffers(rooms));
      } catch {
        // No names from this member: the page shows DIDs, as before.
      }
    }
    return names;
  }

  if (op.op === "openRooms") {
    // The community's record, member by member, as `roomNames` reads it: an open
    // room has no group, so only the record says the member is in it.
    const { endpoint } = await (deps.portal ?? ((d) => resolvePortal(d, now)))(op.hostDid);
    const community = {
      did: op.hostDid,
      sender: (deps.completed ?? ((hostDid, ep) => new RoomHostChannel({ hostDid, endpoint: ep })))(op.hostDid, endpoint),
    };
    const out: { roomId: string; member: string; actions: string[] }[] = [];
    for (const member of new Set(op.members)) {
      try {
        const rooms = await communityRoomMemberships({
          holder: { did: holderDid },
          vta: { did: vta.vtaDid, sender },
          community,
          member,
        });
        out.push(...admittedOpenRooms(rooms, member));
      } catch {
        // Nothing from this member this time: its open rooms are not offered.
      }
    }
    return out;
  }

  if (op.op === "roomProfiles") {
    // Each room's own profile, read by the member's VTA as that member. A VTA
    // that does not serve the task, or a room it cannot read, costs only that
    // room's profile: the page falls back to the community's name, or the DID.
    const out: Record<string, RoomProfileSummary> = {};
    for (const { roomId, member } of op.rooms) {
      if (out[roomId]) continue;
      try {
        const res = await roomsKeysProfileRead(sender, { ...parties, roomId, host: op.hostDid, member });
        out[roomId] = profileSummary(roomProfileView(res));
      } catch {
        // No profile for this room this time.
      }
    }
    return out;
  }

  // Every request for a page names the share's member: the VTA never picks one.
  const room = async (roomId: string, member: string): Promise<PersonaRoom> => {
    const { endpoint } = await (deps.portal ?? ((d) => resolvePortal(d, now)))(op.hostDid);
    return {
      roomId,
      member,
      holder: { did: holderDid },
      vta: { did: vta.vtaDid, sender },
      host: {
        did: op.hostDid,
        sender: (deps.completed ?? ((hostDid, ep) => new RoomHostChannel({ hostDid, endpoint: ep })))(
          op.hostDid,
          endpoint,
        ),
      },
    };
  };

  switch (op.op) {
    case "info": {
      const { principal, info } = await roomInfoAsMember(await room(op.roomId, op.member));
      return {
        roomId: info.roomId,
        visibility: info.visibility,
        epoch: info.epoch,
        member: principal,
        limits: info.limits,
        usage: info.usage,
      } satisfies PageRoomInfoView;
    }
    case "browse": {
      const listing = await roomsKeysBrowse(sender, {
        ...parties,
        roomId: op.roomId,
        host: op.hostDid,
        member: op.member,
        ...(op.prefix !== undefined ? { prefix: op.prefix } : {}),
        ...(op.sinceVersion !== undefined ? { sinceVersion: op.sinceVersion } : {}),
      });
      return {
        records: (listing.records ?? []).map((r) => summary(r as unknown as Record<string, unknown>)),
        complete: listing.complete === true,
        verification: listing.verification,
      } satisfies PageListingView;
    }
    case "read":
      return readView(
        op.roomId,
        op.key,
        await roomsKeysRead(sender, { ...parties, roomId: op.roomId, host: op.hostDid, key: op.key, member: op.member }),
      );
    case "putNote": {
      const r = await room(op.roomId, op.member);
      const { principal, info } = await roomInfoAsMember(r);
      const key = opaqueRecordKey();
      if (info.visibility === "open") {
        // An open room's records are cleartext the host stores and reads: no group
        // to seal under, and the member's request is what says the note is theirs.
        const version = await putCleartextAsMember(r, {
          key,
          title: op.title,
          ...(op.body !== undefined ? { body: op.body } : {}),
          ...(op.description !== undefined ? { description: op.description } : {}),
          ...(op.tags !== undefined ? { tags: op.tags } : {}),
        });
        return { key, version };
      }
      const version = await writeSealedAsMember(r, {
        roomId: op.roomId,
        key,
        author: principal,
        title: op.title,
        ...(op.body !== undefined ? { body: op.body } : {}),
        ...(op.description !== undefined ? { description: op.description } : {}),
        ...(op.tags !== undefined ? { tags: op.tags } : {}),
      });
      return { key, version };
    }
  }
}

/** A listing row, member by member: nothing the host sent beyond these. */
function summary(r: Record<string, unknown>): PageRecordSummary {
  const out: PageRecordSummary = {
    key: String(r.key),
    version: Number(r.version),
    updatedAt: String(r.updatedAt),
  };
  if (typeof r.status === "string") out.status = r.status;
  if (typeof r.epoch === "number") out.epoch = r.epoch;
  if (typeof r.author === "string") out.author = r.author;
  if (typeof r.title === "string") out.title = r.title;
  if (typeof r.description === "string") out.description = r.description;
  return out;
}

/**
 * One record as a page may see it. On a sealed room the body is verified —
 * signed by its author for `assertionMethod`, for this room, key and version,
 * and (on `attributed`) by the author the host recorded — before any of it is
 * put in the view. A body that fails is refused.
 */
export async function readView(
  roomId: string,
  key: string,
  read: {
    key: string;
    version: number;
    status?: string;
    updatedAt?: string;
    author?: string;
    plaintext?: string;
    cleartext?: Record<string, unknown>;
    verification: unknown;
  },
  resolveDid?: (did: string) => Promise<Record<string, unknown>>,
): Promise<PageRecordView> {
  if (read.key !== key) throw new Error(`the agent answered for record ${read.key}, not ${key}`);
  const base: PageRecordView = {
    key: read.key,
    version: read.version,
    status: read.status ?? "active",
    updatedAt: read.updatedAt ?? "",
    sealed: read.cleartext === undefined,
    verification: read.verification,
    ...(read.author !== undefined ? { author: read.author } : {}),
  };
  if (read.plaintext !== undefined) {
    const body = await verifyRecordBody(
      base64url.decode(read.plaintext),
      { roomId, key, version: read.version },
      read.author,
      resolveDid ? { resolveDid } : {},
    );
    return {
      ...base,
      author: body.author,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.tags !== undefined ? { tags: [...body.tags] } : {}),
      ...(body.file
        ? {
            file: {
              name: body.file.name,
              size: body.file.size,
              ...(body.file.mediaType !== undefined ? { mediaType: body.file.mediaType } : {}),
            },
          }
        : {}),
    };
  }
  if (read.cleartext !== undefined) {
    const c = read.cleartext;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const title = str(c.title);
    const description = str(c.description);
    const body = str(c.body);
    const tags = Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : undefined;
    return {
      ...base,
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(tags !== undefined ? { tags } : {}),
    };
  }
  // A retracted record: the tombstone is the answer.
  return base;
}

/** The part of a profile a view keeps: its text, and the two facts a member is told. */
export function profileSummary(view: ReturnType<typeof roomProfileView>): RoomProfileSummary {
  return {
    status: view.status,
    ...(view.name !== undefined ? { name: view.name } : {}),
    ...(view.description !== undefined ? { description: view.description } : {}),
    ...(view.emoji !== undefined ? { emoji: view.emoji } : {}),
    stale: view.stale,
    renameRefused: view.renameRefused,
  };
}
