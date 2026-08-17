/// <reference types="chrome" />

// Register the page provider only where the user has granted access.
//
// The manifest used to declare `content_scripts` matching `<all_urls>`, which
// meant two things: the provider was injected into every page the user ever
// visited, and Chrome's install prompt said "read and change all your data on
// all websites". Making *host permissions* optional (host-permissions.ts) did
// not change either, because a static content-script match is its own grant.
//
// So the match list moves out of the manifest and becomes derived state:
// whatever origins the user has granted, that is where the provider runs.
// Grant an origin and it appears; revoke it and it stops.
//
// Two consequences worth knowing:
//
//  - `registerContentScripts` needs host permission for the patterns it
//    registers, so this can only ever widen to what the user already allowed.
//    That is the point, but it also means the call must be re-run whenever
//    permissions change, or a fresh grant silently does nothing.
//  - Registration does not reach into tabs that are already open. A page
//    loaded before the grant has no provider until it reloads, which is why
//    the caller reloads the tab after granting.

/** One registration covering every granted origin, replaced wholesale on
 *  change. Simpler than diffing per-origin registrations, and the id is what
 *  we look for when reconciling after a service-worker restart. */
export const PROVIDER_SCRIPT_ID = "vta-wallet-provider";

/**
 * Origins where the provider should run.
 *
 * Blanket grants collapse to `<all_urls>`: if the user has granted everything
 * — via `chrome://extensions` → "On all sites" — registering the wildcard is
 * both correct and what they asked for. Filtering it out would leave the
 * provider running nowhere while the browser reports full access, which is the
 * most confusing possible state.
 */
export function providerMatches(granted: readonly string[]): string[] {
  if (granted.some((o) => o === "<all_urls>" || o === "*://*/*")) {
    return ["<all_urls>"];
  }
  // Only http(s) origins can host a content script; a stray pattern would make
  // the whole registration call fail, taking the working origins with it.
  return granted.filter((o) => /^https?:\/\//.test(o)).sort();
}

/** Currently-registered match patterns, or an empty list when none. */
async function registeredMatches(): Promise<string[]> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [PROVIDER_SCRIPT_ID],
    });
    return existing[0]?.matches ?? [];
  } catch {
    return [];
  }
}

/**
 * Reconcile the registration with the current grants.
 *
 * Idempotent, so it is safe to call on every startup, every permission change,
 * and after an update. Returns the patterns now in force, which the caller can
 * log — a wallet that quietly stops working on a site is a support problem,
 * and this is the line that explains it.
 */
export async function syncProviderRegistration(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  const matches = providerMatches(all.origins ?? []);
  const current = await registeredMatches();

  const unchanged =
    matches.length === current.length && matches.every((m, i) => m === current[i]);
  if (unchanged) return matches;

  // No granted origins: unregister entirely rather than registering an empty
  // match list, which Chrome rejects.
  if (matches.length === 0) {
    if (current.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [PROVIDER_SCRIPT_ID] });
    }
    return [];
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: PROVIDER_SCRIPT_ID,
    js: ["content.js"],
    matches,
    runAt: "document_start",
    // Survives browser restarts, so a page loaded before the service worker
    // wakes still gets its provider. The startup reconcile is the backstop for
    // when that record and the grants disagree.
    persistAcrossSessions: true,
    allFrames: false,
  };

  if (current.length > 0) {
    await chrome.scripting.updateContentScripts([script]);
  } else {
    await chrome.scripting.registerContentScripts([script]);
  }
  return matches;
}

/**
 * Whether the provider is expected to run on a URL.
 *
 * Used by the popup to decide between "sign in" and "enable on this site".
 * Deliberately asks the permission system rather than pattern-matching the
 * registration: the permission is the thing that decides, and reimplementing
 * match-pattern semantics here would drift from Chrome's.
 */
export async function providerRunsOn(url: string | undefined): Promise<boolean> {
  if (!url || !/^https?:\/\//.test(url)) return false;
  try {
    return await chrome.permissions.contains({ origins: [url] });
  } catch {
    return false;
  }
}
