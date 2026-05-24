/// <reference types="chrome" />

/**
 * Origin → RP-DID pinning.
 *
 * The plugin's consent prompt shows the requesting page's origin
 * next to the `rpDid` it asked to log into. Phishing-resistant
 * only if the operator reads both fields. M5 from the May 2026
 * security review: persist the first-approved `rpDid` per
 * origin and warn loudly when a subsequent login from the same
 * origin asks for a *different* `rpDid` — the kind of swap a
 * compromised page would attempt to redirect the wallet at an
 * attacker-controlled RP.
 *
 * Storage: `chrome.storage.local`, key prefix `origin-pin:`.
 * Per-origin entry holds the approved `rpDid` and a creation
 * timestamp. Operator can revoke by clearing extension storage
 * (Settings → site data).
 */

const PIN_KEY_PREFIX = "origin-pin:";

interface OriginPinRecord {
  rpDid: string;
  pinnedAt: number;
}

export interface OriginPinStatus {
  /** `true` if no pin exists yet (first login from this origin). */
  firstSeen: boolean;
  /** Previously-approved rpDid for this origin, if any. */
  pinnedRpDid?: string;
  /**
   * `true` when a pin exists AND the current login is asking
   * for a *different* rpDid than what was pinned. The consent
   * prompt MUST render a louder warning in this case.
   */
  rpDidChanged: boolean;
}

function key(origin: string): string {
  return `${PIN_KEY_PREFIX}${origin}`;
}

/**
 * Check the pinning status for an incoming login. Pure read —
 * does not mutate. Call this *before* `requestConsent`; pass
 * the result into the consent prompt so it can decide whether
 * to render the standard prompt or the loud "this site has
 * switched RPs" warning.
 */
export async function checkOriginPin(
  origin: string,
  rpDid: string,
): Promise<OriginPinStatus> {
  const k = key(origin);
  const result = await chrome.storage.local.get(k);
  const record = result[k] as OriginPinRecord | undefined;
  if (!record) {
    return { firstSeen: true, rpDidChanged: false };
  }
  return {
    firstSeen: false,
    pinnedRpDid: record.rpDid,
    rpDidChanged: record.rpDid !== rpDid,
  };
}

/**
 * Persist (or overwrite) the pin for `origin → rpDid`.
 *
 * Call this **only after** the operator has approved the
 * consent prompt. On first sight, this seeds the pin. On a
 * confirmed change (operator approved the "loud" warning
 * variant), this overwrites — they've explicitly accepted
 * the new mapping.
 */
export async function pinOrigin(
  origin: string,
  rpDid: string,
): Promise<void> {
  const record: OriginPinRecord = { rpDid, pinnedAt: Date.now() };
  await chrome.storage.local.set({ [key(origin)]: record });
}

/**
 * Remove the pin for `origin` (operator action — surfaced in
 * settings UI). The next login from this origin starts fresh
 * as `firstSeen: true`.
 */
export async function clearOriginPin(origin: string): Promise<void> {
  await chrome.storage.local.remove(key(origin));
}
