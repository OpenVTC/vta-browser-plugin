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
// own window, seeing the room, who will sign and what will be written.
//
// What goes back is a view the offscreen document built; an error is a
// sentence, never the agent's or the host's `code` and `details`.
//
// Written against injected dependencies, not `chrome.*`, so the gates are
// tested as they run.

import type {
  OffscreenRoomsPageOp,
  OffscreenRoomsPageResponse,
  PageRoomInfoView,
  PageRoomView,
  RoomFilesMessage,
  RoomFilesOpen,
  RoomFilesPageMessage,
  RoomFilesPageOpen,
  RoomsPageOp,
  RuntimeRoomsPageResponse,
} from "./bridge-protocol.js";
import {
  excerpt,
  liveGrants,
  mergeRoomNames,
  portalRefusal,
  roomFilesPageOpenRefusal,
  roomGrant,
  roomsPageParamsRefusal,
  selectedShares,
  shareRefusal,
  shareRows,
  withGrants,
  withoutGrant,
  type RememberedRoomName,
  type RoomGrant,
  type RoomShareConsentView,
  type RoomWriteConsentView,
} from "./room-page-policy.js";

/** One entry of the VTA's listing, as the offscreen document reports it. */
interface HeldEntry {
  roomId: string;
  epoch: number;
  earliestReadableEpoch: number;
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
  active(): Promise<{ ok: true; vta: ActiveVta } | { ok: false; error: string }>;
  offscreen(vta: ActiveVta, op: OffscreenRoomsPageOp): Promise<OffscreenRoomsPageResponse>;
  /** Whether the wallet holds a host permission for `url`'s origin. */
  canReach(url: string): Promise<boolean>;
  loadGrants(origin: string, vtaDid: string): Promise<RoomGrant[]>;
  saveGrants(origin: string, vtaDid: string, grants: RoomGrant[]): Promise<void>;
  /** Raise a room prompt and wait. A closed window is a denial. */
  prompt(view: RoomShareConsentView | RoomWriteConsentView): Promise<{ approved: boolean; selectedRooms?: string[] }>;
  /** Open a transfer with the offscreen document (`ROOM_FILES_PORT`). */
  openTransfer(): Promise<PortLike>;
  /** The community's offers of its rooms (`room-offers-background.ts`). Absent: the portal sees none. */
  offers?: PortalOffers;
  now(): number;
  /** The room names remembered for one community under one VTA (`roomNamesKey`). Absent: none kept. */
  loadRoomNames?(vtaDid: string, hostDid: string): Promise<unknown>;
  saveRoomNames?(vtaDid: string, hostDid: string, names: Record<string, RememberedRoomName>): Promise<void>;
}

/** A room's name, as a page or the share prompt is shown it. */
type RoomNames = Record<string, { label: string; visibility?: string }>;

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

class RoomPageRefusal extends Error {}

export class RoomPageGates {
  private readonly portals = new Map<string, { portalOrigin: string; endpoint: string; at: number }>();
  /** When each (VTA, community, member)'s offers were last read for room names. */
  private readonly namesReadAt = new Map<string, number>();

  constructor(private readonly deps: RoomPageBackgroundDeps) {}

  /** `hostDid`'s portal and endpoint, resolved through the offscreen document and cached briefly. */
  private async portal(vta: ActiveVta, hostDid: string): Promise<{ portalOrigin: string; endpoint: string }> {
    const now = this.deps.now();
    const hit = this.portals.get(hostDid);
    if (hit && now - hit.at < PORTAL_CACHE_MS) return hit;
    const res = await this.deps.offscreen(vta, { op: "portal", hostDid });
    if (!res.ok) throw new RoomPageRefusal(res.error);
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
    if (!active.ok) throw new RoomPageRefusal(active.error);
    const { portalOrigin, endpoint } = await this.portal(active.vta, hostDid);
    const refusal = portalRefusal(origin, hostDid, portalOrigin);
    if (refusal) throw new RoomPageRefusal(refusal);
    if (opts.needReach && !(await this.deps.canReach(endpoint))) {
      throw new RoomPageRefusal(
        `The wallet may not reach ${new URL(endpoint).origin} yet. Share a room again (rooms.choose) and ` +
          `allow it there, or allow it from the wallet's popup.`,
      );
    }
    return { vta: active.vta, endpoint };
  }

  /** Gate 3. Returns the member the share acts as: every request for the page names it. */
  private async granted(origin: string, hostDid: string, vta: ActiveVta, roomId: string): Promise<string> {
    const grants = await this.deps.loadGrants(origin, vta.vtaDid);
    const r = roomGrant(grants, { origin, hostDid, vtaDid: vta.vtaDid }, roomId, this.deps.now());
    if (!r.ok) throw new RoomPageRefusal(r.error);
    return r.grant.member;
  }

  private async offscreen(vta: ActiveVta, op: OffscreenRoomsPageOp): Promise<unknown> {
    const res = await this.deps.offscreen(vta, op);
    if (!res.ok) throw new RoomPageRefusal(res.error);
    return res.result;
  }

  /** One `rooms.*` call from a page at `origin` (browser-attested). */
  async handle(origin: string, raw: unknown): Promise<RuntimeRoomsPageResponse> {
    try {
      const malformed = roomsPageParamsRefusal(raw);
      if (malformed) return { ok: false, error: malformed };
      return { ok: true, result: await this.run(origin, raw as RoomsPageOp) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async run(origin: string, p: RoomsPageOp): Promise<unknown> {
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
      case "read": {
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
        if (!this.deps.offers) throw new RoomPageRefusal("this wallet does not handle room offers");
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: false });
        const members = ((await this.offscreen(vta, { op: "members", hostDid: p.hostDid })) as string[]).filter(
          (m) => m !== p.hostDid,
        );
        if (p.op === "offers") return this.deps.offers.forPortal(vta, p.hostDid, members);
        if (p.member !== undefined && !members.includes(p.member)) {
          throw new RoomPageRefusal(`${p.member} is not an identity you use at this community`);
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
        if (!decision.approved) throw new RoomPageRefusal("the member declined to add this note");
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
        { label: n.label, ...(n.visibility !== undefined ? { visibility: n.visibility } : {}) },
      ]),
    );
  }

  /** The live shares for this origin and community, joined with what the VTA still holds. */
  private async views(origin: string, hostDid: string, vta: ActiveVta): Promise<PageRoomView[]> {
    const grants = liveGrants(
      await this.deps.loadGrants(origin, vta.vtaDid),
      { origin, hostDid, vtaDid: vta.vtaDid },
      this.deps.now(),
    );
    if (grants.length === 0) return [];
    const held = (await this.offscreen(vta, { op: "held" })) as HeldEntry[];
    const names = await this.roomNames(
      vta,
      hostDid,
      grants.map((g) => g.member),
    );
    return grants.map((g) => {
      // Held as the member it is shared as: the same room held as somebody
      // else is not this share's.
      const h = held.find((r) => r.roomId === g.roomId && r.member === g.member);
      return {
        roomId: g.roomId,
        member: g.member,
        held: h !== undefined,
        ...(h ? { epoch: h.epoch, earliestReadableEpoch: h.earliestReadableEpoch } : {}),
        sharedAt: new Date(g.grantedAt).toISOString(),
        expiresAt: new Date(g.expiresAt).toISOString(),
        ...(names[g.roomId]
          ? {
              label: names[g.roomId]!.label,
              ...(names[g.roomId]!.visibility !== undefined ? { visibility: names[g.roomId]!.visibility } : {}),
            }
          : {}),
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
    const held = (await this.offscreen(vta, { op: "held" })) as HeldEntry[];
    // Who the member is at this community, by the wallet's own record — the
    // page's word only picks among these, never adds to them.
    const members = (await this.offscreen(vta, { op: "members", hostDid })) as string[];
    const names = await this.roomNames(
      vta,
      hostDid,
      members.filter((m) => m !== hostDid),
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
    if (!picked.ok) throw new RoomPageRefusal(picked.error);
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
        }).catch((e: unknown) => finish({ kind: "failed", error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      // After the open, only an upload's data and end are taken, and only once
      // the member confirmed it.
      const m = raw as { kind?: unknown; data?: unknown };
      if (!upload?.ready || !inner) return finish({ kind: "failed", error: "send the file only after the wallet is ready" });
      if (m.kind === "data" && typeof m.data === "string") {
        upload.sent += Math.floor((m.data.length * 3) / 4);
        if (upload.sent > upload.size + 2) return finish({ kind: "failed", error: "more bytes than the file was declared to hold" });
        inner.postMessage({ kind: "data", data: m.data });
      } else if (m.kind === "end") {
        inner.postMessage({ kind: "end" });
      } else {
        finish({ kind: "failed", error: "a transfer takes data, then end" });
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
    if (malformed) return finish({ kind: "failed", error: malformed });
    const o = raw as RoomFilesPageOpen;
    let vta: ActiveVta;
    let member: string;
    try {
      ({ vta } = await this.atPortal(origin, o.hostDid, { needReach: true }));
      member = await this.granted(origin, o.hostDid, vta, o.roomId);
    } catch (e) {
      return finish({ kind: "failed", error: e instanceof Error ? e.message : String(e) });
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
      if (!decision.approved) return finish({ kind: "failed", error: "the member declined to add this file" });
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
          finish({ kind: "failed", error: m.error });
          return;
      }
    });
    inner.onDisconnect.addListener(() => {
      held.length = 0;
      if (!ended && !got) finish({ kind: "failed", error: "the wallet's transfer ended before it finished" });
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
