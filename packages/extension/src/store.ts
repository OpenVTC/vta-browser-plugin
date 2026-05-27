/// <reference types="chrome" />
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** A VTA the wallet has been authorized at via the onboarding swap. Populated
 *  by the popup's onboarding flow on successful `swap-acl`. */
export interface Connection {
  /** The VTA's DID (did:webvh:…). */
  vtaDid: string;
  /** The wallet's holder did:peer — the new DID the swap landed on. */
  holderDid: string;
  /** Role inherited from the operator-granted ephemeral (typically `admin`). */
  role: string;
  /** REST base URL from `#vta-rest`, if advertised at onboarding time. */
  restBaseUrl?: string;
  /** Mediator DID from `#vta-didcomm`, if advertised at onboarding time. */
  mediatorDid?: string;
  /** When the connection was established (ms epoch). */
  connectedAt: number;
}

/** Multi-VTA connection state.
 *
 *  `vtas` is a dict keyed by `vtaDid` containing every VTA the wallet
 *  has onboarded at and is still remembered locally. `activeVtaDid`
 *  points at the entry the popup is currently operating against (or
 *  `null` when the operator has disconnected — entries are kept in
 *  `vtas` for quick re-activation, only `forgetVta` actually removes
 *  them). */
export interface MultiVtaConnections {
  activeVtaDid: string | null;
  vtas: { [vtaDid: string]: Connection };
}

interface State {
  connections: MultiVtaConnections;
  /** Insert/update the entry for `c.vtaDid` AND set it as the active
   *  VTA. The path the OnboardView's `finalizeConnection` takes after
   *  a successful onboard. */
  setConnection: (c: Connection) => void;
  /** Clear `activeVtaDid` without removing the entry from `vtas`. The
   *  Disconnect button's behaviour — operator can re-activate the
   *  same VTA from the (future) dropdown without re-onboarding. */
  clearConnection: () => void;
  /** Remove the entry for `vtaDid` entirely (and clear `activeVtaDid`
   *  if it was pointing at this one). PR 2 wires this to a "Forget
   *  VTA" UI; for now it's available for tests + direct callers. */
  forgetVta: (vtaDid: string) => void;
  /** Set the active VTA to an existing entry. The (future) dropdown's
   *  switch-VTA action. */
  activateVta: (vtaDid: string) => void;
}

/**
 * MV3 doesn't expose `localStorage` to the popup the same way a tab
 * does — and we want state to survive the popup closing. Use
 * `chrome.storage.local` via a small adapter. (The popup has
 * `chrome.storage` access; the offscreen document does not.)
 */
const chromeStorage = {
  getItem: (key: string): Promise<string | null> =>
    new Promise((resolve) => {
      chrome.storage.local.get(key, (items) => resolve(items[key] ?? null));
    }),
  setItem: (key: string, value: string): Promise<void> =>
    new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    }),
  removeItem: (key: string): Promise<void> =>
    new Promise((resolve) => {
      chrome.storage.local.remove(key, () => resolve());
    }),
};

export const useConnectionStore = create<State>()(
  persist(
    (set) => ({
      connections: { activeVtaDid: null, vtas: {} },
      setConnection: (c) =>
        set((state) => ({
          connections: {
            activeVtaDid: c.vtaDid,
            vtas: { ...state.connections.vtas, [c.vtaDid]: c },
          },
        })),
      clearConnection: () =>
        set((state) => ({
          connections: { activeVtaDid: null, vtas: state.connections.vtas },
        })),
      forgetVta: (vtaDid) =>
        set((state) => {
          const { [vtaDid]: _removed, ...rest } = state.connections.vtas;
          let nextActive: string | null = state.connections.activeVtaDid;
          if (state.connections.activeVtaDid === vtaDid) {
            // Auto-promote a remaining VTA to active so the operator
            // doesn't get dumped into OnboardView when they still have
            // other onboarded VTAs. The chosen-next isn't deterministic
            // by design (Object.keys order is insertion-ordered in
            // modern engines, so this picks "an arbitrary other VTA").
            // The operator can switch again from the dropdown.
            const remaining = Object.keys(rest);
            nextActive = remaining[0] ?? null;
          }
          return {
            connections: {
              activeVtaDid: nextActive,
              vtas: rest,
            },
          };
        }),
      activateVta: (vtaDid) =>
        set((state) =>
          state.connections.vtas[vtaDid]
            ? { connections: { ...state.connections, activeVtaDid: vtaDid } }
            : state,
        ),
    }),
    {
      // v3: multi-VTA shape `{ activeVtaDid, vtas }`. Migrated from v2's
      // single-Connection slot by the migrate function below — the user's
      // one existing connection becomes `vtas[vtaDid]` with `activeVtaDid`
      // set to it. v2 records that don't carry a `vtaDid` (pre-M2C) are
      // dropped; the operator re-onboards.
      name: "pnm-connection/v3",
      storage: createJSONStorage(() => chromeStorage),
      version: 3,
      migrate: (persisted: unknown, version: number) => {
        // v3 → v3: nothing to do (already the right shape).
        if (version === 3) return persisted as { connections: MultiVtaConnections };

        // v0..v2: persisted as `{ connection: Connection | null }`. Move
        // the single connection (if any) into `vtas` and set it active.
        const legacy = persisted as { connection?: Connection } | undefined;
        const single = legacy?.connection;
        if (single && typeof single.vtaDid === "string") {
          return {
            connections: {
              activeVtaDid: single.vtaDid,
              vtas: { [single.vtaDid]: single },
            },
          };
        }
        return { connections: { activeVtaDid: null, vtas: {} } };
      },
      // Only the connections map needs to round-trip — the action
      // closures (setConnection, etc.) are rebuilt at hydration time.
      partialize: (state) => ({ connections: state.connections }) as unknown as State,
    },
  ),
);

/** The active VTA's Connection, or `null` if no VTA is active. */
export function useActiveConnection(): Connection | null {
  return useConnectionStore((s) => {
    const { activeVtaDid, vtas } = s.connections;
    if (activeVtaDid === null) return null;
    return vtas[activeVtaDid] ?? null;
  });
}

/** Lock state for the wallet's AES-cache (encrypted-at-rest wallets
 *  only). Deliberately NOT persisted: the offscreen cache is in-
 *  memory and clears on browser restart / SW eviction / manual lock,
 *  so persisting "unlocked" would lie to the popup on re-open.
 *  Source of truth is offscreen; this slot is the popup's snapshot,
 *  refreshed via `probeLockState` on mount, after unlock, and after
 *  the operator clicks Lock in ConnectedView. */
interface LockState {
  /** `null` until the first probe completes. */
  state: { encrypted: boolean; unlocked: boolean } | null;
  setLockState: (s: { encrypted: boolean; unlocked: boolean }) => void;
}

export const useLockStateStore = create<LockState>()((set) => ({
  state: null,
  setLockState: (s) => set({ state: s }),
}));
