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
  /** Maintainer contexts the operator has used or seen. Populated as
   *  onboardings succeed; surfaced by the popup's onboarding picker so
   *  the operator can re-select a context they've used before instead
   *  of typing it every time. Seeded with `"default"` so a fresh wallet
   *  has one obvious choice. */
  knownContexts: string[];
  rememberContext: (name: string) => void;
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
      knownContexts: ["default"],
      rememberContext: (name) =>
        set((s) =>
          s.knownContexts.includes(name)
            ? s
            : { knownContexts: [...s.knownContexts, name] },
        ),
    }),
    {
      // v2: previous shape was `{ vtaUrl, did, accessToken }` (the legacy
      // URL/DID/enrollment-token form). Ignore that data by bumping the key.
      name: "pnm-connection/v2",
      storage: createJSONStorage(() => chromeStorage),
    },
  ),
);
