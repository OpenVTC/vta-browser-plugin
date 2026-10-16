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
  portalRefusal,
  roomFilesPageOpenRefusal,
  roomGrantRefusal,
  roomsPageParamsRefusal,
  shareRefusal,
  withGrants,
  withoutGrant,
  type RoomGrant,
  type RoomShareConsentView,
  type RoomWriteConsentView,
} from "./room-page-policy.js";

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
  now(): number;
}

/** How long a community's resolved portal is trusted before it is resolved again. */
const PORTAL_CACHE_MS = 5 * 60 * 1000;

class RoomPageRefusal extends Error {}

export class RoomPageGates {
  private readonly portals = new Map<string, { portalOrigin: string; endpoint: string; at: number }>();

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

  /** Gate 3. */
  private async granted(origin: string, hostDid: string, vta: ActiveVta, roomId: string): Promise<void> {
    const grants = await this.deps.loadGrants(origin, vta.vtaDid);
    const refusal = roomGrantRefusal(grants, { origin, hostDid, vtaDid: vta.vtaDid }, roomId, this.deps.now());
    if (refusal) throw new RoomPageRefusal(refusal);
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
        return this.choose(origin, p.hostDid, p.suggest);
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
        await this.granted(origin, p.hostDid, vta, p.roomId);
        const { op, ...rest } = p;
        return this.offscreen(vta, { op, ...rest } as OffscreenRoomsPageOp);
      }
      case "putNote": {
        const { vta } = await this.atPortal(origin, p.hostDid, { needReach: true });
        await this.granted(origin, p.hostDid, vta, p.roomId);
        const info = (await this.offscreen(vta, { op: "info", hostDid: p.hostDid, roomId: p.roomId })) as PageRoomInfoView;
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
        return this.offscreen(vta, { ...p, op: "putNote" });
      }
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
    const held = new Map(
      ((await this.offscreen(vta, { op: "held" })) as { roomId: string; epoch: number; earliestReadableEpoch: number }[]).map(
        (r) => [r.roomId, r],
      ),
    );
    return grants.map((g) => {
      const h = held.get(g.roomId);
      return {
        roomId: g.roomId,
        held: h !== undefined,
        ...(h ? { epoch: h.epoch, earliestReadableEpoch: h.earliestReadableEpoch } : {}),
        sharedAt: new Date(g.grantedAt).toISOString(),
        expiresAt: new Date(g.expiresAt).toISOString(),
      };
    });
  }

  private async choose(
    origin: string,
    hostDid: string,
    suggest: string | undefined,
  ): Promise<{ rooms: PageRoomView[]; refused: { roomId: string; reason: string }[] }> {
    const { vta, endpoint } = await this.atPortal(origin, hostDid, { needReach: false });
    const at = { origin, hostDid, vtaDid: vta.vtaDid };
    const now = this.deps.now();
    const grants = await this.deps.loadGrants(origin, vta.vtaDid);
    const shared = new Set(liveGrants(grants, at, now).map((g) => g.roomId));
    const held = (await this.offscreen(vta, { op: "held" })) as { roomId: string }[];
    const reach = await this.deps.canReach(endpoint);
    const decision = await this.deps.prompt({
      kind: "share",
      origin,
      hostDid,
      rooms: held.map((r) => ({ roomId: r.roomId, shared: shared.has(r.roomId), suggested: r.roomId === suggest })),
      ...(reach ? {} : { needsOrigin: new URL(endpoint).origin }),
    });
    if (!decision.approved) return { rooms: await this.views(origin, hostDid, vta), refused: [] };

    // Only rooms the window offered: a selection naming anything else is ignored.
    const offered = new Set(held.map((r) => r.roomId));
    const selected = [...new Set((decision.selectedRooms ?? []).filter((r) => offered.has(r)))];
    const refused: { roomId: string; reason: string }[] = [];
    const ok: string[] = [];
    for (const roomId of selected) {
      // Confirm with the host, as the member, that it holds the room — and
      // read its tier. Only for rooms the member just chose to share here.
      const res = await this.deps.offscreen(vta, { op: "info", hostDid, roomId });
      if (!res.ok) {
        refused.push({ roomId, reason: `the community could not confirm it holds this room: ${res.error}` });
        continue;
      }
      const why = shareRefusal((res.result as PageRoomInfoView).visibility);
      if (why) {
        refused.push({ roomId, reason: `not shared: ${why}` });
        continue;
      }
      ok.push(roomId);
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
    try {
      ({ vta } = await this.atPortal(origin, o.hostDid, { needReach: true }));
      await this.granted(origin, o.hostDid, vta, o.roomId);
    } catch (e) {
      return finish({ kind: "failed", error: e instanceof Error ? e.message : String(e) });
    }
    const target = {
      vtaDid: vta.vtaDid,
      ...(vta.restBaseUrl ? { restBaseUrl: vta.restBaseUrl } : {}),
      roomId: o.roomId,
      hostDid: o.hostDid,
    };

    if (o.kind === "put") {
      const info = (await this.offscreen(vta, { op: "info", hostDid: o.hostDid, roomId: o.roomId })) as PageRoomInfoView;
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
