// Which page may use which room, and what a page may ask for (P7b).
//
// VTI `docs/05-design-notes/data-rooms-files.md` §8.5. Pure: no `chrome.*`, so
// every rule here is tested directly.
//
// ## Which pages: the community's own portal, by its DID document
//
// Every `window.vtaWallet.rooms.*` call names `hostDid`, the community the page
// speaks for. The wallet resolves that DID (verified, as the trigger-link
// sign-in does) and refuses unless the page's **browser-attested** origin is
// the origin of the document's first usable `SignInPortal` service, compared
// exactly. Host requests then go to the same document's `TrustTaskHTTPS`
// endpoint. Nothing the page supplies decides where a request goes.
//
// ## Which rooms: the ones the member shared, one by one
//
// A room's DID names no host, deliberately, and the member's VTA lists room
// identifiers only, so nothing says "this room is hosted by this community" —
// and handing a page the member's whole listing would tell it every room they
// are in. So the member picks, in the extension's own window, which rooms to
// share with this origin. A share is a **grant**: (origin, host, VTA, room),
// for 30 days, revocable. Reads ride it; every write is confirmed on its own.
//
// ## What a page may not have
//
// Never a key, a presentation, a signed document, the agent's or the host's
// reply as such, or a room it was not given. The methods' answers are views the
// wallet builds (`PageRoomView` and friends in `bridge-protocol.ts`).

import type { RoomsPageOp, RoomFilesPageOpen } from "./bridge-protocol.js";

/** How long a share lasts before the member is asked again. */
export const ROOM_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `chrome.storage.local` key prefix for grants. One record per (origin, VTA). */
export const ROOM_GRANTS_PREFIX = "room-grants:";

/** `chrome.storage.session` key prefix for a room prompt's view. */
export const ROOM_CONSENT_PREFIX = "room-consent:";

/** The largest file a page may upload: the wallet's own ceiling (`ROOM_FILE_MAX_BYTES`). */
export const PAGE_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface RoomGrant {
  /** The page origin it was granted to. */
  origin: string;
  /** The community whose portal that origin is. */
  hostDid: string;
  /** The member's VTA, which holds the room's keys. */
  vtaDid: string;
  roomId: string;
  grantedAt: number;
  expiresAt: number;
}

/** The storage key holding one origin's grants under one VTA. */
export function grantsKey(origin: string, vtaDid: string): string {
  return `${ROOM_GRANTS_PREFIX}${vtaDid}|${origin}`;
}

/** The grants still in force for this origin, community and VTA. */
export function liveGrants(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  now: number,
): RoomGrant[] {
  return grants.filter(
    (g) => g.origin === at.origin && g.hostDid === at.hostDid && g.vtaDid === at.vtaDid && g.expiresAt > now,
  );
}

/** Why `roomId` may not be used by this page, or `null` when it may. */
export function roomGrantRefusal(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  roomId: string,
  now: number,
): string | null {
  if (liveGrants(grants, at, now).some((g) => g.roomId === roomId)) return null;
  // One answer whether the room was never shared, has lapsed, or does not
  // exist: the page learns nothing about rooms it was not given.
  return (
    `${at.origin} has not been given that room. Ask the member to share it ` +
    `(window.vtaWallet.rooms.choose), which they do in their wallet's own window.`
  );
}

/** `grants` with `roomIds` granted afresh to `at`, each for {@link ROOM_GRANT_TTL_MS}. */
export function withGrants(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  roomIds: readonly string[],
  now: number,
): RoomGrant[] {
  const fresh = new Set(roomIds);
  const kept = grants.filter(
    (g) =>
      g.expiresAt > now &&
      !(g.origin === at.origin && g.hostDid === at.hostDid && g.vtaDid === at.vtaDid && fresh.has(g.roomId)),
  );
  return [
    ...kept,
    ...[...fresh].map((roomId) => ({ ...at, roomId, grantedAt: now, expiresAt: now + ROOM_GRANT_TTL_MS })),
  ];
}

/** `grants` without the one for `roomId` at `at`. */
export function withoutGrant(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  roomId: string,
): RoomGrant[] {
  return grants.filter(
    (g) => !(g.origin === at.origin && g.hostDid === at.hostDid && g.vtaDid === at.vtaDid && g.roomId === roomId),
  );
}

/**
 * Why the page at `origin` may not speak for `hostDid`, or `null` when it may.
 * `portalOrigin` is the origin of `hostDid`'s verified `SignInPortal`.
 */
export function portalRefusal(origin: string, hostDid: string, portalOrigin: string): string | null {
  if (origin === portalOrigin) return null;
  return (
    `${origin} is not ${hostDid}'s portal: its DID document names ${portalOrigin}. ` +
    `A page can use a community's rooms only from the portal the community's own DID document names.`
  );
}

// ── The page's parameters ───────────────────────────────────────────────────

const MAX_DID = 2048;
const MAX_KEY = 512;
const MAX_TITLE = 512;
const MAX_DESCRIPTION = 2048;
const MAX_BODY = 1_048_576;
const MAX_TAGS = 32;
const MAX_TAG = 64;
const MAX_NAME = 255;
const MAX_MEDIA_TYPE = 255;

const chars = (s: string) => [...s].length;

function did(v: unknown, what: string): string | null {
  return typeof v === "string" && v.startsWith("did:") && v.length <= MAX_DID ? null : `${what} must be a DID`;
}

function text(v: unknown, what: string, max: number, required = false): string | null {
  if (v === undefined) return required ? `${what} is required` : null;
  if (typeof v !== "string") return `${what} must be a string`;
  if (required && v.trim() === "") return `${what} is required`;
  return chars(v) > max ? `${what} is longer than ${max} characters` : null;
}

function tags(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > MAX_TAGS || v.some((t) => typeof t !== "string" || chars(t) > MAX_TAG)) {
    return `tags: at most ${MAX_TAGS} of ${MAX_TAG} characters each`;
  }
  return null;
}

const OPS = new Set(["list", "choose", "forget", "info", "browse", "read", "putNote"]);

/** Why a page's room call is malformed, or `null` when it is well formed. Checked before anything else. */
export function roomsPageParamsRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "rooms: expected an object";
  const p = raw as Record<string, unknown>;
  if (typeof p.op !== "string" || !OPS.has(p.op)) return `rooms: unknown operation ${String(p.op)}`;
  const op = p as RoomsPageOp & Record<string, unknown>;
  const first =
    did(op.hostDid, "hostDid") ??
    (op.op === "list" || op.op === "choose" ? null : did(op.roomId, "roomId")) ??
    (op.op === "choose" && op.suggest !== undefined ? did(op.suggest, "suggest") : null);
  if (first) return first;
  switch (op.op) {
    case "browse":
      return (
        text(op.prefix, "prefix", MAX_KEY) ??
        (op.sinceVersion !== undefined && !(Number.isSafeInteger(op.sinceVersion) && op.sinceVersion >= 0)
          ? "sinceVersion must be a whole number"
          : null)
      );
    case "read":
      return text(op.key, "key", MAX_KEY, true);
    case "putNote":
      return (
        text(op.title, "title", MAX_TITLE, true) ??
        text(op.body, "body", MAX_BODY) ??
        text(op.description, "description", MAX_DESCRIPTION) ??
        tags(op.tags)
      );
    default:
      return null;
  }
}

/** Why a page's file transfer is malformed, or `null` when it is well formed. */
export function roomFilesPageOpenRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "a transfer starts with get or put";
  const o = raw as RoomFilesPageOpen & Record<string, unknown>;
  if (o.kind !== "get" && o.kind !== "put") return "a transfer starts with get or put";
  const first = did(o.hostDid, "hostDid") ?? did(o.roomId, "roomId");
  if (first) return first;
  if (o.kind === "get") return text(o.key, "key", MAX_KEY, true);
  if (!Number.isSafeInteger(o.size) || o.size < 0) return "size must be the file's length in bytes";
  if (o.size > PAGE_FILE_MAX_BYTES) {
    return `a file of ${o.size} bytes is more than the ${PAGE_FILE_MAX_BYTES} the wallet seals in one piece`;
  }
  return (
    text(o.name, "name", MAX_NAME, true) ??
    text(o.mediaType, "mediaType", MAX_MEDIA_TYPE) ??
    text(o.title, "title", MAX_TITLE) ??
    text(o.description, "description", MAX_DESCRIPTION) ??
    tags(o.tags)
  );
}

// ── The prompts ─────────────────────────────────────────────────────────────

/** What the share prompt shows. Stored in session storage under the consent id. */
export interface RoomShareConsentView {
  kind: "share";
  origin: string;
  hostDid: string;
  /** Every room the member's VTA holds, with whether it is already shared here. */
  rooms: { roomId: string; shared: boolean; suggested: boolean }[];
  /** The host's Trust-Task endpoint origin when the wallet may not reach it yet:
   *  the prompt asks for it in the Share click. */
  needsOrigin?: string;
}

/** What the write prompt shows. */
export interface RoomWriteConsentView {
  kind: "write";
  origin: string;
  hostDid: string;
  roomId: string;
  /** The member who will sign: the persona the VTA acts as. */
  member: string;
  visibility: string;
  what:
    | { note: true; title: string; excerpt: string; bodyChars: number }
    | { file: true; name: string; size: number; mediaType?: string; title?: string };
}

/** The first `n` characters of a note's body, for the write prompt. */
export function excerpt(body: string | undefined, n = 280): string {
  if (!body) return "";
  const chars = [...body];
  return chars.length <= n ? body : `${chars.slice(0, n).join("")}…`;
}

/** Why a room may not be shared with a portal page, or `null` when it may. */
export function shareRefusal(visibility: string): string | null {
  if (visibility === "private") {
    // A private room hides from its host which member acts. The host's own
    // portal page knows who is signed in, so using the room from it would tell
    // the host exactly what the tier withholds.
    return (
      "it is a private room: its host is not to learn which member acts, and this page is the host's own " +
      "and knows who is signed in. Use it from your wallet's console instead."
    );
  }
  return null;
}
