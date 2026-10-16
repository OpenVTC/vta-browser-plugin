// Portals that may use this member's rooms (P7b; VTI `data-rooms-files.md` §8.5).
//
// A share is made in the wallet's own window, when a community's member portal
// asks (`window.vtaWallet.rooms.choose`), and lasts 30 days. This lists every
// live one and revokes any of them. Revoking stops the page reading the room at
// once; it cannot recall what the page was already shown.

import { useCallback, useEffect, useState } from "react";

import { ROOM_GRANTS_PREFIX, rememberedRoomLabels, type RoomGrant } from "../../room-page-policy.js";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";

async function readAll(): Promise<{ key: string; grants: RoomGrant[]; all: Record<string, unknown> }[]> {
  // Absent outside the extension (the pane's render tests): no shares to show.
  const store = globalThis.chrome?.storage?.local;
  if (!store) return [];
  const all = await store.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith(ROOM_GRANTS_PREFIX) && Array.isArray(v))
    .map(([key, v]) => ({ key, grants: v as RoomGrant[], all }));
}

export function RoomShares() {
  const [rows, setRows] = useState<{ key: string; grant: RoomGrant; label?: string }[] | null>(null);

  const load = useCallback(async () => {
    const now = Date.now();
    setRows(
      (await readAll()).flatMap(({ key, grants, all }) =>
        grants
          .filter((g) => g.expiresAt > now)
          .map((grant) => {
            // The name the room's community gave it, when it owns the room.
            const label = rememberedRoomLabels(all, grant.vtaDid)[grant.roomId];
            return { key, grant, ...(label !== undefined ? { label } : {}) };
          }),
      ),
    );
  }, []);

  useEffect(() => {
    load().catch(() => setRows([]));
  }, [load]);

  const revoke = async (key: string, grant: RoomGrant) => {
    const current = (await chrome.storage.local.get(key))[key];
    const next = (Array.isArray(current) ? (current as RoomGrant[]) : []).filter(
      (g) => !(g.origin === grant.origin && g.hostDid === grant.hostDid && g.roomId === grant.roomId),
    );
    if (next.length === 0) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: next });
    await load();
  };

  return (
    <Panel
      title="Rooms shared with portals"
      description="Community portals you let read these rooms. Each addition they ask for is still shown to you
        first."
    >
      {rows === null ? null : rows.length === 0 ? (
        <Note>No portal can use your rooms.</Note>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map(({ key, grant, label }) => (
            <div
              key={`${key}|${grant.hostDid}|${grant.roomId}`}
              style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}
            >
              <div style={{ display: "grid", gap: 2, fontSize: t.sm }}>
                <span>{grant.origin}</span>
                {label !== undefined && <span>{label}</span>}
                <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all", color: c.muted }}>
                  {grant.roomId}
                </code>
                <span style={{ fontSize: t.xs, color: c.muted, wordBreak: "break-all" }}>
                  {typeof grant.member === "string"
                    ? `as ${grant.member} · `
                    : "shared before shares named an identity: the portal will ask again · "}
                  until {new Date(grant.expiresAt).toLocaleDateString()}
                </span>
              </div>
              <Button onClick={() => void revoke(key, grant)}>Revoke</Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
