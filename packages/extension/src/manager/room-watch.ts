/// <reference types="chrome" />

// Watching the console's open rooms through the member's own VTA
// (`rooms/keys/watch/0.1`, `rooms/keys/changed/0.1`; trust-tasks-tf #1040).
//
// One `RoomWatcher` per console page. Each open room pane holds the watch for
// its room, member and host while it is mounted, re-arms it after every read
// and releases it — which cancels it at the VTA — when it closes. Requests are
// gathered and sent one per VTA, member and host (up to 64 rooms each).
//
// The signal arrives where every unasked document from the VTA arrives: on the
// offscreen document's mediator session, which checks that the transport proved
// the sender to be the VTA and that the payload is the schema's, then hands it
// here (`RUNTIME_ROOMS_KEYS_CHANGED`). This page takes it only from the
// offscreen document, and only for a watch it armed: anything else is dropped
// silently. A signal is a reason to read the room and nothing else.

import {
  RoomWatcher,
  roomsKeysWatch,
  roomWatchId,
  type RoomWatchKey,
  type RoomWatchState,
} from "@openvtc/pnm-core/rooms";
import {
  RUNTIME_NOTIFY,
  RUNTIME_ROOMS_KEYS_CHANGED,
  type RuntimeNotifyRequest,
  type RuntimeRoomsKeysChanged,
} from "../bridge-protocol.js";
import { managerSender } from "./sender.js";
import type { Parties } from "./use-vta.js";

/** How often a room is read again while no watch covers it: the fallback. */
export const POLL_UNWATCHED_MS = 60_000;
/** How often while a watch is armed — a safety net for a signal the delivery layer lost. */
export const POLL_WATCHED_MS = 10 * 60_000;

/** Node keeps a process alive for a pending timer; a browser returns a number. Neither may hold a test open. */
export function unrefTimer<T>(t: T): T {
  (t as { unref?: () => void } | undefined)?.unref?.();
  return t;
}

const parties = new Map<string, Parties>();
const signalled = new Map<string, Set<(latestVersion: number) => void>>();

export const consoleRoomWatcher = new RoomWatcher({
  send: (batch) => {
    const p = parties.get(batch.vtaDid);
    if (!p) return Promise.reject(new Error("no parties for this agent"));
    return roomsKeysWatch(managerSender, {
      holder: p.holder,
      service: p.service,
      member: batch.member,
      host: batch.host,
      rooms: batch.rooms,
      ...(batch.leaseSeconds !== undefined ? { leaseSeconds: batch.leaseSeconds } : {}),
      ...(batch.cancel ? { cancel: true as const } : {}),
    });
  },
  setTimer: (fn, ms) => unrefTimer(setTimeout(fn, ms)),
});

/** Whether `sender` is this extension's offscreen document — never a content script, which carries the extension's id too. */
export function fromOffscreen(sender: { id?: string; url?: string; tab?: unknown } | undefined, base: string): boolean {
  return !!sender && sender.tab === undefined && sender.url === `${base}offscreen.html`;
}

/**
 * Hand a signal to the pane that armed its watch. Answers whether it was taken;
 * a signal for a watch this page did not arm, or one already fired, is dropped.
 */
export function deliverRoomSignal(vtaDid: string, signal: RuntimeRoomsKeysChanged["signal"]): boolean {
  const key = consoleRoomWatcher.accept(vtaDid, signal);
  if (!key) return false;
  for (const fn of signalled.get(roomWatchId(key)) ?? []) fn(signal.latestVersion);
  return true;
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  try {
    const base = chrome.runtime.getURL("");
    chrome.runtime.onMessage?.addListener((message: unknown, sender) => {
      const m = message as Partial<RuntimeRoomsKeysChanged> | undefined;
      if (m?.type !== RUNTIME_ROOMS_KEYS_CHANGED || typeof m.vtaDid !== "string" || !m.signal) return false;
      if (!fromOffscreen(sender, base)) return false;
      deliverRoomSignal(m.vtaDid, m.signal);
      return false;
    });
    // Best effort: a closing console cancels what it armed. A cancel that does
    // not go leaves the watch to lapse at the VTA, and its one signal is dropped.
    globalThis.addEventListener?.("pagehide", () => consoleRoomWatcher.releaseAll());
  } catch {
    // No extension runtime (a test without one): nothing arrives, and the panes poll.
  }
}

/** A pane's hold on one watch. */
export interface RoomWatchHold {
  key: RoomWatchKey;
  /** Tell the watcher the room was read to `version`: it re-arms when the watch has fired or lapsed. */
  afterRead: (version: number | undefined) => void;
  state: () => RoomWatchState | undefined;
  /** Hear this watch's state change. */
  onState: (fn: (s: RoomWatchState | undefined) => void) => () => void;
  release: () => void;
}

/**
 * Hold the watch on a room for an open pane. `onSignal` hears the room's
 * signal (its `latestVersion`, only a reason to read). Release on close.
 */
export function holdRoomWatch(p: Parties, key: Omit<RoomWatchKey, "vtaDid">, onSignal: (latestVersion: number) => void): RoomWatchHold {
  listen();
  const full: RoomWatchKey = { vtaDid: p.service.did, ...key };
  parties.set(full.vtaDid, p);
  const id = consoleRoomWatcher.hold(full);
  const set = signalled.get(id) ?? new Set();
  set.add(onSignal);
  signalled.set(id, set);
  let released = false;
  return {
    key: full,
    afterRead: (version) => {
      if (!released) consoleRoomWatcher.afterRead(full, version);
    },
    state: () => consoleRoomWatcher.state(full),
    onState: (fn) =>
      consoleRoomWatcher.subscribe((changed, s) => {
        if (changed === id) fn(s);
      }),
    release: () => {
      if (released) return;
      released = true;
      set.delete(onSignal);
      if (set.size === 0) signalled.delete(id);
      consoleRoomWatcher.release(full);
    },
  };
}

/**
 * The words of the one notification a room raises: that there are new
 * messages, and nothing of them — no room, no author, no text. An operating
 * system's notification centre keeps and shows what it is given, to anyone at
 * the screen; the member reads the messages in the console.
 */
export const UNREAD_NOTIFICATION: Readonly<{ title: string; message: string }> = Object.freeze({
  title: "New messages",
  message: "A room open in your wallet has new messages.",
});

/** Raise it. Only after reading found an unread message (`rooms/changed/0.1`, step 6), never on a signal alone. */
export function notifyUnread(): void {
  try {
    void chrome.runtime
      .sendMessage({ type: RUNTIME_NOTIFY, ...UNREAD_NOTIFICATION } satisfies RuntimeNotifyRequest)
      .catch(() => undefined);
  } catch {
    // No runtime: nobody to tell.
  }
}

// ── The read marker ─────────────────────────────────────────────────────────

/**
 * Where the member has seen a room's conversation up to: the host's time of the
 * latest message shown to them (`rooms/changed/0.1`, *What a reader does with a
 * signal*, step 4). The member's own, kept in this browser and sent nowhere.
 */
export function readMarkerKey(vtaDid: string, member: string, roomId: string): string {
  return `room-read:${vtaDid}|${member}|${roomId}`;
}

export async function getReadMarker(key: string): Promise<number | undefined> {
  try {
    const got = (await chrome.storage?.local?.get(key)) as Record<string, unknown> | undefined;
    const v = got?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function setReadMarker(key: string, at: number): Promise<void> {
  try {
    await chrome.storage?.local?.set({ [key]: at });
  } catch {
    // A marker that is not kept costs a member one repeated alert, nothing more.
  }
}
