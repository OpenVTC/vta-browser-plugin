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
 * The pin is also what bounds the page's *other* uses of the holder
 * key. `signTrustTask` signs only documents addressed to the pinned
 * `rpDid`, and `stepUpVta` runs only against the pinned `rpDid` and
 * the `baseUrl` the REST login was approved for — see
 * `pageSignBindingRefusal` / `pageStepUpBindingRefusal` in
 * `page-task-policy.ts`. Neither of those paths ever writes a pin: the
 * only place one is seeded is a login the human approved.
 *
 * The key is the browser-attested origin, compared exactly. A
 * subdomain, another scheme or port, or a lookalike host is a
 * different origin with no pin of its own.
 *
 * Storage: `chrome.storage.local`, key prefix `origin-pin:`.
 * Per-origin entry holds the approved `rpDid`, the REST login's
 * normalized `baseUrl` when there was one, and a creation
 * timestamp. Operator can revoke by clearing extension storage
 * (Settings → site data).
 */

import { normalizeBaseUrl } from "./page-task-policy.js";

const PIN_KEY_PREFIX = "origin-pin:";

interface OriginPinRecord {
  rpDid: string;
  /** Normalized RP API base the REST login was approved for. Absent when
   *  the pin was seeded by a DIDComm login, which names no base URL. */
  baseUrl?: string;
  pinnedAt: number;
}

/** What an origin is pinned to. */
export interface OriginPin {
  rpDid: string;
  baseUrl?: string;
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
  /** Previously-approved base URL for this origin, if any. */
  pinnedBaseUrl?: string;
  /**
   * `true` when a base URL is pinned AND the current login names a
   * *different* one. Treated like an RP change: always re-prompt, loudly,
   * because the pinned base URL is where `stepUpVta` is allowed to go.
   */
  baseUrlChanged: boolean;
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
  baseUrl?: string,
): Promise<OriginPinStatus> {
  const record = await readRecord(origin);
  if (!record) {
    return { firstSeen: true, rpDidChanged: false, baseUrlChanged: false };
  }
  const requested = baseUrl === undefined ? undefined : normalizeBaseUrl(baseUrl);
  return {
    firstSeen: false,
    pinnedRpDid: record.rpDid,
    rpDidChanged: record.rpDid !== rpDid,
    ...(record.baseUrl ? { pinnedBaseUrl: record.baseUrl } : {}),
    baseUrlChanged:
      baseUrl !== undefined && record.baseUrl !== undefined && requested !== record.baseUrl,
  };
}

/**
 * What `origin` is pinned to, or `undefined` when nothing is. Pure read.
 * The lookup is by exact origin: no parent-domain or scheme fallback.
 */
export async function readOriginPin(origin: string): Promise<OriginPin | undefined> {
  const record = await readRecord(origin);
  if (!record || typeof record.rpDid !== "string" || record.rpDid === "") return undefined;
  return {
    rpDid: record.rpDid,
    ...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
  };
}

async function readRecord(origin: string): Promise<OriginPinRecord | undefined> {
  const k = key(origin);
  const result = await chrome.storage.local.get(k);
  return result[k] as OriginPinRecord | undefined;
}

/**
 * Persist (or overwrite) the pin for `origin → rpDid`.
 *
 * Call this **only after** the operator has approved the
 * consent prompt. On first sight, this seeds the pin. On a
 * confirmed change (operator approved the "loud" warning
 * variant), this overwrites — they've explicitly accepted
 * the new mapping.
 *
 * `baseUrl` is the REST login's RP API base. A login that names none
 * (DIDComm) keeps the base URL already pinned for the same `rpDid`, and
 * drops it when the `rpDid` changed — a base URL approved for one RP is
 * not approved for another.
 */
export async function pinOrigin(
  origin: string,
  rpDid: string,
  baseUrl?: string,
): Promise<void> {
  let pinnedBase: string | undefined;
  if (baseUrl !== undefined) {
    pinnedBase = normalizeBaseUrl(baseUrl) ?? undefined;
  } else {
    const prior = await readRecord(origin);
    if (prior && prior.rpDid === rpDid) pinnedBase = prior.baseUrl;
  }
  const record: OriginPinRecord = {
    rpDid,
    ...(pinnedBase ? { baseUrl: pinnedBase } : {}),
    pinnedAt: Date.now(),
  };
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
