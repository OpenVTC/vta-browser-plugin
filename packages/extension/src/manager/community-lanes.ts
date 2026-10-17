// One community, end to end: what it offered, what became a room this agent
// holds, and what its portal may see.
//
// Offers and portal shares were two lists on two tabs, and they describe one
// relationship from either end — a community offers a room, the member joins
// it, and the community's portal asks to show it. Drawn apart, nothing says
// that the share on one tab is of the room accepted on the other. This model
// joins them by community and by room, so the view can draw each room's path
// across one lane.
//
// The three columns are three different sources and must not be read as one:
// an offer is the community's word, a held room is the agent's key custody, a
// share is this wallet's own grant. A row can have any of them without the
// others — accepted but no keys yet (the Welcome has not arrived), held but
// never offered here (the room was created by the member), shared and since
// left — and each gap is a state worth seeing rather than a fault.

import type { OffersCommunityView } from "../bridge-protocol.js";
import { isActionable, type OfferView } from "../room-offers-policy.js";
import type { ShareRow } from "./panes/rooms-shares.js";
import type { RoomEntry } from "./room-groups.js";
import type { KnownRoomHost } from "./room-hosts.js";

export interface LaneRow {
  roomId: string;
  /** The community's name for the room, from its offer. */
  label?: string;
  /** This community's offers of the room, one per identity it was offered to. */
  offers: OfferView[];
  /** The places this agent holds in the room, if any. */
  held?: RoomEntry;
  /** Live shares of the room with this community's portal. */
  shares: ShareRow[];
}

export interface Lane {
  communityDid: string;
  /** The offers reading for this community, where it was asked. */
  offers?: OffersCommunityView;
  /** The portal origins this wallet has shared rooms with, for this community. */
  portals: string[];
  rows: LaneRow[];
}

/** Where one row has got to, read left to right. */
export type RowStage = "offered" | "awaiting-keys" | "held" | "shared";

export function rowStage(row: LaneRow): RowStage {
  if (row.shares.length > 0 && row.held) return "shared";
  if (row.held) return "held";
  if (row.offers.some((o) => o.state === "accepted" && !o.inProgress)) return "awaiting-keys";
  return "offered";
}

const actionable = (row: LaneRow) => row.offers.some(isActionable);

/**
 * The lanes, communities with something to act on first.
 *
 * Shares are this agent's only (`vtaDid`): the console is one agent's, and a
 * share made through another agent is about rooms it does not hold. A held room
 * joins a lane when it was offered or shared there, or when the wallet last
 * found it at that community.
 */
export function communityLanes({
  communities,
  shares,
  entries,
  hosts,
  agentDid,
}: {
  communities: readonly OffersCommunityView[];
  shares: readonly ShareRow[];
  entries: readonly RoomEntry[];
  hosts: Readonly<Record<string, KnownRoomHost>>;
  agentDid: string;
}): Lane[] {
  const lanes = new Map<string, Lane>();
  const lane = (did: string): Lane => {
    let l = lanes.get(did);
    if (!l) {
      l = { communityDid: did, portals: [], rows: [] };
      lanes.set(did, l);
    }
    return l;
  };
  const row = (l: Lane, roomId: string): LaneRow => {
    let r = l.rows.find((x) => x.roomId === roomId);
    if (!r) {
      r = { roomId, offers: [], shares: [] };
      l.rows.push(r);
    }
    return r;
  };

  for (const cv of communities) {
    const l = lane(cv.communityDid);
    l.offers = cv;
    for (const m of cv.members) {
      for (const o of m.offers) {
        const r = row(l, o.roomId);
        r.offers.push(o);
        if (o.label && r.label === undefined) r.label = o.label;
      }
    }
  }
  for (const s of shares) {
    if (s.grant.vtaDid !== agentDid) continue;
    const l = lane(s.grant.hostDid);
    if (!l.portals.includes(s.grant.origin)) l.portals.push(s.grant.origin);
    row(l, s.grant.roomId).shares.push(s);
  }
  for (const [roomId, h] of Object.entries(hosts)) {
    if (h.source === "community" && entries.some((e) => e.roomId === roomId)) row(lane(h.host), roomId);
  }
  for (const l of lanes.values()) {
    for (const r of l.rows) {
      const held = entries.find((e) => e.roomId === r.roomId);
      if (held) r.held = held;
    }
    l.rows.sort(
      (a, b) =>
        Number(actionable(b)) - Number(actionable(a)) ||
        Number(!!b.held) - Number(!!a.held) ||
        (a.label ?? a.roomId).localeCompare(b.label ?? b.roomId),
    );
  }
  return [...lanes.values()].sort(
    (a, b) =>
      Number(b.rows.some(actionable)) - Number(a.rows.some(actionable)) || a.communityDid.localeCompare(b.communityDid),
  );
}
