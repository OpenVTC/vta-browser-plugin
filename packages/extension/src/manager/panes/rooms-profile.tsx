// A room's own profile, as the console shows it — its name and what it is for,
// read by this wallet's agent from inside the room (`rooms/keys/profile/read`).
//
// The profile is free text another member wrote, so it is rendered as text
// nodes only (`roomProfileView` has already stripped control characters), and
// the two things a member must be told are said in words: a rename by somebody
// without the standing to was refused, and a profile that predates the room's
// latest change of keys may be out of date.

import { useEffect, useState } from "react";
import {
  roomProfileNotices,
  roomProfileView,
  roomsKeysProfileRead,
  type RoomProfileView,
} from "@openvtc/pnm-core/rooms";
import { c, t } from "../../theme.js";
import { managerSender } from "../sender.js";
import type { Parties } from "../use-vta.js";

/**
 * The name a room row shows, best first: the member's own label (`personal`,
 * where the wallet has one), the room's own profile name, the community's offer
 * label, else none — the row then shows the DID.
 */
export function roomDisplayName(names: {
  personal?: string | undefined;
  profile?: RoomProfileView | undefined;
  community?: string | undefined;
}): { name: string; source: "personal" | "profile" | "community" } | undefined {
  if (names.personal) return { name: names.personal, source: "personal" };
  if (names.profile?.name) return { name: names.profile.name, source: "profile" };
  if (names.community) return { name: names.community, source: "community" };
  return undefined;
}

/** Read `rooms`' profiles from their known hosts, once per change of the list. */
export function useRoomProfiles(
  parties: Parties,
  rooms: readonly { roomId: string; member?: string | undefined }[] | null,
  hosts: Readonly<Record<string, string>>,
): Record<string, RoomProfileView> {
  const [profiles, setProfiles] = useState<Record<string, RoomProfileView>>({});
  // What to read, as one value: the list and the hosts arrive separately and
  // are re-set whole, and a re-render with the same rooms must not read again.
  const want = JSON.stringify(
    (rooms ?? [])
      .filter((r) => hosts[r.roomId] !== undefined)
      .map((r) => ({ roomId: r.roomId, host: hosts[r.roomId]!, member: r.member })),
  );
  useEffect(() => {
    let live = true;
    const wanted = JSON.parse(want) as { roomId: string; host: string; member?: string }[];
    void (async () => {
      const out: Record<string, RoomProfileView> = {};
      for (const r of wanted) {
        if (out[r.roomId]) continue;
        try {
          const res = await roomsKeysProfileRead(managerSender, {
            ...parties,
            roomId: r.roomId,
            host: r.host,
            ...(r.member !== undefined ? { member: r.member } : {}),
          });
          out[r.roomId] = roomProfileView(res);
        } catch {
          // An agent that does not serve the task, or a room it cannot read:
          // the row keeps the community's name, or its DID.
        }
      }
      if (live) setProfiles(out);
    })();
    return () => {
      live = false;
    };
  }, [parties, want]);
  return profiles;
}

/** A profile's description and notices, under a room's name. Text only. */
export function RoomProfileDetails({ view }: { view: RoomProfileView | undefined }) {
  if (!view) return null;
  const notices = roomProfileNotices(view);
  if (!view.description && !view.tags && notices.length === 0) return null;
  return (
    <span style={{ display: "grid", gap: 2 }}>
      {view.description && (
        <span style={{ fontSize: t.xs, color: c.muted, whiteSpace: "pre-wrap" }}>{view.description}</span>
      )}
      {view.tags && <span style={{ fontSize: t.xs, color: c.muted }}>{view.tags.join(" · ")}</span>}
      {notices.map((n) => (
        <span key={n} role="note" style={{ fontSize: t.xs, color: c.warn }}>
          {n}
        </span>
      ))}
    </span>
  );
}

/** One room's profile, read from `host` — for a row whose host the member just named. */
export function RoomProfileAt({
  parties,
  roomId,
  member,
  host,
}: {
  parties: Parties;
  roomId: string;
  member?: string | undefined;
  host: string;
}) {
  const [view, setView] = useState<RoomProfileView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    roomsKeysProfileRead(managerSender, { ...parties, roomId, host, ...(member !== undefined ? { member } : {}) })
      .then((res) => live && setView(roomProfileView(res)))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [parties, roomId, member, host]);
  if (view === undefined || view === null) return null;
  return (
    <div style={{ margin: "6px 0", fontSize: t.sm }}>
      {view.name ? (
        <strong>
          {view.emoji ? `${view.emoji} ` : ""}
          {view.name}
        </strong>
      ) : view.status === "absent" ? (
        <span style={{ color: c.muted }}>This room has not given itself a name you can read.</span>
      ) : null}
      <RoomProfileDetails view={view} />
    </div>
  );
}
