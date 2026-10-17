// Portals that may use this member's rooms (P7b; VTI `data-rooms-files.md` §8.5).
//
// A share is made in the wallet's own window, when a community's member portal
// asks (`window.vtaWallet.rooms.choose`), and lasts 30 days. This reads every
// live one and revokes any of them; `rooms-communities.tsx` draws each beside
// the room it shares. Revoking stops the page reading the room at once; it
// cannot recall what the page was already shown.

import { useCallback, useEffect, useState } from "react";

import { ROOM_GRANTS_PREFIX, type RoomGrant } from "../../room-page-policy.js";

/** One live share, and the storage key it sits under. */
export interface ShareRow {
  key: string;
  grant: RoomGrant;
}

export interface RoomSharesState {
  /** `null` while reading. */
  shares: ShareRow[] | null;
  revoke: (row: ShareRow) => Promise<void>;
}

async function readLive(now: number): Promise<ShareRow[]> {
  // Absent outside the extension (the pane's render tests): no shares to show.
  const store = globalThis.chrome?.storage?.local;
  if (!store) return [];
  const all = await store.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith(ROOM_GRANTS_PREFIX) && Array.isArray(v))
    .flatMap(([key, v]) => (v as RoomGrant[]).filter((g) => g.expiresAt > now).map((grant) => ({ key, grant })));
}

export function useRoomShares(): RoomSharesState {
  const [shares, setShares] = useState<ShareRow[] | null>(null);

  const load = useCallback(async () => {
    setShares(await readLive(Date.now()).catch(() => []));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async ({ key, grant }: ShareRow) => {
      const current = (await chrome.storage.local.get(key))[key];
      const next = (Array.isArray(current) ? (current as RoomGrant[]) : []).filter(
        (g) => !(g.origin === grant.origin && g.hostDid === grant.hostDid && g.roomId === grant.roomId),
      );
      if (next.length === 0) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({ [key]: next });
      await load();
    },
    [load],
  );

  return { shares, revoke };
}
