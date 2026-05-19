import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface Connection {
  vtaUrl: string;
  did: string;
  accessToken: string;
}

interface State {
  connection: Connection | null;
  setConnection: (c: Connection) => void;
  clearConnection: () => void;
}

/**
 * MV3 doesn't expose `localStorage` to the popup the same way a tab
 * does — and we want state to survive the popup closing. Use
 * `chrome.storage.local` via a small adapter.
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
      name: "pnm-connection",
      storage: createJSONStorage(() => chromeStorage),
    },
  ),
);
