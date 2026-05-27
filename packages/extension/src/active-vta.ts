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
  const raw = stored["pnm-connection/v3"];
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
