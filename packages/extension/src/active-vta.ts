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

/** The DIDComm mediator advertised by an onboarded agent, for a wallet that
 *  has no inbox of its own yet.
 *
 *  Onboarding records each agent's advertised mediator on its `Connection`
 *  (`store.ts`) and, since the fix that removed the hardcoded default, writes
 *  it to the wallet's inbox setting too. Wallets onboarded BEFORE that fix
 *  have the connection but no setting — they were running on the hardcoded
 *  demo relay — and re-onboarding to acquire one is not a fair ask: it mints
 *  a fresh holder DID that every RP ACL must then be re-granted. So the
 *  backfill reads the answer already on disk. This mirrors `tspMediatorDid`,
 *  which the transport refresh backfills onto existing connections for the
 *  same reason.
 *
 *  The active VTA's mediator wins; otherwise the first agent that advertises
 *  one, so a single-agent wallet backfills whether or not the active pointer
 *  has been set. Returns `undefined` when no agent advertises a mediator —
 *  a REST- or TSP-only deployment, where there is genuinely nothing to adopt. */
export async function readAgentMediatorDid(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get("pnm-connection/v3");
  return parseAgentMediatorDid(stored["pnm-connection/v3"]);
}

export function parseAgentMediatorDid(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      state?: {
        connections?: {
          activeVtaDid?: string | null;
          vtas?: Record<string, { mediatorDid?: unknown }>;
        };
      };
    };
    const conns = parsed.state?.connections;
    const vtas = conns?.vtas ?? {};
    const active = conns?.activeVtaDid ? vtas[conns.activeVtaDid]?.mediatorDid : undefined;
    if (typeof active === "string" && active) return active;
    for (const entry of Object.values(vtas)) {
      if (typeof entry?.mediatorDid === "string" && entry.mediatorDid) return entry.mediatorDid;
    }
    return undefined;
  } catch {
    return undefined;
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
