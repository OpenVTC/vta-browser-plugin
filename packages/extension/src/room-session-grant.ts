// A session grant: "send messages and reactions in this room without asking
// while this room is open" (P7b; VTI `data-rooms-files.md` §8.5).
//
// The second bounded exception to "every page write is confirmed" (the first is
// the 30-minute reaction grant on the share, `reactionGrantLive`). Granted only
// by the member ticking the box in a message's or a reaction's own confirm, and
// covering only messages (`putMessage`, a reply included), `react` and
// `unreact` — never a note, a file or anything else.
//
// **"While this room is open" is a page session, not a clock.** The grant is
// bound to the one document that asked (its tab and the browser's `documentId`,
// which a reload or a navigation replaces) and lives only while that document
// holds a watch on that room (`rooms.watch`, the port a room page keeps open
// while it shows the room). The last such port closing — the member leaving the
// room, closing the tab, reloading, navigating away, or the wallet's worker
// being put to sleep — ends it. A new tab, or the same tab reloaded, is a new
// document and asks again.
//
// It also ends on: 30 minutes with no write under it, 8 hours from the confirm
// whatever the use, the share ending, the wallet locking, or Stop. Nothing
// extends it past those, and it is held in the worker's memory only — never
// stored, so nothing outlives the worker either.
//
// More than RATE_LIMIT writes under it in a rolling minute, or a message longer
// than SESSION_MESSAGE_MAX_CHARS, is asked for in the window as usual; the grant
// stays.

/** No write under the grant for this long ends it. */
export const SESSION_GRANT_IDLE_MS = 30 * 60 * 1000;
/** A grant never lasts longer than this from its confirm, however used. */
export const SESSION_GRANT_CAP_MS = 8 * 60 * 60 * 1000;
/** Writes under one grant in any rolling minute before the window is asked again. */
export const SESSION_GRANT_RATE_LIMIT = 10;
export const SESSION_GRANT_RATE_WINDOW_MS = 60 * 1000;
/** A message longer than this is always confirmed: a chat line, not a document. */
export const SESSION_MESSAGE_MAX_CHARS = 4000;

/** The page document a call or a port came from, as the browser reports it. */
export interface PageSession {
  tabId: number;
  /** The browser's id for this document: a reload or a navigation gets a new one. */
  documentId: string;
}

/** What a session grant is for: the share it rides on, exactly. */
export interface SessionGrantScope {
  origin: string;
  hostDid: string;
  vtaDid: string;
  roomId: string;
  member: string;
}

/** A live session grant, as the console lists it. */
export interface SessionGrantRow extends SessionGrantScope {
  id: string;
  roomLabel?: string;
  grantedAt: number;
  lastUsedAt: number;
  /** When it ends at the latest if used no more: the earlier of idle and cap. */
  endsBy: number;
}

interface Entry {
  id: string;
  scope: SessionGrantScope;
  session: PageSession;
  roomLabel?: string;
  grantedAt: number;
  lastUsedAt: number;
  /** When each recent write under it ran, for the rate limit. */
  recent: number[];
}

/** Whether a write may run without a window, and if not, why. */
export type SessionCover = "covered" | "none" | "ask";

function sameSession(a: PageSession, b: PageSession): boolean {
  return a.tabId === b.tabId && a.documentId === b.documentId;
}

function sameScope(a: SessionGrantScope, b: SessionGrantScope): boolean {
  return (
    a.origin === b.origin && a.hostDid === b.hostDid && a.vtaDid === b.vtaDid && a.roomId === b.roomId && a.member === b.member
  );
}

/** The key an open room is counted under: one document, one origin, one community, one room. */
function openKey(session: PageSession, origin: string, hostDid: string, roomId: string): string {
  return JSON.stringify([session.tabId, session.documentId, origin, hostDid, roomId]);
}

export class RoomSessionGrants {
  private readonly entries = new Map<string, Entry>();
  /** How many watch ports each (document, origin, community, room) holds open. */
  private readonly open = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly now: () => number,
    /** Told whenever the set of live grants may have changed (the action badge). */
    private readonly changed: () => void = () => undefined,
  ) {}

  /**
   * A page document began holding a watch on a room. Returns the function that
   * ends it; the last one ending for that document and room ends its grants.
   */
  roomOpened(session: PageSession, origin: string, hostDid: string, roomId: string): () => void {
    const k = openKey(session, origin, hostDid, roomId);
    this.open.set(k, (this.open.get(k) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.open.get(k) ?? 1) - 1;
      if (n > 0) {
        this.open.set(k, n);
        return;
      }
      this.open.delete(k);
      this.endWhere(
        (e) =>
          sameSession(e.session, session) && e.scope.origin === origin && e.scope.hostDid === hostDid && e.scope.roomId === roomId,
      );
    };
  }

  /** Whether `session` has `roomId` open now: the only time a grant may be offered or used. */
  isOpen(session: PageSession, origin: string, hostDid: string, roomId: string): boolean {
    return (this.open.get(openKey(session, origin, hostDid, roomId)) ?? 0) > 0;
  }

  /**
   * Record the member's explicit grant, from a confirm's box. Refused (false)
   * when the room is not open in that document — nothing would end it.
   */
  grant(scope: SessionGrantScope, session: PageSession, roomLabel?: string): boolean {
    if (!this.isOpen(session, scope.origin, scope.hostDid, scope.roomId)) return false;
    // One grant per document and share: a second confirm replaces the first.
    this.endWhere((e) => sameSession(e.session, session) && sameScope(e.scope, scope), false);
    const now = this.now();
    const id = `sg-${++this.seq}-${now}`;
    this.entries.set(id, {
      id,
      scope: { ...scope },
      session: { ...session },
      ...(roomLabel ? { roomLabel } : {}),
      grantedAt: now,
      lastUsedAt: now,
      recent: [],
    });
    this.changed();
    return true;
  }

  /**
   * Whether a write for `scope` from `session` runs without a window. Ends any
   * grant that has run out. Does not record a use: `used` does, once it ran.
   */
  cover(scope: SessionGrantScope, session: PageSession | undefined, opts: { messageChars?: number } = {}): SessionCover {
    if (!session) return "none";
    this.prune();
    const e = this.find(scope, session);
    if (!e) return "none";
    if (!this.isOpen(session, scope.origin, scope.hostDid, scope.roomId)) {
      this.endWhere((x) => x.id === e.id);
      return "none";
    }
    if (opts.messageChars !== undefined && opts.messageChars > SESSION_MESSAGE_MAX_CHARS) return "ask";
    const now = this.now();
    e.recent = e.recent.filter((t) => now - t < SESSION_GRANT_RATE_WINDOW_MS);
    if (e.recent.length >= SESSION_GRANT_RATE_LIMIT) return "ask";
    return "covered";
  }

  /** A write ran under `scope`'s grant (or was confirmed while it stood): it counts toward the rate and idle. */
  used(scope: SessionGrantScope, session: PageSession | undefined): void {
    if (!session) return;
    const e = this.find(scope, session);
    if (!e) return;
    const now = this.now();
    e.lastUsedAt = now;
    e.recent.push(now);
  }

  /** The live grants, for the console. */
  list(): SessionGrantRow[] {
    this.prune();
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      ...e.scope,
      ...(e.roomLabel ? { roomLabel: e.roomLabel } : {}),
      grantedAt: e.grantedAt,
      lastUsedAt: e.lastUsedAt,
      endsBy: Math.min(e.lastUsedAt + SESSION_GRANT_IDLE_MS, e.grantedAt + SESSION_GRANT_CAP_MS),
    }));
  }

  /** The member pressed Stop. */
  stop(id: string): boolean {
    return this.endWhere((e) => e.id === id) > 0;
  }

  /** End every grant (the wallet locked, or the active agent changed). */
  endAll(): void {
    this.endWhere(() => true);
  }

  /** End every grant from one tab (it closed). */
  endForTab(tabId: number): void {
    this.endWhere((e) => e.session.tabId === tabId);
  }

  /** End the grants whose share is no longer live, by `stillShared`. */
  endUnshared(stillShared: (scope: SessionGrantScope) => boolean): void {
    this.endWhere((e) => !stillShared(e.scope));
  }

  private find(scope: SessionGrantScope, session: PageSession): Entry | undefined {
    for (const e of this.entries.values()) {
      if (sameSession(e.session, session) && sameScope(e.scope, scope)) return e;
    }
    return undefined;
  }

  /** End the grants past their idle limit or their cap. */
  private prune(): void {
    const now = this.now();
    this.endWhere((e) => now - e.lastUsedAt >= SESSION_GRANT_IDLE_MS || now - e.grantedAt >= SESSION_GRANT_CAP_MS);
  }

  private endWhere(pred: (e: Entry) => boolean, notify = true): number {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (pred(e)) {
        this.entries.delete(id);
        n++;
      }
    }
    if (n > 0 && notify) this.changed();
    return n;
  }
}
