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
// ## As whom: the member signed in there, never the community itself
//
// One VTA can hold two members of one room: an administrator whose VTA also
// holds the community's own place in a room the community owns, or a person
// with two personas in it. The VTA lists the room once per member and refuses
// to choose between them, so a share names the member too — the persona the
// wallet acts as for that page — and every request made for the page names it.
// Only identities the member uses at this community are offered (their
// `didSelfIssued` vault entries naming its DID, which is how the wallet signs
// in there), and never the community's own DID: a portal is the community's
// page, and acting there as the community would hand the page the community's
// standing in the room. Where more than one is left, the member picks.
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
  /** The member (persona DID) the wallet acts as in this room for this page. */
  member: string;
  grantedAt: number;
  expiresAt: number;
}

// ── The names of a community's rooms ───────────────────────────────────────
//
// A room the community owns has a label its administrators gave it, and the
// community's offer to a member carries it (`vtc/rooms/offers/list`). The
// community lists an accepted offer only while a repeated accept can be
// answered (seven days at the reference community), so the wallet remembers a
// name once it has seen it: a long-held room keeps its name. A fresh reading
// replaces what was remembered, so a rename shows once the room is offered
// again. Rooms a member owns have no name here.
//
// All of it sits behind `RoomPageGates.roomNames`, the one place a name is
// looked up — a sealed in-room profile, when there is one, goes there too.

/** `chrome.storage.local` key prefix for remembered room names. One record per (VTA, community). */
export const ROOM_NAMES_PREFIX = "room-names:";

/** A room's name, as remembered: when it was last read from the community. */
export interface RememberedRoomName {
  label: string;
  visibility?: string;
  seenAt: number;
}

/** The storage key holding one community's room names under one VTA. */
export function roomNamesKey(vtaDid: string, hostDid: string): string {
  return `${ROOM_NAMES_PREFIX}${vtaDid}|${hostDid}`;
}

/** How many room names one (VTA, community) record keeps. */
export const ROOM_NAMES_MAX = 500;

/**
 * What to remember after a reading: `fresh` over `remembered`, room by room,
 * the most recently seen kept when there are more than {@link ROOM_NAMES_MAX}.
 * A stored record that is not one this wallet wrote is ignored.
 */
export function mergeRoomNames(
  remembered: unknown,
  fresh: Readonly<Record<string, { label: string; visibility?: string }>>,
  now: number,
): Record<string, RememberedRoomName> {
  const out: Record<string, RememberedRoomName> = {};
  if (remembered && typeof remembered === "object" && !Array.isArray(remembered)) {
    for (const [roomId, v] of Object.entries(remembered as Record<string, unknown>)) {
      const r = v as Partial<RememberedRoomName> | null;
      if (!r || typeof r.label !== "string" || r.label === "" || typeof r.seenAt !== "number") continue;
      out[roomId] = {
        label: r.label,
        ...(typeof r.visibility === "string" ? { visibility: r.visibility } : {}),
        seenAt: r.seenAt,
      };
    }
  }
  for (const [roomId, n] of Object.entries(fresh)) {
    if (typeof n?.label !== "string" || n.label === "") continue;
    out[roomId] = { label: n.label, ...(n.visibility !== undefined ? { visibility: n.visibility } : {}), seenAt: now };
  }
  const entries = Object.entries(out);
  if (entries.length <= ROOM_NAMES_MAX) return out;
  return Object.fromEntries(entries.sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, ROOM_NAMES_MAX));
}

/**
 * Every remembered room name under `vtaDid`, room by room, from a whole
 * `chrome.storage.local` read — for the console, which shows a name wherever
 * one of the agent's communities has given it. The most recently seen wins
 * when two communities name one room.
 */
export function rememberedRoomLabels(all: Readonly<Record<string, unknown>>, vtaDid: string): Record<string, string> {
  const prefix = `${ROOM_NAMES_PREFIX}${vtaDid}|`;
  const best: Record<string, RememberedRoomName> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue;
    for (const [roomId, n] of Object.entries(mergeRoomNames(value, {}, 0))) {
      const had = best[roomId];
      if (!had || n.seenAt > had.seenAt) best[roomId] = n;
    }
  }
  return Object.fromEntries(Object.entries(best).map(([roomId, n]) => [roomId, n.label]));
}

/** The storage key holding one origin's grants under one VTA. */
export function grantsKey(origin: string, vtaDid: string): string {
  return `${ROOM_GRANTS_PREFIX}${vtaDid}|${origin}`;
}

/**
 * The grants still in force for this origin, community and VTA. A grant that
 * names no member (made before shares named one) is not in force: which member
 * it meant is not something to guess, so the member is asked again.
 */
export function liveGrants(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  now: number,
): RoomGrant[] {
  return grants.filter(
    (g) =>
      g.origin === at.origin &&
      g.hostDid === at.hostDid &&
      g.vtaDid === at.vtaDid &&
      g.expiresAt > now &&
      typeof g.member === "string" &&
      g.member.startsWith("did:"),
  );
}

/** The live grant of `roomId` to this page, or a refusal fit for the page. */
export function roomGrant(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  roomId: string,
  now: number,
): { ok: true; grant: RoomGrant } | { ok: false; error: string } {
  const grant = liveGrants(grants, at, now).find((g) => g.roomId === roomId);
  if (grant) return { ok: true, grant };
  // One answer whether the room was never shared, has lapsed, or does not
  // exist: the page learns nothing about rooms it was not given.
  return {
    ok: false,
    error:
      `${at.origin} has not been given that room. Ask the member to share it ` +
      `(window.vtaWallet.rooms.choose), which they do in their wallet's own window.`,
  };
}

/** Why `roomId` may not be used by this page, or `null` when it may. */
export function roomGrantRefusal(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  roomId: string,
  now: number,
): string | null {
  const r = roomGrant(grants, at, roomId, now);
  return r.ok ? null : r.error;
}

/** `grants` with each of `shares` granted afresh to `at`, for {@link ROOM_GRANT_TTL_MS}. One grant per room. */
export function withGrants(
  grants: readonly RoomGrant[],
  at: { origin: string; hostDid: string; vtaDid: string },
  shares: readonly { roomId: string; member: string }[],
  now: number,
): RoomGrant[] {
  const fresh = new Map(shares.map((s) => [s.roomId, s.member]));
  const kept = grants.filter(
    (g) =>
      g.expiresAt > now &&
      !(g.origin === at.origin && g.hostDid === at.hostDid && g.vtaDid === at.vtaDid && fresh.has(g.roomId)),
  );
  return [
    ...kept,
    ...[...fresh].map(([roomId, member]) => ({
      ...at,
      roomId,
      member,
      grantedAt: now,
      expiresAt: now + ROOM_GRANT_TTL_MS,
    })),
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
    (op.op === "choose" && op.suggest !== undefined ? did(op.suggest, "suggest") : null) ??
    (op.op === "choose" && op.member !== undefined ? did(op.member, "member") : null);
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

/** One row of the share prompt: a room, as one member. */
export interface RoomShareRow {
  /** `heldRoomKey`: the room and the member. What the prompt sends back. */
  key: string;
  roomId: string;
  /** The persona DID the wallet would act as. */
  member: string;
  /** The trust context the member's key lives in, when the VTA said. */
  context?: string;
  /** The member's place in the room: one that administers it, or a member. */
  role: "administers" | "member" | "unknown";
  /** The room's name, when the community owns it and the wallet knows it. */
  label?: string;
  shared: boolean;
  /** Pre-ticked: shared already, or the room the page linked to as the member signed in there. */
  ticked: boolean;
}

/** What the share prompt shows. Stored in session storage under the consent id. */
export interface RoomShareConsentView {
  kind: "share";
  origin: string;
  hostDid: string;
  /** Every room the member's VTA holds as an identity they use at this
   *  community — one row per (room, member). */
  rooms: RoomShareRow[];
  /** The identities the member uses at this community, as the wallet knows them. */
  members: string[];
  /** Rooms the VTA holds only as other identities (the community's own among
   *  them): not offered here, only counted, so the member knows why. */
  others: number;
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

/** What the room's grant to a member confers, in one word. */
export function roleOf(actions: readonly string[] | undefined): RoomShareRow["role"] {
  if (actions === undefined) return "unknown";
  return actions.includes("admin") ? "administers" : "member";
}

/** The key of a share row: the room and the member (`heldRoomKey`). */
export function shareRowKey(roomId: string, member: string): string {
  return `${roomId}|${member}`;
}

/**
 * The share prompt's rows.
 *
 * `held` is the VTA's listing, one entry per (room, member). `members` the
 * identities the member uses at `hostDid` (their vault entries naming it).
 * Offered: an entry held as one of those identities — never as `hostDid`
 * itself, and never one whose member the VTA did not say. Pre-ticked: what is
 * shared now, as the member it is shared as; and the room the page suggested,
 * as the member the page says is signed in, or as the only identity offered
 * for it. Never two rows of one room.
 */
export function shareRows(
  held: readonly { roomId: string; member?: string; context?: string; actions?: string[] }[],
  members: readonly string[],
  hostDid: string,
  live: readonly RoomGrant[],
  hint: { suggest?: string; member?: string },
  names: Readonly<Record<string, { label: string }>> = {},
): { rows: RoomShareRow[]; others: number } {
  const usable = new Set(members.filter((m) => m !== hostDid));
  const rows: RoomShareRow[] = [];
  const otherRooms = new Set<string>();
  const seen = new Set<string>();
  for (const h of held) {
    if (!h.member || !usable.has(h.member)) {
      otherRooms.add(h.roomId);
      continue;
    }
    const key = shareRowKey(h.roomId, h.member);
    if (seen.has(key)) continue;
    seen.add(key);
    const shared = live.some((g) => g.roomId === h.roomId && g.member === h.member);
    rows.push({
      key,
      roomId: h.roomId,
      member: h.member,
      ...(h.context !== undefined ? { context: h.context } : {}),
      role: roleOf(h.actions),
      ...(names[h.roomId] ? { label: names[h.roomId]!.label } : {}),
      shared,
      ticked: shared,
    });
  }
  if (hint.suggest !== undefined && !rows.some((r) => r.roomId === hint.suggest && r.ticked)) {
    const forRoom = rows.filter((r) => r.roomId === hint.suggest);
    const pick =
      forRoom.length === 1 ? forRoom[0] : forRoom.find((r) => hint.member !== undefined && r.member === hint.member);
    if (pick) pick.ticked = true;
  }
  const offered = new Set(rows.map((r) => r.roomId));
  return { rows, others: [...otherRooms].filter((r) => !offered.has(r)).length };
}

/**
 * The shares a share prompt's answer makes: the rows ticked, each one the
 * prompt offered — a key it did not offer is ignored — and at most one member
 * per room. Two members of one room ticked is refused: the page acts as one.
 */
export function selectedShares(
  rows: readonly RoomShareRow[],
  selected: readonly string[],
): { ok: true; shares: { roomId: string; member: string }[] } | { ok: false; error: string } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const shares = new Map<string, string>();
  for (const key of new Set(selected)) {
    const row = byKey.get(key);
    if (!row) continue;
    if (shares.has(row.roomId) && shares.get(row.roomId) !== row.member) {
      return { ok: false, error: `${row.roomId} was ticked as two members; a page uses a room as one` };
    }
    shares.set(row.roomId, row.member);
  }
  return { ok: true, shares: [...shares].map(([roomId, member]) => ({ roomId, member })) };
}

/** The ticked rows after `key` is toggled: one member per room, so ticking a
 *  room as one member unticks it as any other. */
export function toggleShareRow(rows: readonly RoomShareRow[], ticked: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(ticked);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  const row = rows.find((r) => r.key === key);
  if (!row) return next;
  for (const other of rows) if (other.roomId === row.roomId) next.delete(other.key);
  next.add(key);
  return next;
}

/** The share button's words: counted from the ticks, so it says what is ticked. */
export function shareButtonWords(ticked: number): string {
  return `Share ${ticked === 1 ? "1 room" : `${ticked} rooms`}`;
}

/**
 * The identities a member uses at `hostDid`: the principals of their
 * `didSelfIssued` vault entries naming it — how the wallet signs in there —
 * never `hostDid` itself.
 */
export function membersAt(
  entries: readonly { secretKind: string; principalDid?: string; targets: ReadonlyArray<{ kind: string; did?: string }> }[],
  hostDid: string,
): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (
      e.secretKind === "didSelfIssued" &&
      typeof e.principalDid === "string" &&
      e.principalDid.startsWith("did:") &&
      e.principalDid !== hostDid &&
      e.targets.some((t) => t.kind === "did" && t.did === hostDid)
    ) {
      out.add(e.principalDid);
    }
  }
  return [...out];
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
