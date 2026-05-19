import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Connection {
  vtaUrl: string;
  did: string;
  /** Short-lived bearer token (typically minted by `pnm passkey-enroll-token`). */
  accessToken: string;
}

interface State {
  connection: Connection | null;
  setConnection: (c: Connection) => void;
  clearConnection: () => void;
}

export const useConnectionStore = create<State>()(
  persist(
    (set) => ({
      connection: null,
      setConnection: (c) => set({ connection: c }),
      clearConnection: () => set({ connection: null }),
    }),
    { name: "pnm-connection" },
  ),
);
