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

/**
 * Make `vtaDid` the active agent, if the wallet has onboarded it.
 *
 * Writes the same `pnm-connection/v3` envelope the readers above parse, which
 * is zustand's persisted blob. Read-modify-write rather than a blind set: the
 * envelope carries the whole connection map, and replacing it wholesale from a
 * partial view would forget every other VTA — the same class of bug the
 * per-agent inbox map exists to prevent (see CLAUDE.md).
 *
 * Refuses a DID the wallet does not hold, matching `activateVta` in the store:
 * activating an agent that was never onboarded would leave the console pointed
 * at something it has no holder identity for.
 *
 * Returns whether the switch happened, so a caller can tell "done" from "that
 * agent is not on this device" without inspecting storage itself.
 */
export async function setActiveVtaDid(vtaDid: string): Promise<boolean> {
  const KEY = "pnm-connection/v3";
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY];
  if (typeof raw !== "string") return false;

  let parsed: { state?: { connections?: { activeVtaDid?: string | null; vtas?: Record<string, unknown> } } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  const connections = parsed.state?.connections;
  if (!connections?.vtas || !(vtaDid in connections.vtas)) return false;
  if (connections.activeVtaDid === vtaDid) return true;

  connections.activeVtaDid = vtaDid;
  await chrome.storage.local.set({ [KEY]: JSON.stringify(parsed) });
  return true;
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

/** Every onboarded agent's advertised DIDComm mediator, keyed by agent DID.
 *
 *  Onboarding records each agent's advertised relay on its `Connection`
 *  (`store.ts`) and, since the fix that removed the hardcoded default, in the
 *  wallet's per-agent inbox map too. Wallets onboarded before that have the
 *  connection but no inbox — they were running on the hardcoded demo relay —
 *  and re-onboarding to acquire one is not a fair ask: it mints a fresh holder
 *  DID that every RP ACL must then be re-granted. So the boot adopt reads the
 *  answer already on disk. This mirrors `tspMediatorDid`, backfilled onto
 *  existing connections for the same reason.
 *
 *  Agents advertising no mediator are absent from the map rather than present
 *  with an empty value: there is genuinely nothing to adopt for them. */
export async function readAgentMediatorDids(): Promise<Record<string, string>> {
  const stored = await chrome.storage.local.get("pnm-connection/v3");
  return parseAgentMediatorDids(stored["pnm-connection/v3"]);
}

export function parseAgentMediatorDids(raw: unknown): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as {
      state?: { connections?: { vtas?: Record<string, { mediatorDid?: unknown }> } };
    };
    const out: Record<string, string> = {};
    for (const [vtaDid, entry] of Object.entries(parsed.state?.connections?.vtas ?? {})) {
      if (typeof entry?.mediatorDid === "string" && entry.mediatorDid) {
        out[vtaDid] = entry.mediatorDid;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the active VTA's holder DID from the persisted connection
 *  store — without going through the holder loader. Returns `null`
 *  when no VTA is active.
 *
 *  Critical for the background service worker's consent-prompt path:
 *  the holder DID is just a display string in the prompt, NOT
 *  signing material. Background has no access to the offscreen's
 *  PRF AES cache (separate module scope), so calling `loadHolder`
 *  from background would throw `WalletLockedError` on an encrypted
 *  wallet even when the wallet is unlocked in offscreen. Reading
 *  the DID straight from chrome.storage sidesteps that entirely. */
export async function readActiveHolderDid(): Promise<string | null> {
  const stored = await chrome.storage.local.get("pnm-connection/v3");
  const raw = stored["pnm-connection/v3"];
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as {
      state?: {
        connections?: {
          activeVtaDid?: string | null;
          vtas?: { [vtaDid: string]: { holderDid?: string } };
        };
      };
    };
    const c = parsed.state?.connections;
    if (!c?.activeVtaDid) return null;
    return c.vtas?.[c.activeVtaDid]?.holderDid ?? null;
  } catch {
    return null;
  }
}
