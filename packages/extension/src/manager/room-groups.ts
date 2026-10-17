// The rooms pane's model: rooms as cards, cards in groups.
//
// `rooms/keys/list` answers once per (room, member). The pane draws one card
// per **room** and lists the places held in it inside the card, because two
// identical-looking rows for one room read as a fault. The place is not lost:
// every action from a card's detail acts as a place chosen on screen, and the
// key that identifies it is still `heldRoomKey`.
//
// Groups are by where the room was last found (`room-hosts.ts`) or by trust
// context. The context grouping is the one that needs no hint at all; a room
// whose places sit in two contexts appears under each, holding only that
// context's place.

import type { HeldRoom } from "@openvtc/pnm-core/rooms";
import type { KnownRoomHost } from "./room-hosts.js";

/** One room, and every place this agent holds in it. */
export interface RoomEntry {
  roomId: string;
  places: HeldRoom[];
}

export type GroupBy = "host" | "context";

export type RoomGroup =
  | { kind: "host"; key: string; host: KnownRoomHost; entries: RoomEntry[] }
  | { kind: "unknown"; key: string; entries: RoomEntry[] }
  | { kind: "context"; key: string; context: string | undefined; entries: RoomEntry[] };

/** The listing as one entry per room, in the order the agent listed them. */
export function roomEntries(rooms: readonly HeldRoom[]): RoomEntry[] {
  const out: RoomEntry[] = [];
  const at = new Map<string, RoomEntry>();
  for (const r of rooms) {
    const had = at.get(r.roomId);
    if (had) had.places.push(r);
    else {
      const e = { roomId: r.roomId, places: [r] };
      at.set(r.roomId, e);
      out.push(e);
    }
  }
  return out;
}

/** The place that reads furthest back — what a card's one history chip reports. */
export function mostReadable(entry: RoomEntry): HeldRoom {
  return entry.places.reduce((a, b) => (b.earliestReadableEpoch < a.earliestReadableEpoch ? b : a));
}

/**
 * Entries grouped. By host: one group per last-known host, in the order the
 * agent listed their first room, then the rooms with none. By context: one per
 * context, rooms whose agent did not report one last.
 */
export function groupRooms(
  entries: readonly RoomEntry[],
  hosts: Readonly<Record<string, KnownRoomHost>>,
  by: GroupBy,
): RoomGroup[] {
  if (by === "host") {
    const groups = new Map<string, { kind: "host"; key: string; host: KnownRoomHost; entries: RoomEntry[] }>();
    const unknown: RoomEntry[] = [];
    for (const e of entries) {
      const h = hosts[e.roomId];
      if (!h) {
        unknown.push(e);
        continue;
      }
      const g = groups.get(h.host);
      if (g) {
        g.entries.push(e);
        // A host is a community's if any room under it came from that
        // community's offer: that is the name a member knows it by.
        if (h.source === "community") g.host = h;
      } else groups.set(h.host, { kind: "host", key: `host:${h.host}`, host: h, entries: [e] });
    }
    const out: RoomGroup[] = [...groups.values()];
    if (unknown.length > 0) out.push({ kind: "unknown", key: "unknown", entries: unknown });
    return out;
  }
  const groups = new Map<string, { kind: "context"; key: string; context: string | undefined; entries: RoomEntry[] }>();
  let unreported: RoomEntry[] = [];
  for (const e of entries) {
    const byContext = new Map<string | undefined, HeldRoom[]>();
    for (const p of e.places) byContext.set(p.context, [...(byContext.get(p.context) ?? []), p]);
    for (const [context, places] of byContext) {
      const part = { roomId: e.roomId, places };
      if (context === undefined) {
        unreported = [...unreported, part];
        continue;
      }
      const g = groups.get(context);
      if (g) g.entries.push(part);
      else groups.set(context, { kind: "context", key: `context:${context}`, context, entries: [part] });
    }
  }
  const out: RoomGroup[] = [...groups.values()];
  if (unreported.length > 0) {
    out.push({ kind: "context", key: "context:", context: undefined, entries: unreported });
  }
  return out;
}
