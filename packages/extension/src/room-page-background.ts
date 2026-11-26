// A page's `window.vtaWallet.rooms.*` — the background's half (P7b).
//
// VTI `docs/05-design-notes/data-rooms-files.md` §8.5. Everything a page asks
// for passes three gates here, in this order, before the offscreen document
// does any work:
//
//   1. **The call is well formed** (`roomsPageParamsRefusal`).
//   2. **The page is the community's portal**: its browser-attested origin is
//      the origin of `hostDid`'s verified `SignInPortal` (`portalRefusal`).
//   3. **The member shared the room with this origin** (`roomGrantRefusal`),
//      except for `list`, `choose` and `forget`, which manage the shares.
//
// Writes take a fourth: the member confirms that one write, in the wallet's
// own window, seeing the room, who will sign and what will be written. Two
// bounded exceptions, each granted only by a box the member ticked in a confirm:
// a reaction under a live reaction grant (`reactionGrantLive`: "let this portal
// react in this room for 30 minutes"), and a message or reaction under a live
// session grant (`room-session-grant.ts`: "send messages and reactions in this
// room without asking while this room is open" — bound to the one page document
// holding the room open). Gates 1–3 and the record-members check still apply.
//
// What goes back is a view the offscreen document built; an error is a
// sentence, never the agent's or the host's `code` and `details`.
//
// Written against injected dependencies, not `chrome.*`, so the gates are
// tested as they run.

import type {
  OffscreenRoomsPageOp,
  OffscreenRoomsPageResponse,
  PageRecordView,
  PageRoomInfoView,
  PageRoomView,
  RoomFilesMessage,
  RoomFilesOpen,
  RoomFilesPageMessage,
  RoomFilesPageOpen,
  RoomProfileSummary,
  RoomsPageOp,
  RoomWatchPageEvent,
  RuntimeRoomsKeysChanged,
  RuntimeRoomsPageResponse,
} from "./bridge-protocol.js";
import { RoomWatcher, roomWatchId, type RoomWatchKey, type RoomWatchBatch } from "@openvtc/pnm-core/rooms";
import { PageRefusal, forwardedCode, pageFailure, type PageErrorCode } from "./page-error.js";
import {
  excerpt,
  glimpseOf,
  liveGrants,
  mergeRoomNames,
  storedRoomState,
  type RoomOwnerState,
  portalRefusal,
  roomFilesPageOpenRefusal,
  roomWatchPageOpenRefusal,
  roomGrant,
  roomsPageParamsRefusal,
  selectedShares,
  shareRefusal,
  shareRows,
  withGrants,
  withoutGrant,
  type RememberedRoomName,
  type RoomGrant,
  type RecordGlimpse,
  type RoomShareConsentView,
  type RoomWriteConsentView,
  REACTION_GRANT_TTL_MS,
  reactionGrantLive,
  withReactionGrant,
} from "./room-page-policy.js";
import { RoomSessionGrants, type PageSession, type SessionGrantRow, type SessionGrantScope } from "./room-session-grant.js";

/** One entry of the VTA's listing, as the offscreen document reports it — or an
 *  open room the member is in (`openRooms`), which has no epoch. */
interface HeldEntry {
  roomId: string;
  epoch?: number;
  earliestReadableEpoch?: number;
  member?: string;
  context?: string;
  actions?: string[];
}

/** The active VTA connection, as the background reads it. */
export interface ActiveVta {
  vtaDid: string;
  restBaseUrl?: string;
}

/** A port, as much of one as a transfer needs. */
export interface PortLike {
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (m: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface RoomPageBackgroundDeps {
  active(): Promise<{ ok: true; vta: ActiveVta } | { ok: false; error: string; code?: PageErrorCode }>;
  offscreen(vta: ActiveVta, op: OffscreenRoomsPageOp): Promise<OffscreenRoomsPageResponse>;
  /** Whether the wallet holds a host permission for `url`'s origin. */
  canReach(url: string): Promise<boolean>;
  loadGrants(origin: string, vtaDid: string): Promise<RoomGrant[]>;
  saveGrants(origin: string, vtaDid: string, grants: RoomGrant[]): Promise<void>;
  /** Raise a room prompt and wait. A closed window is a denial. `reactionGrant`: the
   *  member ticked a reaction prompt's grant box; `sessionGrant`: a prompt's "while
   *  this room is open" box (each only ever from a prompt offering it). */
  prompt(
    view: RoomShareConsentView | RoomWriteConsentView,
  ): Promise<{ approved: boolean; selectedRooms?: string[]; reactionGrant?: boolean; sessionGrant?: boolean }>;
  /** Told the live session grants whenever they may have changed (the action badge). */
  sessionsChanged?(rows: SessionGrantRow[]): void;
  /** Open a transfer with the offscreen document (`ROOM_FILES_PORT`). */
  openTransfer(): Promise<PortLike>;
  /** The community's offers of its rooms (`room-offers-background.ts`). Absent: the portal sees none. */
  offers?: PortalOffers;
  now(): number;
  /** The room names remembered for one community under one VTA (`roomNamesKey`). Absent: none kept. */
  loadRoomNames?(vtaDid: string, hostDid: string): Promise<unknown>;
  saveRoomNames?(vtaDid: string, hostDid: string, names: Record<string, RememberedRoomName>): Promise<void>;
  /** Timers for the watches pages hold, injectable for tests. Default `setTimeout`. */
  setTimer?(fn: () => void, ms: number): unknown;
}

/** A room's name, as a page or the share prompt is shown it. */
type RoomNames = Record<
  string,
  {
    label: string;
    visibility?: string;
    /** The room's own state, from the community's record (`vtc/rooms/memberships/list/0.2`). */
    roomState?: RoomOwnerState;
    roomAccess?: "readOnly" | "noAccess";
    purgeAt?: string;
    labelSource?: "profile" | "community";
    description?: string;
    profileStale?: boolean;
    renameRefused?: boolean;
  }
>;

/** How long a community's resolved portal is trusted before it is resolved again. */
const PORTAL_CACHE_MS = 5 * 60 * 1000;

/** How long one member's offers stand for the names of a community's rooms before they are read again. */
export const ROOM_NAMES_CACHE_MS = 60 * 1000;

/** What a portal may ask of the wallet about its community's offers. */
export interface PortalOffers {
  forPortal(vta: ActiveVta, hostDid: string, members: readonly string[]): Promise<{ offers: unknown[]; needsOrigin?: string }>;
  accept(req: {
    communityDid: string;
    roomId: string;
    member?: string;
    origin: string;
    vta: ActiveVta;
    members: readonly string[];
  }): Promise<unknown>;
}

/** A refusal of this channel, always with its page code (`page-error.ts`). */
class RoomPageRefusal extends PageRefusal {}

/** A transfer's failure frame for the page: the message and its code. */
function failedOf(e: unknown): { error: string; code: PageErrorCode } {
  const { error, code } = pageFailure(e);
  return { error, code };
}

export class RoomPageGates {
  private readonly portals = new Map<string, { portalOrigin: string; endpoint: string; at: number }>();
  /** When each (VTA, community, member)'s offers were last read for room names. */
  private readonly namesReadAt = new Map<string, number>();
  /**
   * Each room's own profile, as the member's VTA last read it, by
   * (VTA, community, room, member). Held in memory for {@link ROOM_NAMES_CACHE_MS},
   * never stored: a profile is the room's content, read for the view that shows it.
   */
  private readonly profiles = new Map<string, { at: number; summary: RoomProfileSummary | null }>();

  /**
   * The rooms pages are watching, armed through the member's VTA. One watcher
   * for the background: two tabs on one room share its watch, and the last to
   * close cancels it.
   */
  private watcher: RoomWatcher | undefined;
  /** The VTA each watched room is armed through, by `vtaDid`. */
  private readonly watchVtas = new Map<string, ActiveVta>();
  /** Each page port's signal handler, by watch id. */
  private readonly watchers = new Map<string, Set<(latestVersion: number) => void>>();

  /** The live "while this room is open" grants, in memory only. */
  readonly sessions: RoomSessionGrants;

  constructor(private readonly deps: RoomPageBackgroundDeps) {
    this.sessions = new RoomSessionGrants(
      () => this.deps.now(),
      () => this.sessionsChanged(),
    );
  }

  /** Tell the background, and wake when the next grant runs out, so the badge clears on time. */
  private sessionsChanged(): void {
    const rows = this.sessions.list();
    this.deps.sessionsChanged?.(rows);
    if (rows.length === 0) return;
    const next = Math.min(...rows.map((r) => r.endsBy)) - this.deps.now();
    const timer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    // Listing prunes what ran out, and a pruned grant calls back here.
    timer(() => void this.sessions.list(), Math.max(1000, next + 1));
  }

  /** End the session grants whose share has gone (revoked, forgotten, lapsed). */
  async reviewSessionGrants(): Promise<void> {
    const rows = this.sessions.list();
    const live = new Set<string>();
    for (const r of rows) {
      try {
        const grants = await this.deps.loadGrants(r.origin, r.vtaDid);
        const g = roomGrant(grants, { origin: r.origin, hostDid: r.hostDid, vtaDid: r.vtaDid }, r.roomId, this.deps.now());
        if (g.ok && g.grant.member === r.member) live.add(r.id);
      } catch {
        // Unreadable: treated as gone.
      }
    }
    this.sessions.endUnshared((scope) => rows.some((r) => live.has(r.id) && sameScopeRow(r, scope)));
  }

  /** `hostDid`'s portal and endpoint, resolved through the offscreen document and cached briefly. */
  private async portal(vta: ActiveVta, hostDid: string): Promise<{ portalOrigin: string; endpoint: string }> {
    const now = this.deps.now();
    const hit = this.portals.get(hostDid);
    if (hit && now - hit.at < PORTAL_CACHE_MS) return hit;
    const res = await this.deps.offscreen(vta, { op: "portal", hostDid });
    if (!res.ok) throw new RoomPageRefusal(res.error, forwardedCode(res.code));
    const got = res.result as { portalOrigin: string; endpoint: string };
    this.portals.set(hostDid, { ...got, at: now });
    return got;
  }

  /** Gates 2 (and the reachability of the host). Returns the active VTA and the host endpoint. */
  private async atPortal(
    origin: string,
    hostDid: string,
    opts: { needReach: boolean },
  ): Promise<{ vta: ActiveVta; endpoint: string }> {
    const active = await this.deps.active();
    if (!active.ok) throw new RoomPageRefusal(active.error, active.code ?? "notConnected");
    const { portalOrigin, endpoint } = await this.portal(active.vta, hostDid);
    const refusal = portalRefusal(origin, hostDid, portalOrigin);
    if (refusal) throw new RoomPageRefusal(refusal, "originNotPermitted");
    if (opts.needReach && !(await this.deps.canReach(endpoint))) {
      throw new RoomPageRefusal(
        `The wallet may not reach ${new URL(endpoint).origin} yet. Share a room again (rooms.choose) and ` +
          `allow it there, or allow it from the wallet's popup.`,
        "hostPermissionRequired",
      );
    }
    return { vta: active.vta, endpoint };
  }

  /** Gate 3. Returns the member the share acts as: every request for the page names it. */
  private async granted(origin: string, hostDid: string, vta: ActiveVta, roomId: string): Promise<string> {
    return (await this.share(origin, hostDid, vta, roomId)).member;
  }

  /** Gate 3, answering the share itself. */
  private async share(origin: string, hostDid: string, vta: ActiveVta, roomId: string): Promise<RoomGrant> {
    const grants = await this.deps.loadGrants(origin, vta.vtaDid);
    const r = roomGrant(grants, { origin, hostDid, vtaDid: vta.vtaDid }, roomId, this.deps.now());
    if (!r.ok) throw new RoomPageRefusal(r.error, "notShared");
    return r.grant;
  }

  /** The member's explicit reaction grant, recorded on the share it rides on. */
  private async grantReactions(origin: string, hostDid: string, vta: ActiveVta, roomId: string, member: string): Promise<void> {
    const grants = await this.deps.loadGrants(origin, vta.vtaDid);
    await this.deps.saveGrants(
      origin,
      vta.vtaDid,
      withReactionGrant(grants, { origin, hostDid, vtaDid: vta.vtaDid }, roomId, member, this.deps.now()),
    );
  }

  /** The room's name for a prompt, where the wallet knows one. Never throws. */
  private async roomLabel(vta: ActiveVta, hostDid: string, roomId: string, member: string): Promise<string | undefined> {
    try {
      return (await this.displayNames(vta, hostDid, [member], [{ roomId, member }]))[roomId]?.label;
    } catch {
      return undefined;
    }
  }

  /**
   * Refuse, before the member is asked anything, a write the room's profile
   * does not take: a writer MUST NOT use a record member the room's current
   * profile does not list (`SealedRecordBody`).
   */
  private async needsRecordMembers(
    vta: ActiveVta,
    at: { hostDid: string; roomId: string; member: string },
    needed: readonly string[],
    what: string,
  ): Promise<void> {
    const listed = (await this.offscreen(vta, { op: "recordMembers", ...at })) as string[];
    const missing = needed.filter((m) => !listed.includes(m));
    if (missing.length > 0) {
      throw new RoomPageRefusal(
        `This room does not take ${what}: its profile does not list ${missing.join(" and ")} in its record members.`,
        "recordMembersNotListed",
      );
    }
  }

  /** The record at `key`, read by the wallet as the member, as a prompt names it. */
  private async glimpse(
    vta: ActiveVta,
    at: { hostDid: string; roomId: string; member: string },
    key: string,
  ): Promise<RecordGlimpse> {
    const read = (await this.offscreen(vta, { op: "read", ...at, key })) as PageRecordView;
    return glimpseOf(read);
  }

  private async offscreen(vta: ActiveVta, op: OffscreenRoomsPageOp): Promise<unknown> {
    const res = await this.deps.offscreen(vta, op);
    if (!res.ok) throw new RoomPageRefusal(res.error, forwardedCode(res.code));
    return res.result;
  }

  /**
   * One `rooms.*` call from a page at `origin` (browser-attested). `session`: the
   * document it came from, as the browser reports it — only a call that names one
   * can be covered by, or offer, a session grant.
   */
  async handle(origin: string, raw: unknown, session?: PageSession): Promise<RuntimeRoomsPageResponse> {
    try {
      const malformed = roomsPageParamsRefusal(raw);
      if (malformed) return { ok: false, error: malformed, code: "invalidCall" };
      return { ok: true, result: await this.run(origin, raw as RoomsPageOp, session) };
    } catch (e) {
      return pageFailure(e);
    }
  }

  /** Whether a session grant may be offered on this prompt: the room is open in this document. */
  private sessionOffer(session: PageSession | undefined, origin: string, hostDid: string, roomId: string): boolean {
    return session !== undefined && this.sessions.isOpen(session, origin, hostDid, roomId);
  }

  private async run(origin: string, p: RoomsPageOp, session?: PageSession): Promise<unknown> {
    switch (p.op) {
      case "list": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: false });
        return { rooms: await this.views(origin, p.hostDid, vta) };
      }
      case "choose":
        return this.choose(origin, p.hostDid, { suggest: p.suggest, member: p.member });
      case "forget": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: false });
        const grants = await this.deps.loadGrants(origin, vta.vtaDid);
        const at = { origin, hostDid: p.hostDid, vtaDid: vta.vtaDid };
        const next = withoutGrant(grants, at, p.roomId);
        await this.deps.saveGrants(origin, vta.vtaDid, next);
        return { forgotten: next.length !== grants.length };
      }
      case "info":
      case "browse":
      case "read":
      case "conversation": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: true });
        const member = await this.granted(origin, p.hostDid, vta, p.roomId);
        // Rebuilt member by member: nothing the page added rides along.
        const at = { hostDid: p.hostDid, roomId: p.roomId, member };
        return this.offscreen(
          vta,
          p.op === "info"
            ? { op: "info", ...at }
            : p.op === "read"
              ? { op: "read", ...at, key: p.key }
              : p.op === "conversation"
                ? { op: "conversation", ...at }
                : {
                  op: "browse",
                  ...at,
                  ...(p.prefix !== undefined ? { prefix: p.prefix } : {}),
                  ...(p.sinceVersion !== undefined ? { sinceVersion: p.sinceVersion } : {}),
                },
        );
      }
      case "offers":
      case "acceptOffer": {
        // The community's own offers, to the identities the member uses here by
        // the wallet's record — never the community's DID, never the page's word.
        if (!this.deps.offers) throw new RoomPageRefusal("this wallet does not handle room offers", "invalidCall");
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: false });
        const members = ((await this.offscreen(vta, { op: "members", hostDid: p.hostDid })) as string[]).filter(
          (m) => m !== p.hostDid,
        );
        if (p.op === "offers") return this.deps.offers.forPortal(vta, p.hostDid, members);
        if (p.member !== undefined && !members.includes(p.member)) {
          throw new RoomPageRefusal(`${p.member} is not an identity you use at this community`, "identityUnknown");
        }
        // The member decides in the wallet's own window; the page only asked.
        return this.deps.offers.accept({
          communityDid: p.hostDid,
          roomId: p.roomId,
          ...(p.member !== undefined ? { member: p.member } : {}),
          origin,
          vta,
          members,
        });
      }
      case "putNote": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: true });
        const member = await this.granted(origin, p.hostDid, vta, p.roomId);
        const info = (await this.offscreen(vta, {
          op: "info",
          hostDid: p.hostDid,
          roomId: p.roomId,
          member,
        })) as PageRoomInfoView;
        const decision = await this.deps.prompt({
          kind: "write",
          origin,
          hostDid: p.hostDid,
          roomId: p.roomId,
          member: info.member,
          visibility: info.visibility,
          what: { note: true, title: p.title, excerpt: excerpt(p.body), bodyChars: [...(p.body ?? "")].length },
        });
        if (!decision.approved) throw new RoomPageRefusal("the member declined to add this note", "declined");
        return this.offscreen(vta, {
          op: "putNote",
          hostDid: p.hostDid,
          roomId: p.roomId,
          member,
          title: p.title,
          ...(p.body !== undefined ? { body: p.body } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.tags !== undefined ? { tags: p.tags } : {}),
        });
      }
      case "putMessage": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: true });
        const member = await this.granted(origin, p.hostDid, vta, p.roomId);
        const at = { hostDid: p.hostDid, roomId: p.roomId, member };
        // A reply is refused before the member is asked where the room takes none:
        // never sent without what makes it one.
        if (p.replyTo !== undefined) await this.needsRecordMembers(vta, at, ["inReplyTo"], "replies");
        const scope: SessionGrantScope = { origin, hostDid: p.hostDid, vtaDid: vta.vtaDid, roomId: p.roomId, member };
        const chars = [...p.body].length;
        // Under a live session grant — this document, holding this room open, for
        // this share — no window. Too fast, or too long, and the window is asked.
        const cover = this.sessions.cover(scope, session, { messageChars: chars });
        if (cover !== "covered") {
          const info = (await this.offscreen(vta, { op: "info", ...at })) as PageRoomInfoView;
          const replyingTo = p.replyTo !== undefined ? await this.glimpse(vta, at, p.replyTo.key) : undefined;
          const offerSession = cover === "none" && this.sessionOffer(session, origin, p.hostDid, p.roomId);
          const roomLabel = offerSession ? await this.roomLabel(vta, p.hostDid, p.roomId, member) : undefined;
          const decision = await this.deps.prompt({
            kind: "write",
            origin,
            hostDid: p.hostDid,
            roomId: p.roomId,
            member: info.member,
            visibility: info.visibility,
            what: {
              message: true,
              excerpt: excerpt(p.body),
              bodyChars: chars,
              ...(replyingTo !== undefined ? { replyingTo } : {}),
              ...(offerSession ? { session: { ...(roomLabel ? { roomLabel } : {}) } } : {}),
            },
          });
          if (!decision.approved) throw new RoomPageRefusal("the member declined to send this message", "declined");
          if (offerSession && decision.sessionGrant === true) this.sessions.grant(scope, session!, roomLabel);
        }
        const sent = await this.offscreen(vta, {
          op: "putMessage",
          ...at,
          body: p.body,
          ...(p.replyTo !== undefined
            ? { replyTo: { key: p.replyTo.key, ...(p.replyTo.version !== undefined ? { version: p.replyTo.version } : {}) } }
            : {}),
        });
        this.sessions.used(scope, session);
        return sent;
      }
      case "react":
      case "unreact": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: true });
        const share = await this.share(origin, p.hostDid, vta, p.roomId);
        const member = share.member;
        const at = { hostDid: p.hostDid, roomId: p.roomId, member };
        await this.needsRecordMembers(vta, at, ["kind", "inReplyTo"], "reactions");
        const withdraw = p.op === "unreact";
        const scope: SessionGrantScope = { origin, hostDid: p.hostDid, vtaDid: vta.vtaDid, roomId: p.roomId, member };
        const cover = this.sessions.cover(scope, session);
        // Under a live session grant (this document, holding this room open), or a
        // live reaction grant — this origin, this community, this VTA, this room,
        // as this member: the share it rides on — no window. Nothing else is
        // waived, and nothing extends either grant.
        if (cover !== "covered" && !reactionGrantLive(share, this.deps.now())) {
          const offerSession = cover === "none" && this.sessionOffer(session, origin, p.hostDid, p.roomId);
          const info = (await this.offscreen(vta, { op: "info", ...at })) as PageRoomInfoView;
          const on = await this.glimpse(vta, at, p.key);
          const roomLabel = await this.roomLabel(vta, p.hostDid, p.roomId, member);
          const decision = await this.deps.prompt({
            kind: "write",
            origin,
            hostDid: p.hostDid,
            roomId: p.roomId,
            member: info.member,
            visibility: info.visibility,
            what: {
              reaction: true,
              value: p.value,
              on,
              ...(withdraw ? { withdraw: true as const } : {}),
              grant: { minutes: REACTION_GRANT_TTL_MS / 60_000, ...(roomLabel ? { roomLabel } : {}) },
              ...(offerSession ? { session: { ...(roomLabel ? { roomLabel } : {}) } } : {}),
            },
          });
          if (!decision.approved) {
            throw new RoomPageRefusal(
              withdraw ? "the member declined to take back this reaction" : "the member declined to react",
              "declined",
            );
          }
          if (decision.reactionGrant === true) await this.grantReactions(origin, p.hostDid, vta, p.roomId, member);
          if (offerSession && decision.sessionGrant === true) this.sessions.grant(scope, session!, roomLabel);
        }
        const done = withdraw
          ? await this.offscreen(vta, { op: "unreact", ...at, target: p.key, value: p.value })
          : await this.offscreen(vta, {
              op: "react",
              ...at,
              target: { key: p.key, ...(p.version !== undefined ? { version: p.version } : {}) },
              value: p.value,
            });
        this.sessions.used(scope, session);
        return done;
      }
    }
  }

  /**
   * The names of `hostDid`'s own rooms, as far as the wallet knows them — the
   * one place a room's name is looked up.
   *
   * Read from the community's offers to each of `members` (signed as that
   * member, at the community whose portal this is), at most once a minute per
   * member, and remembered: the community stops listing an accepted offer after
   * a few days, and the room keeps its name. Never throws — a failure leaves
   * whatever was remembered, and the page shows a room's DID where there is no
   * name.
   */
  private async roomNames(vta: ActiveVta, hostDid: string, members: readonly string[]): Promise<RoomNames> {
    const now = this.deps.now();
    let remembered: unknown;
    try {
      remembered = this.deps.loadRoomNames ? await this.deps.loadRoomNames(vta.vtaDid, hostDid) : undefined;
    } catch {
      remembered = undefined;
    }
    const at = (m: string) => `${vta.vtaDid}|${hostDid}|${m}`;
    const stale = [...new Set(members)].filter((m) => {
      const read = this.namesReadAt.get(at(m));
      return read === undefined || now - read >= ROOM_NAMES_CACHE_MS;
    });
    let names = mergeRoomNames(remembered, {}, now);
    if (stale.length > 0) {
      for (const m of stale) this.namesReadAt.set(at(m), now);
      try {
        const res = await this.deps.offscreen(vta, { op: "roomNames", hostDid, members: stale });
        if (res.ok && res.result && typeof res.result === "object" && !Array.isArray(res.result)) {
          names = mergeRoomNames(remembered, res.result as RoomNames, now);
          await this.deps.saveRoomNames?.(vta.vtaDid, hostDid, names);
        }
      } catch {
        // Nothing learned this time; what was remembered stands.
      }
    }
    return Object.fromEntries(
      Object.entries(names).map(([roomId, n]) => [
        roomId,
        { label: n.label, ...(n.visibility !== undefined ? { visibility: n.visibility } : {}), ...storedRoomState(n as unknown as Record<string, unknown>) },
      ]),
    );
  }

  /**
   * Each of `rooms`' own profile, read by the member's VTA as the member it is
   * held as — at most once a minute per room and member, never polled. Never
   * throws: a room whose profile could not be read has none.
   */
  private async roomProfiles(
    vta: ActiveVta,
    hostDid: string,
    rooms: readonly { roomId: string; member: string }[],
  ): Promise<Record<string, RoomProfileSummary>> {
    const now = this.deps.now();
    const at = (r: { roomId: string; member: string }) => `${vta.vtaDid}|${hostDid}|${r.roomId}|${r.member}`;
    const stale = rooms.filter((r) => {
      const hit = this.profiles.get(at(r));
      return hit === undefined || now - hit.at >= ROOM_NAMES_CACHE_MS;
    });
    if (stale.length > 0) {
      let read: Record<string, RoomProfileSummary> = {};
      try {
        const res = await this.deps.offscreen(vta, { op: "roomProfiles", hostDid, rooms: stale });
        if (res.ok && res.result && typeof res.result === "object" && !Array.isArray(res.result)) {
          read = res.result as Record<string, RoomProfileSummary>;
        }
      } catch {
        // Nothing learned this time.
      }
      for (const r of stale) this.profiles.set(at(r), { at: now, summary: read[r.roomId] ?? null });
    }
    const out: Record<string, RoomProfileSummary> = {};
    for (const r of rooms) {
      const s = this.profiles.get(at(r))?.summary;
      if (s && out[r.roomId] === undefined) out[r.roomId] = s;
    }
    return out;
  }

  /**
   * The names to show for `rooms`: the room's own profile name where it has one,
   * else the community's offer label (`roomNames`), else none (the DID).
   */
  private async displayNames(
    vta: ActiveVta,
    hostDid: string,
    members: readonly string[],
    rooms: readonly { roomId: string; member: string }[],
  ): Promise<RoomNames> {
    const offered = await this.roomNames(vta, hostDid, members);
    const profiles = await this.roomProfiles(vta, hostDid, rooms);
    return withProfiles(offered, profiles);
  }

  /**
   * The open rooms of `hostDid` that `members` are in (`openRooms`), read now —
   * never kept, so a removal stops counting at once. Never throws: a reading that
   * failed offers no open room.
   */
  private async openRooms(vta: ActiveVta, hostDid: string, members: readonly string[]): Promise<HeldEntry[]> {
    if (members.length === 0) return [];
    try {
      const res = await this.deps.offscreen(vta, { op: "openRooms", hostDid, members: [...members] });
      return res.ok && Array.isArray(res.result) ? (res.result as HeldEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** The live shares for this origin and community, joined with what the VTA still holds. */
  private async views(origin: string, hostDid: string, vta: ActiveVta): Promise<PageRoomView[]> {
    const grants = liveGrants(
      await this.deps.loadGrants(origin, vta.vtaDid),
      { origin, hostDid, vtaDid: vta.vtaDid },
      this.deps.now(),
    );
    if (grants.length === 0) return [];
    const listed = (await this.offscreen(vta, { op: "held" })) as HeldEntry[];
    // An open room is never listed: only the community's record says the member
    // is in it, asked only about shares the listing does not name.
    const unlisted = grants.filter((g) => !listed.some((h) => h.roomId === g.roomId && h.member === g.member));
    const held = [...listed, ...(await this.openRooms(vta, hostDid, [...new Set(unlisted.map((g) => g.member))]))];
    const names = await this.displayNames(
      vta,
      hostDid,
      grants.map((g) => g.member),
      grants.filter((g) => held.some((h) => h.roomId === g.roomId && h.member === g.member)),
    );
    return grants.map((g) => {
      // Held as the member it is shared as: the same room held as somebody
      // else is not this share's.
      const h = held.find((r) => r.roomId === g.roomId && r.member === g.member);
      return {
        roomId: g.roomId,
        member: g.member,
        held: h !== undefined,
        ...(h?.epoch !== undefined ? { epoch: h.epoch } : {}),
        ...(h?.earliestReadableEpoch !== undefined ? { earliestReadableEpoch: h.earliestReadableEpoch } : {}),
        sharedAt: new Date(g.grantedAt).toISOString(),
        expiresAt: new Date(g.expiresAt).toISOString(),
        ...(names[g.roomId] ? names[g.roomId] : {}),
      };
    });
  }

  private async choose(
    origin: string,
    hostDid: string,
    hint: { suggest?: string | undefined; member?: string | undefined },
  ): Promise<{ rooms: PageRoomView[]; refused: { roomId: string; reason: string }[] }> {
    const { vta, endpoint } = await this.atPortal(origin, hostDid, { needReach: false });
    const at = { origin, hostDid, vtaDid: vta.vtaDid };
    const now = this.deps.now();
    const grants = await this.deps.loadGrants(origin, vta.vtaDid);
    const listed = (await this.offscreen(vta, { op: "held" })) as HeldEntry[];
    // Who the member is at this community, by the wallet's own record — the
    // page's word only picks among these, never adds to them.
    const members = (await this.offscreen(vta, { op: "members", hostDid })) as string[];
    const usable = members.filter((m) => m !== hostDid);
    // Beside the listing, the open rooms the member is in, which it never names.
    const held = [...listed, ...(await this.openRooms(vta, hostDid, usable))];
    const names = await this.displayNames(
      vta,
      hostDid,
      usable,
      held.flatMap((h) => (h.member !== undefined && usable.includes(h.member) ? [{ roomId: h.roomId, member: h.member }] : [])),
    );
    const { rows, others } = shareRows(
      held,
      members,
      hostDid,
      liveGrants(grants, at, now),
      {
        ...(hint.suggest !== undefined ? { suggest: hint.suggest } : {}),
        ...(hint.member !== undefined ? { member: hint.member } : {}),
      },
      names,
    );
    const reach = await this.deps.canReach(endpoint);
    const decision = await this.deps.prompt({
      kind: "share",
      origin,
      hostDid,
      rooms: rows,
      members,
      others,
      ...(reach ? {} : { needsOrigin: new URL(endpoint).origin }),
    });
    if (!decision.approved) return { rooms: await this.views(origin, hostDid, vta), refused: [] };

    // Only rows the window offered: a selection naming anything else is ignored.
    const picked = selectedShares(rows, decision.selectedRooms ?? []);
    if (!picked.ok) throw new RoomPageRefusal(picked.error, "invalidCall");
    const refused: { roomId: string; reason: string }[] = [];
    const ok: { roomId: string; member: string }[] = [];
    for (const share of picked.shares) {
      // Confirm with the host, as that member, that it holds the room — and
      // read its tier. Only for rooms the member just chose to share here.
      const res = await this.deps.offscreen(vta, { op: "info", hostDid, ...share });
      if (!res.ok) {
        refused.push({
          roomId: share.roomId,
          reason: `the community could not confirm it holds this room for ${share.member}: ${res.error}`,
        });
        continue;
      }
      const why = shareRefusal((res.result as PageRoomInfoView).visibility);
      if (why) {
        refused.push({ roomId: share.roomId, reason: `not shared: ${why}` });
        continue;
      }
      ok.push(share);
    }
    // The selection is the whole of what is shared here now: an unticked room is unshared.
    let next = grants.filter((g) => !(g.origin === origin && g.hostDid === hostDid && g.vtaDid === vta.vtaDid));
    next = withGrants(next, at, ok, now);
    await this.deps.saveGrants(origin, vta.vtaDid, next);
    return { rooms: await this.views(origin, hostDid, vta), refused };
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  // ── Change signals ──────────────────────────────────────────────────────────

  private roomWatcher(): RoomWatcher {
    this.watcher ??= new RoomWatcher({
      send: async (batch: RoomWatchBatch) => {
        const vta = this.watchVtas.get(batch.vtaDid);
        if (!vta) throw new Error("no agent for this watch");
        return (await this.offscreen(vta, {
          op: "watch",
          hostDid: batch.host,
          member: batch.member,
          rooms: batch.rooms,
          ...(batch.leaseSeconds !== undefined ? { leaseSeconds: batch.leaseSeconds } : {}),
          ...(batch.cancel ? { cancel: true as const } : {}),
        })) as Awaited<ReturnType<ConstructorParameters<typeof RoomWatcher>[0]["send"]>>;
      },
      ...(this.deps.setTimer ? { setTimer: this.deps.setTimer } : {}),
      now: () => this.deps.now(),
    });
    return this.watcher;
  }

  /**
   * A room's signal, as the offscreen document received it from the member's
   * VTA (`RUNTIME_ROOMS_KEYS_CHANGED`; the caller checks it came from the
   * offscreen document). Handed to the pages watching that room only when a
   * page armed it; anything else is dropped. Answers whether one took it.
   */
  deliverRoomSignal(vtaDid: string, signal: RuntimeRoomsKeysChanged["signal"]): boolean {
    const key = this.watcher?.accept(vtaDid, signal);
    if (!key) return false;
    for (const fn of this.watchers.get(roomWatchId(key)) ?? []) fn(signal.latestVersion);
    return true;
  }

  /**
   * Serve one page's watch on `page`, a port from a content script at `origin`
   * (browser-attested). The first message names the room; the page must be the
   * community's portal and the room shared with it, as for every room call.
   * Then: the watch is armed through the member's VTA after each read the page
   * reports, the room's signal is passed on — that it moved, and to which
   * version, nothing else — and the watch is cancelled when the port closes.
   * The share is checked again before every signal is passed on.
   */
  serveWatchPort(page: PortLike, origin: string, session?: PageSession): void {
    let open = true;
    let held: { key: RoomWatchKey; release: () => void } | undefined;
    // While this port holds the room, the room is open in this document: a
    // session grant lives exactly that long.
    let roomClosed: (() => void) | undefined;
    const post = (m: RoomWatchPageEvent) => {
      if (!open) return;
      try {
        page.postMessage(m);
      } catch {
        close();
      }
    };
    const close = () => {
      if (!open) return;
      open = false;
      held?.release();
      held = undefined;
      roomClosed?.();
      roomClosed = undefined;
    };
    const fail = (e: unknown) => {
      post({ kind: "failed", ...failedOf(e) });
      close();
      try {
        page.disconnect();
      } catch {
        // Already gone.
      }
    };
    page.onDisconnect.addListener(close);

    let started = false;
    page.onMessage.addListener((raw: unknown) => {
      if (!open) return;
      if (!started) {
        started = true;
        void this.startWatch(origin, raw, post, fail).then((h) => {
          if (!h) return;
          if (!open) {
            h.release();
            return;
          }
          held = h;
          if (session) roomClosed = this.sessions.roomOpened(session, origin, h.key.host, h.key.roomId);
        });
        return;
      }
      const m = raw as { kind?: unknown; version?: unknown };
      if (m?.kind === "ping") return;
      if (m?.kind === "read" && (m.version === undefined || (Number.isSafeInteger(m.version) && (m.version as number) >= 0))) {
        if (held) this.roomWatcher().afterRead(held.key, m.version as number | undefined);
        return;
      }
      fail(new RoomPageRefusal("a watch takes read and ping after it starts", "invalidCall"));
    });
  }

  private async startWatch(
    origin: string,
    raw: unknown,
    post: (m: RoomWatchPageEvent) => void,
    fail: (e: unknown) => void,
  ): Promise<{ key: RoomWatchKey; release: () => void } | undefined> {
    const malformed = roomWatchPageOpenRefusal(raw);
    if (malformed) {
      fail(new RoomPageRefusal(malformed, "invalidCall"));
      return undefined;
    }
    const o = raw as { hostDid: string; roomId: string; sinceVersion?: number };
    let vta: ActiveVta;
    let member: string;
    try {
      // The VTA arms the watch at the host, not the wallet: no host permission is needed.
      ({ vta } = await this.atPortal(origin, o.hostDid, { needReach: false }));
      member = await this.granted(origin, o.hostDid, vta, o.roomId);
    } catch (e) {
      fail(e);
      return undefined;
    }
    const watcher = this.roomWatcher();
    const key: RoomWatchKey = { vtaDid: vta.vtaDid, member, host: o.hostDid, roomId: o.roomId };
    const id = roomWatchId(key);
    this.watchVtas.set(vta.vtaDid, vta);
    const onSignal = (latestVersion: number) => {
      // The share may have been forgotten or run out since the watch began.
      void this.granted(origin, o.hostDid, vta, o.roomId).then(
        () => post({ kind: "changed", latestVersion }),
        (e: unknown) => fail(e),
      );
    };
    const set = this.watchers.get(id) ?? new Set();
    set.add(onSignal);
    this.watchers.set(id, set);
    const unsubscribe = watcher.subscribe((changed, state) => {
      if (changed === id && state) post({ kind: "state", state: state.state });
    });
    watcher.hold(key);
    watcher.afterRead(key, o.sinceVersion);
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        unsubscribe();
        set.delete(onSignal);
        if (set.size === 0) this.watchers.delete(id);
        watcher.release(key);
      },
    };
  }

  /**
   * Serve one page file transfer on `page`, a port from a content script at
   * `origin` (browser-attested). The offscreen document does the work; this
   * relays, gates, and holds a download's bytes until the whole file verified.
   */
  servePort(page: PortLike, origin: string): void {
    let open = true;
    let inner: PortLike | undefined;
    const post = (m: RoomFilesPageMessage) => {
      if (!open) return;
      try {
        page.postMessage(m);
      } catch {
        open = false;
        inner?.disconnect();
      }
    };
    const finish = (m: RoomFilesPageMessage) => {
      post(m);
      if (open) {
        open = false;
        page.disconnect();
      }
      inner?.disconnect();
    };
    page.onDisconnect.addListener(() => {
      open = false;
      inner?.disconnect();
    });

    let started = false;
    let upload: { size: number; sent: number; ready: boolean } | undefined;
    page.onMessage.addListener((raw: unknown) => {
      if (!started) {
        started = true;
        void this.startTransfer(origin, raw, post, finish, (port) => {
          inner = port;
        }, (u) => {
          upload = u;
        }).catch((e: unknown) => finish({ kind: "failed", ...failedOf(e) }));
        return;
      }
      // After the open, only an upload's data and end are taken, and only once
      // the member confirmed it.
      const m = raw as { kind?: unknown; data?: unknown };
      if (!upload?.ready || !inner) return finish({ kind: "failed", error: "send the file only after the wallet is ready", code: "invalidCall" });
      if (m.kind === "data" && typeof m.data === "string") {
        upload.sent += Math.floor((m.data.length * 3) / 4);
        if (upload.sent > upload.size + 2) return finish({ kind: "failed", error: "more bytes than the file was declared to hold", code: "invalidCall" });
        inner.postMessage({ kind: "data", data: m.data });
      } else if (m.kind === "end") {
        inner.postMessage({ kind: "end" });
      } else {
        finish({ kind: "failed", error: "a transfer takes data, then end", code: "invalidCall" });
      }
    });
  }

  private async startTransfer(
    origin: string,
    raw: unknown,
    post: (m: RoomFilesPageMessage) => void,
    finish: (m: RoomFilesPageMessage) => void,
    setInner: (p: PortLike) => void,
    setUpload: (u: { size: number; sent: number; ready: boolean }) => void,
  ): Promise<void> {
    const malformed = roomFilesPageOpenRefusal(raw);
    if (malformed) return finish({ kind: "failed", error: malformed, code: "invalidCall" });
    const o = raw as RoomFilesPageOpen;
    let vta: ActiveVta;
    let member: string;
    try {
      ({ vta } = await this.atPortal(origin, o.hostDid, { needReach: true }));
      member = await this.granted(origin, o.hostDid, vta, o.roomId);
    } catch (e) {
      return finish({ kind: "failed", ...failedOf(e) });
    }
    const target = {
      vtaDid: vta.vtaDid,
      ...(vta.restBaseUrl ? { restBaseUrl: vta.restBaseUrl } : {}),
      roomId: o.roomId,
      hostDid: o.hostDid,
      member,
    };

    if (o.kind === "put") {
      const info = (await this.offscreen(vta, {
        op: "info",
        hostDid: o.hostDid,
        roomId: o.roomId,
        member,
      })) as PageRoomInfoView;
      const decision = await this.deps.prompt({
        kind: "write",
        origin,
        hostDid: o.hostDid,
        roomId: o.roomId,
        member: info.member,
        visibility: info.visibility,
        what: {
          file: true,
          name: o.name,
          size: o.size,
          ...(o.mediaType !== undefined ? { mediaType: o.mediaType } : {}),
          ...(o.title !== undefined ? { title: o.title } : {}),
        },
      });
      if (!decision.approved) return finish({ kind: "failed", error: "the member declined to add this file", code: "declined" });
    }

    const inner = await this.deps.openTransfer();
    setInner(inner);
    // The download's pieces: held here, never posted, until the whole file has
    // verified against its author's digest (`got`). Dropped on anything else.
    const held: string[] = [];
    let got: Extract<RoomFilesMessage, { kind: "got" }> | undefined;
    let ended = false;
    inner.onMessage.addListener((raw: unknown) => {
      const m = raw as RoomFilesMessage;
      switch (m.kind) {
        case "progress":
          post({ kind: "progress", stage: m.stage, ...(m.done !== undefined ? { done: m.done } : {}), ...(m.total !== undefined ? { total: m.total } : {}) });
          return;
        case "provisional":
          held.push(m.data);
          return;
        case "got": {
          got = m;
          ended = true;
          post({
            kind: "got",
            file: m.file,
            author: m.author,
            signed: m.signed,
            version: m.version,
            ...(m.title !== undefined ? { title: m.title } : {}),
            ...(m.description !== undefined ? { description: m.description } : {}),
            ...(m.tags !== undefined ? { tags: m.tags } : {}),
          });
          for (const data of held.splice(0)) post({ kind: "data", data });
          finish({ kind: "done" });
          return;
        }
        case "put":
          ended = true;
          finish({ kind: "put", key: m.key, version: m.version, size: m.size });
          return;
        case "failed":
          ended = true;
          held.length = 0;
          finish({ kind: "failed", error: m.error, code: forwardedCode(m.code) });
          return;
      }
    });
    inner.onDisconnect.addListener(() => {
      held.length = 0;
      if (!ended && !got) finish({ kind: "failed", error: "the wallet's transfer ended before it finished", code: "walletUnavailable" });
    });

    const begin: RoomFilesOpen =
      o.kind === "get"
        ? { kind: "get", ...target, key: o.key }
        : {
            kind: "put",
            ...target,
            name: o.name,
            size: o.size,
            ...(o.mediaType !== undefined ? { mediaType: o.mediaType } : {}),
            ...(o.title !== undefined ? { title: o.title } : {}),
            ...(o.description !== undefined ? { description: o.description } : {}),
            ...(o.tags !== undefined ? { tags: o.tags } : {}),
          };
    inner.postMessage(begin);
    if (o.kind === "put") {
      setUpload({ size: o.size, sent: 0, ready: true });
      post({ kind: "ready" });
    }
  }
}

/**
 * `offered` names with each room's own profile laid over them: a profile name
 * wins over the community's offer label (`labelSource` says which it is), and
 * the profile's description and its two facts — stale, a refused rename — ride
 * along. A profile without a name changes nothing but those facts.
 */
export function withProfiles(
  offered: Readonly<RoomNames>,
  profiles: Readonly<Record<string, RoomProfileSummary>>,
): RoomNames {
  const out: RoomNames = {};
  for (const [roomId, n] of Object.entries(offered)) out[roomId] = { ...n, labelSource: "community" };
  for (const [roomId, p] of Object.entries(profiles)) {
    const had = out[roomId];
    const facts = {
      ...(p.stale ? { profileStale: true } : {}),
      ...(p.renameRefused ? { renameRefused: true } : {}),
    };
    if (p.status === "found" && p.name !== undefined) {
      out[roomId] = {
        label: p.name,
        ...(had?.visibility !== undefined ? { visibility: had.visibility } : {}),
        // The room's state is the community's, whatever the room calls itself.
        ...(had ? storedRoomState(had as unknown as Record<string, unknown>) : {}),
        labelSource: "profile",
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...facts,
      };
    } else if (had) {
      out[roomId] = { ...had, ...facts };
    }
  }
  return out;
}

function sameScopeRow(r: SessionGrantRow, s: SessionGrantScope): boolean {
  return r.origin === s.origin && r.hostDid === s.hostDid && r.vtaDid === s.vtaDid && r.roomId === s.roomId && r.member === s.member;
}
