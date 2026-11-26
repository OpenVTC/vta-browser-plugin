// Portals that may use this member's rooms (P7b; VTI `data-rooms-files.md` §8.5).
//
// A share is made in the wallet's own window, when a community's member portal
// asks (`window.vtaWallet.rooms.choose`), and lasts 30 days. This reads every
// live one and revokes any of them; `rooms-communities.tsx` draws each beside
// the room it shares. Revoking stops the page reading the room at once; it
// cannot recall what the page was already shown. A share may carry a reaction
// grant (`reactionsUntil`, at most 30 minutes): listed with its time left and
// stopped on its own, and gone with the share. A room open in a portal tab may
// also hold a session grant ("send without asking while this room is open",
// `room-session-grant.ts`), which lives only in the background's memory: read
// and stopped through `RUNTIME_ROOM_SESSION_GRANTS`.

import { useCallback, useEffect, useState } from "react";

import {
  RUNTIME_ROOM_SESSION_GRANTS,
  type RuntimeRoomSessionGrantsRequest,
  type RuntimeRoomSessionGrantsResponse,
} from "../../bridge-protocol.js";
import { ROOM_GRANTS_PREFIX, withoutReactionGrant, type RoomGrant } from "../../room-page-policy.js";
import type { SessionGrantRow } from "../../room-session-grant.js";

/** One live share, and the storage key it sits under. */
export interface ShareRow {
  key: string;
  grant: RoomGrant;
}

export interface RoomSharesState {
  /** `null` while reading. */
  shares: ShareRow[] | null;
  revoke: (row: ShareRow) => Promise<void>;
  /** Stop the share's reaction grant, keeping the share. */
  stopReactions: (row: ShareRow) => Promise<void>;
  /** The live "while this room is open" grants. */
  sessions: SessionGrantRow[];
  /** Stop one, keeping the share. */
  stopSession: (id: string) => Promise<void>;
}

/** The session grants, or none outside the extension or when the background does not answer. */
async function sessionGrants(params: RuntimeRoomSessionGrantsRequest["params"]): Promise<SessionGrantRow[]> {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) return [];
  try {
    const res = (await runtime.sendMessage({ type: RUNTIME_ROOM_SESSION_GRANTS, params } satisfies RuntimeRoomSessionGrantsRequest)) as
      | RuntimeRoomSessionGrantsResponse
      | undefined;
    return res?.ok ? res.result : [];
  } catch {
    return [];
  }
}

/** The session grant riding on `grant`'s share, if one is live. */
export function sessionFor(sessions: readonly SessionGrantRow[], grant: RoomGrant): SessionGrantRow | undefined {
  return sessions.find(
    (r) =>
      r.origin === grant.origin &&
      r.hostDid === grant.hostDid &&
      r.vtaDid === grant.vtaDid &&
      r.roomId === grant.roomId &&
      r.member === grant.member,
  );
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
  const [sessions, setSessions] = useState<SessionGrantRow[]>([]);

  const load = useCallback(async () => {
    setShares(await readLive(Date.now()).catch(() => []));
    setSessions(await sessionGrants({ op: "list" }));
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

  const stopReactions = useCallback(
    async ({ key, grant }: ShareRow) => {
      const current = (await chrome.storage.local.get(key))[key];
      const next = withoutReactionGrant(Array.isArray(current) ? (current as RoomGrant[]) : [], grant, grant.roomId);
      await chrome.storage.local.set({ [key]: next });
      await load();
    },
    [load],
  );

  const stopSession = useCallback(
    async (id: string) => {
      setSessions(await sessionGrants({ op: "stop", id }));
      await load();
    },
    [load],
  );

  return { shares, revoke, stopReactions, sessions, stopSession };
}
