// Watching rooms through the member's own VTA (`rooms/keys/watch/0.1`,
// `rooms/keys/changed/0.1`; trust-tasks-tf #1040).
//
// A wallet whose member keys are at its VTA cannot arm `rooms/watch` itself: it
// cannot present as the member (the host would take the wallet's key as the
// member), and it has no address a host can reach. So it asks the VTA to arm
// each watch, as the member, at an address the VTA controls and never tells it;
// the VTA passes each signal on as `rooms/keys/changed`, through the mediator
// where the wallet already collects from it — the way `task-consent/granted`
// arrives.
//
// What this module holds, and what it leaves to the surface:
//
// - **The two tasks' wire**: {@link roomsKeysWatch} (with the response checked
//   against what was asked) and {@link parseRoomsKeysChanged} (accepted only
//   from the wallet's own VTA, as the transport proved it, and only when the
//   payload is the closed schema's).
// - **Which watches are armed** ({@link RoomWatcher}): one request per member
//   and host, up to 64 rooms; one signal per arming, so a signal for a watch
//   that has fired, was cancelled, or was never armed is dropped silently; a
//   watch is re-armed only after a read, never more often than the reader
//   reads; a refusal leaves the room to polling, quietly.
// - **What is unread after reading** ({@link unreadMessages}): decided by the
//   reader from the records it opened, never from the signal.
//
// The surface does the reading, keeps the read marker, and decides whether to
// alert. A signal is a reason to read and nothing else (`rooms/keys/changed/0.1`
// consumer item 2).

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { TRUST_TASK_ENVELOPE_TYPE } from "../vta/protocol.js";
import { validateAgainstSchema } from "../trust-tasks/validate.js";
import {
  TYPE_URI as KEYS_WATCH,
  RESPONSE_TYPE_URI as KEYS_WATCH_RESPONSE,
  type RoomsKeysWatchPayload,
  type RoomsKeysWatchResponsePayload,
  type OutcomeForOneRoom,
} from "../specs/rooms/keys/watch/0.1/payload.js";
import {
  PAYLOAD_SCHEMA as KEYS_CHANGED_SCHEMA,
  TYPE_URI as KEYS_CHANGED,
  type RoomsKeysChangedPayload,
} from "../specs/rooms/keys/changed/0.1/payload.js";
import type { RecordInput, RoomRecordsView } from "./record-view.js";

export const ROOMS_KEYS_WATCH_TYPE = KEYS_WATCH;
export const ROOMS_KEYS_CHANGED_TYPE = KEYS_CHANGED;
export type { RoomsKeysChangedPayload, OutcomeForOneRoom as RoomWatchOutcome };

/** The most rooms one `rooms/keys/watch/0.1` request names. */
export const ROOMS_KEYS_WATCH_MAX_ROOMS = 64;

/** One room to arm or cancel, with the version the reader has read it to. */
export interface RoomWatchRoom {
  roomId: string;
  sinceVersion?: number;
}

export interface RoomsWatchParams {
  holder: TaskParty;
  /** The member's own VTA: the key holder that arms the watches. */
  service: TaskParty;
  /** The member to watch as — always named; the VTA never picks one. */
  member: string;
  host: string;
  rooms: readonly RoomWatchRoom[];
  leaseSeconds?: number;
  cancel?: true;
}

/**
 * Ask the member's VTA to arm, re-arm or cancel watches on `rooms` at `host`
 * (`rooms/keys/watch/0.1`). Answers one outcome per room, in the order asked;
 * a response that does not echo the member and host, or does not answer each
 * room in order, is refused rather than read.
 */
export async function roomsKeysWatch(
  sender: TrustTaskSender,
  params: RoomsWatchParams,
): Promise<OutcomeForOneRoom[]> {
  if (params.rooms.length === 0 || params.rooms.length > ROOMS_KEYS_WATCH_MAX_ROOMS) {
    throw new RangeError(`rooms/keys/watch names 1 to ${ROOMS_KEYS_WATCH_MAX_ROOMS} rooms, not ${params.rooms.length}`);
  }
  if (new Set(params.rooms.map((r) => r.roomId)).size !== params.rooms.length) {
    throw new RangeError("rooms/keys/watch names each room at most once");
  }
  const payload: RoomsKeysWatchPayload = {
    member: params.member,
    host: params.host,
    rooms: params.rooms.map((r) => ({
      roomId: r.roomId,
      ...(params.cancel === undefined && r.sinceVersion !== undefined ? { sinceVersion: r.sinceVersion } : {}),
    })) as RoomsKeysWatchPayload["rooms"],
    ...(params.cancel === undefined && params.leaseSeconds !== undefined ? { leaseSeconds: params.leaseSeconds } : {}),
    ...(params.cancel !== undefined ? { cancel: true as const } : {}),
  };
  const envelope = buildTrustTask(KEYS_WATCH, payload, { issuer: params.holder.did, recipient: params.service.did });
  const res = await sender.send<RoomsKeysWatchResponsePayload>(envelope, {
    expectedResponseType: KEYS_WATCH_RESPONSE,
    operationLabel: "rooms/keys/watch/0.1",
  });
  const watches = res.watches ?? [];
  if (
    res.member !== params.member ||
    res.host !== params.host ||
    watches.length !== params.rooms.length ||
    watches.some((w, i) => w.roomId !== params.rooms[i]!.roomId)
  ) {
    throw new Error(`${params.service.did} answered rooms/keys/watch with outcomes that are not the rooms asked, in order`);
  }
  return watches;
}

/**
 * A `rooms/keys/changed/0.1` the wallet received, or `null` when the message is
 * not one it may act on.
 *
 * The VTA sends a full Trust Task document inside the binding envelope, the way
 * it sends `task-consent/granted`: the transport's `type` is
 * {@link TRUST_TASK_ENVELOPE_TYPE} and `body` is the document. It is accepted
 * only when the **transport-authenticated** sender is this wallet's own VTA
 * (never the message's own `from`), an in-band `issuer` agrees, and the payload
 * is exactly the closed schema's. Whether the wallet armed a watch for it is
 * the next question, and {@link RoomWatcher.accept} answers it.
 */
export function parseRoomsKeysChanged(
  message: Record<string, unknown>,
  expectedVtaDid: string,
  senderDid: string | null | undefined,
): RoomsKeysChangedPayload | null {
  if (message.type !== TRUST_TASK_ENVELOPE_TYPE) return null;
  if (!senderDid || senderDid !== expectedVtaDid) return null;
  const doc = (message.body ?? {}) as { type?: unknown; issuer?: unknown; payload?: unknown };
  if (doc.type !== KEYS_CHANGED) return null;
  if (typeof doc.issuer === "string" && doc.issuer !== expectedVtaDid) return null;
  if (!validateAgainstSchema(KEYS_CHANGED_SCHEMA, doc.payload).valid) return null;
  return doc.payload as RoomsKeysChangedPayload;
}

// ── Which watches are armed ─────────────────────────────────────────────────

/** One watch: a room, read as a member, at a host, through one VTA. */
export interface RoomWatchKey {
  vtaDid: string;
  member: string;
  host: string;
  roomId: string;
}

/** A watch's key as a string. */
export function roomWatchId(k: RoomWatchKey): string {
  return JSON.stringify([k.vtaDid, k.member, k.host, k.roomId]);
}

/**
 * Where a watch stands, as the surface uses it to pace its polling.
 *
 * - `arming`: asked, not yet answered.
 * - `armed`: the VTA holds it; a signal is expected (`expiresAt`).
 * - `fired`: its one signal arrived; it is re-armed after the next read.
 * - `refused`: the VTA or the host would not arm it (`refused`, `hostCode`) — poll.
 * - `unavailable`: the request as a whole failed (no such task, a refusal of the
 *   member, a transport failure) — poll.
 * - `lapsed`: it reached `expiresAt` without a signal; re-armed after the next read.
 */
export type RoomWatchState =
  | { state: "arming" }
  | { state: "armed"; expiresAt?: string }
  | { state: "fired" }
  | { state: "refused"; refused: string; hostCode?: string }
  | { state: "unavailable"; reason: string }
  | { state: "lapsed" };

/** Whether a surface may slow its polling: a watch is armed or being armed. */
export function watchCovers(s: RoomWatchState | undefined): boolean {
  return s !== undefined && (s.state === "armed" || s.state === "arming");
}

/** The watch request as the {@link RoomWatcher} hands it to whoever sends it. */
export interface RoomWatchBatch {
  vtaDid: string;
  member: string;
  host: string;
  rooms: RoomWatchRoom[];
  leaseSeconds?: number;
  cancel?: true;
}

export interface RoomWatcherOptions {
  /** Send one `rooms/keys/watch` request: normally {@link roomsKeysWatch} with the VTA's parties. */
  send: (batch: RoomWatchBatch) => Promise<OutcomeForOneRoom[]>;
  /** How long to ask each watch to last. Default: one day. */
  leaseSeconds?: number;
  now?: () => number;
  /** Timers, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** How long arm requests are gathered before they go, so panes opening together share one request per host. Default 50 ms. */
  gatherMs?: number;
}

/** After a refusal of one room, how long before a read may try to arm it again. */
export const WATCH_RETRY_REFUSED_MS = 60 * 60_000;
/** After `hostUnreachable`, which a retry may cure. */
export const WATCH_RETRY_UNREACHABLE_MS = 5 * 60_000;
/**
 * The longest a timer may be set for: a longer delay overflows to "at once" in
 * every runtime, which would lapse a far-off watch the moment it was armed. A
 * watch whose `expiresAt` is further off is checked again then, and re-armed
 * after a read as any lapsed one is — early, never late.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** After the request as a whole failed. */
export const WATCH_RETRY_UNAVAILABLE_MS = 15 * 60_000;

interface Entry {
  key: RoomWatchKey;
  holders: number;
  status: RoomWatchState;
  /** Which arming the status belongs to; a signal fires only the current one. */
  arming: number;
  retryAt?: number;
  lapseTimer?: unknown;
  /** The arming queued and not yet sent, with the version read to. */
  queued?: { sinceVersion?: number };
}

/**
 * The watches one surface holds, armed through its VTA.
 *
 * - {@link hold} / {@link release}: a pane showing a room holds its watch, and
 *   releasing the last hold cancels it at the VTA.
 * - {@link afterRead}: called after every read of a room, with the version
 *   read to. It arms a watch that has none, has fired or has lapsed — so a
 *   watch is re-armed only after a read — and leaves an armed one alone. A
 *   refused room is tried again only after a while, and only on a read.
 * - {@link accept}: a signal for an armed (or arming) watch fires it — once —
 *   and is handed back; anything else is dropped.
 *
 * Arm and cancel requests are gathered briefly and sent one per VTA, member
 * and host, up to {@link ROOMS_KEYS_WATCH_MAX_ROOMS} rooms each.
 */
export class RoomWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(id: string, state: RoomWatchState | undefined) => void>();
  private readonly cancels = new Map<string, RoomWatchKey>();
  private gather: unknown;
  private seq = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly opts: RoomWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Hear every change of a watch's state (`undefined`: no longer held). */
  subscribe(fn: (id: string, state: RoomWatchState | undefined) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  state(key: RoomWatchKey): RoomWatchState | undefined {
    return this.entries.get(roomWatchId(key))?.status;
  }

  /** Hold a watch for a pane showing the room. Nothing is armed until its first read ({@link afterRead}). */
  hold(key: RoomWatchKey): string {
    const id = roomWatchId(key);
    const e = this.entries.get(id);
    if (e) e.holders++;
    else {
      this.entries.set(id, { key, holders: 1, status: { state: "lapsed" }, arming: 0 });
      this.cancels.delete(id);
    }
    return id;
  }

  /** Release a pane's hold; the last release cancels the watch at the VTA. */
  release(key: RoomWatchKey): void {
    const id = roomWatchId(key);
    const e = this.entries.get(id);
    if (!e) return;
    if (--e.holders > 0) return;
    this.entries.delete(id);
    if (e.lapseTimer !== undefined) this.clearTimer(e.lapseTimer);
    // An armed watch is cancelled now; one still being armed is cancelled when
    // its answer says it was armed, so the cancel cannot overtake the arming.
    if (e.status.state === "armed") {
      this.cancels.set(id, key);
      this.schedule();
    }
    this.emit(id, undefined);
  }

  /**
   * The room was read to `sinceVersion` (the highest version read): arm its
   * watch if it has none, its one signal has arrived, it lapsed, or a refusal's
   * wait is over. An armed watch is left as it is.
   */
  afterRead(key: RoomWatchKey, sinceVersion: number | undefined): void {
    const id = roomWatchId(key);
    const e = this.entries.get(id);
    if (!e) return;
    const s = e.status.state;
    if (s === "armed" || s === "arming") return;
    if ((s === "refused" || s === "unavailable") && (e.retryAt ?? 0) > this.now()) return;
    e.queued = sinceVersion !== undefined ? { sinceVersion } : {};
    this.schedule();
  }

  /**
   * A signal from the VTA: the watch it names, when that watch is armed or
   * being armed through `vtaDid` — and then fired, so a second signal for the
   * same arming is dropped. `undefined` for anything else, which the caller
   * drops silently (`rooms/keys/changed/0.1` consumer item 1).
   */
  accept(vtaDid: string, signal: Pick<RoomsKeysChangedPayload, "roomId" | "member" | "host">): RoomWatchKey | undefined {
    const id = roomWatchId({ vtaDid, member: signal.member, host: signal.host, roomId: signal.roomId });
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.status.state !== "armed" && e.status.state !== "arming") return undefined;
    if (e.lapseTimer !== undefined) this.clearTimer(e.lapseTimer);
    delete e.lapseTimer;
    e.arming = ++this.seq; // an answer still in flight for the arming that fired is now stale
    this.set(id, e, { state: "fired" });
    return e.key;
  }

  /** Cancel every watch still held — the surface is going away. */
  releaseAll(): void {
    for (const e of [...this.entries.values()]) {
      e.holders = 1;
      this.release(e.key);
    }
  }

  private emit(id: string, state: RoomWatchState | undefined): void {
    for (const fn of this.listeners) {
      try {
        fn(id, state);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private set(id: string, e: Entry, status: RoomWatchState): void {
    e.status = status;
    this.emit(id, status);
  }

  private schedule(): void {
    if (this.gather !== undefined) return;
    this.gather = this.setTimer(() => {
      this.gather = undefined;
      void this.flush();
    }, this.opts.gatherMs ?? 50);
  }

  private async flush(): Promise<void> {
    const groups = new Map<string, { head: Omit<RoomWatchKey, "roomId">; arms: [string, Entry][]; cancels: RoomWatchKey[] }>();
    const group = (k: RoomWatchKey) => {
      const g = JSON.stringify([k.vtaDid, k.member, k.host]);
      let v = groups.get(g);
      if (!v) groups.set(g, (v = { head: { vtaDid: k.vtaDid, member: k.member, host: k.host }, arms: [], cancels: [] }));
      return v;
    };
    for (const [id, e] of this.entries) {
      if (e.queued === undefined) continue;
      group(e.key).arms.push([id, e]);
    }
    for (const k of this.cancels.values()) group(k).cancels.push(k);
    this.cancels.clear();

    const work: Promise<void>[] = [];
    for (const { head, arms, cancels } of groups.values()) {
      for (let i = 0; i < arms.length; i += ROOMS_KEYS_WATCH_MAX_ROOMS) {
        work.push(this.arm(head, arms.slice(i, i + ROOMS_KEYS_WATCH_MAX_ROOMS)));
      }
      for (let i = 0; i < cancels.length; i += ROOMS_KEYS_WATCH_MAX_ROOMS) {
        const rooms = cancels.slice(i, i + ROOMS_KEYS_WATCH_MAX_ROOMS).map((k) => ({ roomId: k.roomId }));
        // A cancel that fails leaves a watch to lapse at the VTA; its one signal is then dropped here.
        work.push(this.opts.send({ ...head, rooms, cancel: true }).then(() => undefined, () => undefined));
      }
    }
    await Promise.all(work);
  }

  private async arm(head: Omit<RoomWatchKey, "roomId">, batch: [string, Entry][]): Promise<void> {
    const armings = batch.map(([id, e]) => {
      const rooms: RoomWatchRoom = { roomId: e.key.roomId, ...(e.queued?.sinceVersion !== undefined ? { sinceVersion: e.queued.sinceVersion } : {}) };
      delete e.queued;
      e.arming = ++this.seq;
      if (e.lapseTimer !== undefined) this.clearTimer(e.lapseTimer);
      delete e.lapseTimer;
      this.set(id, e, { state: "arming" });
      return { id, e, arming: e.arming, room: rooms };
    });
    const lease = this.opts.leaseSeconds ?? 86_400;
    let outcomes: OutcomeForOneRoom[] | undefined;
    let failure: string | undefined;
    try {
      outcomes = await this.opts.send({ ...head, rooms: armings.map((a) => a.room), leaseSeconds: lease });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const now = this.now();
    armings.forEach(({ id, e, arming }, i) => {
      // Released, fired or re-armed meanwhile: this answer is not the watch's any more.
      if (this.entries.get(id) !== e || e.arming !== arming) {
        // A watch released while arming and now answered as armed is cancelled.
        if (!this.entries.has(id) && outcomes?.[i]?.armed) {
          this.cancels.set(id, e.key);
          this.schedule();
        }
        return;
      }
      const o = outcomes?.[i];
      if (o === undefined) {
        e.retryAt = now + WATCH_RETRY_UNAVAILABLE_MS;
        this.set(id, e, { state: "unavailable", reason: failure ?? "no answer for this room" });
        return;
      }
      if (o.armed) {
        delete e.retryAt;
        this.set(id, e, { state: "armed", ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}) });
        const until = o.expiresAt !== undefined ? Date.parse(o.expiresAt) - now : lease * 1000;
        if (Number.isFinite(until)) {
          e.lapseTimer = this.setTimer(() => {
            delete e.lapseTimer;
            if (this.entries.get(id) === e && e.arming === arming && e.status.state === "armed") this.set(id, e, { state: "lapsed" });
          }, Math.min(MAX_TIMER_MS, Math.max(0, until)));
        }
        return;
      }
      const refused = o.refused ?? "notArmed";
      e.retryAt = now + (refused === "hostUnreachable" ? WATCH_RETRY_UNREACHABLE_MS : WATCH_RETRY_REFUSED_MS);
      this.set(id, e, { state: "refused", refused, ...(o.hostCode !== undefined ? { hostCode: o.hostCode } : {}) });
    });
  }
}

// ── What is unread, after reading ───────────────────────────────────────────

/**
 * The keys of the unread messages in a room the reader has just read
 * (`rooms/changed/0.1`, *What a reader does with a signal*, step 4, for a
 * reader that keeps no copy of the room): a record shown as a message, that is
 *
 * - **new to the reader** — its `createdAt`, else `updatedAt`, after the
 *   reader's own read marker (the host's time, never the author's `writtenAt`,
 *   so a back-dated message still counts);
 * - **not the member's own** — its author is not one of `own`;
 * - **current** — not withdrawn, retracted, expired or refused.
 *
 * Nothing else is unread: a reaction, an edit, a curation, a note, a name or
 * the room's profile is not (step 5). `readMarker` absent counts every message
 * as new; a surface sets one when the member first sees the room.
 */
export function unreadMessages(
  view: RoomRecordsView,
  inputs: readonly Pick<RecordInput, "key" | "createdAt" | "updatedAt">[],
  opts: { readMarker?: number | undefined; own: ReadonlySet<string> },
): string[] {
  const times = new Map(inputs.map((i) => [i.key, i.createdAt ?? i.updatedAt]));
  const out: string[] = [];
  // `records` holds only what is current: expired ones are apart, and a
  // withdrawn, retracted or refused one is shown as such, never as a message.
  for (const v of view.records) {
    if (v.shown !== "message" || v.expired || v.content === undefined) continue;
    if (opts.own.has(v.content.author)) continue;
    if (opts.readMarker !== undefined) {
      const at = Date.parse(times.get(v.key) ?? "");
      if (Number.isNaN(at) || at <= opts.readMarker) continue;
    }
    out.push(v.key);
  }
  return out;
}

/** The latest host time (`createdAt`, else `updatedAt`) of a message in the view: where a read marker moves to once the member has seen them. */
export function latestMessageTime(
  view: RoomRecordsView,
  inputs: readonly Pick<RecordInput, "key" | "createdAt" | "updatedAt">[],
): number | undefined {
  const times = new Map(inputs.map((i) => [i.key, i.createdAt ?? i.updatedAt]));
  let latest: number | undefined;
  for (const v of view.records) {
    if (v.shown !== "message") continue;
    const at = Date.parse(times.get(v.key) ?? "");
    if (!Number.isNaN(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}
