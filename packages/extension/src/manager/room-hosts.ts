// Where this wallet last found each room — a hint, never an answer.
//
// The agent deliberately keeps no host for a room: a room is a DID, it can
// move hosts without anything the agent holds changing, and it may have more
// than one. So nothing *authoritative* maps a room to its host, and the rooms
// pane used to ask for the host DID every time, twice per room (records and
// history each had their own empty field).
//
// What the wallet can honestly keep is what it has itself seen:
//
// - **`community`** — a community's offer named the room, so the community is
//   where it is served (`room-names:`, written by the portal and offers flows).
// - **`created`** — this console registered the room with that host.
// - **`used`** — a host the member named answered a listing for the room.
//
// Each is shown as where the room was *last found*, with a way to change it,
// and every request still goes through the agent, which checks what the host
// says. A wrong hint costs one refused listing; it grants nothing.
//
// The console's own record outranks an offer's: it is newer evidence, from a
// host that actually answered for this member.

import { rememberedRoomHosts } from "../room-page-policy.js";

export const ROOM_HOSTS_PREFIX = "room-hosts:";

/** How many rooms one VTA's record keeps. */
export const ROOM_HOSTS_MAX = 500;

export type RoomHostSource = "community" | "created" | "used";

export interface KnownRoomHost {
  host: string;
  source: RoomHostSource;
}

interface StoredRoomHost {
  host: string;
  source: "created" | "used";
  seenAt: number;
}

/** The storage key holding one VTA's remembered hosts. */
export function roomHostsKey(vtaDid: string): string {
  return `${ROOM_HOSTS_PREFIX}${vtaDid}`;
}

/** A stored record, keeping only entries this wallet could have written. */
function readStored(value: unknown): Record<string, StoredRoomHost> {
  const out: Record<string, StoredRoomHost> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [roomId, v] of Object.entries(value as Record<string, unknown>)) {
    const r = v as Partial<StoredRoomHost> | null;
    if (!r || typeof r.host !== "string" || !r.host.startsWith("did:")) continue;
    if (r.source !== "created" && r.source !== "used") continue;
    if (typeof r.seenAt !== "number") continue;
    out[roomId] = { host: r.host, source: r.source, seenAt: r.seenAt };
  }
  return out;
}

/** `stored` with `roomId` → `host` set, the oldest dropped past {@link ROOM_HOSTS_MAX}. */
export function withRoomHost(
  stored: unknown,
  roomId: string,
  host: string,
  source: "created" | "used",
  now: number,
): Record<string, StoredRoomHost> {
  const out = readStored(stored);
  out[roomId] = { host, source, seenAt: now };
  const entries = Object.entries(out);
  if (entries.length <= ROOM_HOSTS_MAX) return out;
  return Object.fromEntries(entries.sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, ROOM_HOSTS_MAX));
}

/**
 * Every room's last-known host under `vtaDid`, from a whole
 * `chrome.storage.local` read: the console's own record first, then a
 * community's offer.
 */
export function knownRoomHosts(all: Readonly<Record<string, unknown>>, vtaDid: string): Record<string, KnownRoomHost> {
  const out: Record<string, KnownRoomHost> = {};
  for (const [roomId, host] of Object.entries(rememberedRoomHosts(all, vtaDid))) {
    out[roomId] = { host, source: "community" };
  }
  for (const [roomId, r] of Object.entries(readStored(all[roomHostsKey(vtaDid)]))) {
    out[roomId] = { host: r.host, source: r.source };
  }
  return out;
}

/**
 * Remember that `host` served `roomId`. Best effort: a page outside the
 * extension (the render tests), or storage that refuses, leaves the hint
 * unwritten and the room asks again next time.
 */
export async function rememberRoomHost(
  vtaDid: string,
  roomId: string,
  host: string,
  source: "created" | "used",
): Promise<void> {
  const store = globalThis.chrome?.storage?.local;
  if (!store?.set) return;
  const key = roomHostsKey(vtaDid);
  try {
    const got = await store.get(key);
    await store.set({ [key]: withRoomHost(got?.[key], roomId, host, source, Date.now()) });
  } catch {
    // A hint, not a record: nothing depends on it having been written.
  }
}
