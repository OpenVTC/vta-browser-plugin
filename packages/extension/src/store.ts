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

interface State {
  connection: Connection | null;
  setConnection: (c: Connection) => void;
  clearConnection: () => void;
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
      connection: null,
      setConnection: (c) => set({ connection: c }),
      clearConnection: () => set({ connection: null }),
    }),
    {
      // v2: previous shape was `{ vtaUrl, did, accessToken }` (the legacy
      // URL/DID/enrollment-token form). Ignore that data by bumping the key.
      name: "pnm-connection/v2",
      storage: createJSONStorage(() => chromeStorage),
    },
  ),
);

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
