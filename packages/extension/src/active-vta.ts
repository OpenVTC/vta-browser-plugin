/// <reference types="chrome" />

/**
 * Read the active VTA DID from the popup's persisted connection store.
 *
 * The store uses zustand-persist under chrome.storage.local key
 * `pnm-connection/v3`; the persisted envelope is
 * `{ state: { connections: { activeVtaDid, vtas } }, version }`.
 * This helper exists in its own module so both `holder.ts` (extension
 * RP-flow handlers) and the background dispatcher can read the active
 * vtaDid without each rolling its own chrome.storage parse. Returns
 * `null` when no VTA is active (fresh install, post-Disconnect, or
 * pre-v3 storage that hasn't been migrated by the popup yet).
 */
export async function readActiveVtaDid(): Promise<string | null> {
  const stored = await chrome.storage.local.get("pnm-connection/v3");
  return parseActiveVtaDid(stored["pnm-connection/v3"]);
}

/** Parse the same envelope from an already-loaded raw value — used by
 *  the chrome.storage.onChanged path in background where we already
 *  hold the new value. */
export function parseActiveVtaDid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as {
      state?: { connections?: { activeVtaDid?: string | null } };
    };
    return parsed.state?.connections?.activeVtaDid ?? null;
  } catch {
    return null;
  }
}

/** Enumerate every VTA the wallet has onboarded — keys of the
 *  persisted `vtas` map regardless of which one is active. Background
 *  uses this to drive the multi-listener inbound reconcile. Returns
 *  `[]` when no VTAs are configured (fresh install or post-wipe) or
 *  when the storage is unreadable. */
export async function readAllVtaDids(): Promise<string[]> {
  const stored = await chrome.storage.local.get("pnm-connection/v3");
  return parseAllVtaDids(stored["pnm-connection/v3"]);
}

export function parseAllVtaDids(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as {
      state?: { connections?: { vtas?: Record<string, unknown> } };
    };
    return Object.keys(parsed.state?.connections?.vtas ?? {});
  } catch {
    return [];
  }
}
