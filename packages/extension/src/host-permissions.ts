/// <reference types="chrome" />

// Just-in-time host permissions.
//
// The manifest asks for `optional_host_permissions: ["<all_urls>"]`, not
// `host_permissions`. Nothing is granted at install time; the user grants a
// specific origin at the moment the wallet first needs it. Two reasons:
//
//  - A blanket `<all_urls>` grant means the wallet can reach every site the
//    user visits, forever, and `window.vtaWallet` appears on all of them.
//    Per-origin grants keep both to sites the user named.
//  - `<all_urls>` in `host_permissions` is a documented cause of extended
//    Chrome Web Store review; a reviewer has to rule out data harvesting
//    across the entire web before approving.
//
// Why this doesn't break the rest of the wallet
// ---------------------------------------------
// Only one egress path actually needs a host grant:
//
//  - **VTA REST** — vta-service applies an origin allowlist CORS layer
//    (`AllowOrigin::list`), so an ungranted fetch is CORS-blocked. Granted at
//    onboarding, where the host is derivable from the VTA `did:webvh` before
//    any request is made.
//
// (There used to be a second: cookie injection, which `chrome.cookies.set`
// hard-requires. That path and the `cookies` permission are gone — the wallet
// writes nothing to the cookie jar.)
//
// The other two do not:
//
//  - **DID resolution** — the did:webvh hosting service serves public
//    resolution with `Access-Control-Allow-Origin: *`, so arbitrary RP DIDs
//    still resolve with no grant at all. This matters: `verifyDid` backs the
//    consent prompt's "does this RP resolve" check, there is no user gesture
//    available mid-consent to request a permission from, and a security
//    control that silently degrades is worse than one that isn't there.
//    A did:webvh host behind a restrictive CORS policy is the known gap —
//    it surfaces as "unresolved" in the prompt, which fails closed.
//  - **Mediator** — but only half of it, and the half that is exempt is not
//    the half that fails. The WebSocket upgrade is not subject to CORS; the
//    authentication handshake that must precede it is two ordinary `fetch`
//    calls (`POST {authEndpoint}/challenge`, then the packed response), and
//    those are cross-origin like any other. A mediator whose
//    `[security] cors_allow_origin` does not carry this extension's origin
//    blocks them, and TSP and DIDComm both drop out — they share that
//    handshake — leaving REST carrying everything and the inbox dark.
//
//    A host grant is deliberately still NOT requested for it, because it
//    would not be a fix: the mediator applies the same origin policy to the
//    WebSocket upgrade itself (server side, where no browser permission
//    reaches), so an origin it refuses stays refused. The fix is the
//    mediator's config, and `transport-diagnosis.ts` exists to say so instead
//    of leaving a bare "Failed to fetch" for someone to guess at.
//
// Gesture constraint
// ------------------
// `chrome.permissions.request` only works from a UI context (popup, options)
// inside a user gesture; it throws in a service worker. So the background
// *checks* and reports `HOST_PERMISSION_REQUIRED` with the origin, and the
// popup does the asking inside the click handler and retries. Matching on
// that code rather than on message text is guide rule R3.7.

/**
 * Stable code returned by background handlers when an operation needs a host
 * grant the user has not made. Matched on directly — never parse the message
 * (R3.7).
 */
export const HOST_PERMISSION_REQUIRED = "wallet/host-permission-required";

/**
 * Build the match pattern covering an origin.
 *
 * Accepts either a full URL (`https://vta.example.com/api/v1`) or a bare host
 * as `didWebvhDomain` returns it, which is percent-encoded per the webvh wire
 * format (`vta.example.com`, `localhost%3A8080`).
 *
 * Returns null when there is no usable host, so callers can distinguish
 * "nothing to ask for" from "ask for this".
 */
export function originPatternFor(input: string): string | null {
  if (!input) return null;

  // webvh percent-encodes `:` and `/` in the host segment.
  const decoded = (() => {
    try {
      return decodeURIComponent(input);
    } catch {
      return input;
    }
  })();

  // A bare host has no scheme. Default to https — the only scheme the wallet
  // will talk to off loopback anyway.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)
    ? decoded
    : `https://${decoded}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // Match patterns have no port component — `https://localhost:8080/*` is not
  // a valid pattern, while `http://localhost/*` covers every port on the
  // host. `url.hostname` (unlike `url.host`) already excludes the port.
  return `${url.protocol}//${url.hostname}/*`;
}

/** Whether the user has already granted this origin. Safe in any context. */
export async function hasOriginPermission(input: string): Promise<boolean> {
  const pattern = originPatternFor(input);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    // An invalid pattern throws rather than returning false. Treat as
    // ungranted so the caller surfaces a permission error rather than
    // proceeding as if it held access.
    return false;
  }
}

/**
 * Prompt for an origin. **UI contexts only, inside a user gesture** — this
 * throws in the service worker. Call it as the first thing in a click
 * handler, before any other awaited work.
 *
 * Resolves true if the permission is held afterwards, whether the user just
 * granted it or already had it.
 *
 * Two Chrome behaviours shape this, and getting either wrong makes the first
 * click appear to do nothing:
 *
 *  1. **`chrome.permissions.request` must be reached with the user gesture
 *     still live.** Any `await` before it spends the gesture — including an
 *     innocent-looking `permissions.contains` pre-check, which is why there
 *     isn't one here. Requesting a permission the user already holds
 *     resolves true immediately without showing a dialog, so the pre-check
 *     bought nothing anyway.
 *
 *  2. **The returned promise may never settle.** Showing the dialog can tear
 *     down the calling action popup (crbug 40721470); the context is
 *     destroyed mid-await and nothing after it runs. `permissions.onAdded`
 *     fires on the grant itself, so racing the two means a surviving popup
 *     continues the moment the user clicks Allow rather than hanging on a
 *     promise that will never resolve.
 *
 * A popup that Chrome *does* destroy is beyond rescue from in here — the
 * caller persists enough state to resume when it reopens.
 */
export function requestOriginPermission(input: string): Promise<boolean> {
  const pattern = originPatternFor(input);
  if (!pattern) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (granted: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        chrome.permissions.onAdded.removeListener(onAdded);
      } catch {
        // Listener teardown is best-effort; the context may already be going
        // away, which is precisely the case this whole dance is about.
      }
      resolve(granted);
    };

    // Re-check rather than trusting the event payload: Chrome may normalise
    // the granted pattern (scheme, trailing wildcard) into a form that isn't
    // string-equal to what we asked for.
    const onAdded = (): void => {
      void chrome.permissions
        .contains({ origins: [pattern] })
        .then((held) => {
          if (held) finish(true);
        })
        .catch(() => {
          /* still waiting on the request promise */
        });
    };

    try {
      chrome.permissions.onAdded.addListener(onAdded);
    } catch {
      // No event plumbing available — fall through to the promise alone.
    }

    // A negative answer from `request` is not conclusive. Chrome can report
    // false — or reject outright — for a dialog whose grant actually landed,
    // when the reply races the popup teardown that showing the dialog
    // triggers. Believing it produces the worst version of this bug: the
    // user clicks Allow, sees "access not granted", clicks again, and it
    // works, because the permission was there the whole time.
    //
    // So only `true` is taken at face value; anything else is re-checked
    // against the actual permission state before we conclude.
    const settleWithVerification = (): void => {
      void chrome.permissions
        .contains({ origins: [pattern] })
        .then((held) => finish(held))
        .catch(() => finish(false));
    };

    // No `await` above this line, by design. See (1).
    try {
      chrome.permissions.request({ origins: [pattern] }).then(
        (granted) => (granted ? finish(true) : settleWithVerification()),
        settleWithVerification,
      );
    } catch {
      settleWithVerification();
    }
  });
}

/**
 * Every origin pattern the user has granted.
 *
 * Backs the Sites screen. Until that existed there was no way to review or
 * revoke a grant from inside the wallet at all — `chrome://extensions` was the
 * only surface, which is not somewhere a user should have to go to answer
 * "what can this thing reach?".
 *
 * `<all_urls>` is filtered out: it is what the manifest *may* request, not a
 * per-site grant, and listing it as a row would misrepresent a blanket
 * permission as one site among several. If it is ever actually held, the
 * caller wants to know separately — see `hasBlanketAccess`.
 */
export async function listGrantedOrigins(): Promise<string[]> {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins ?? []).filter((o) => o !== "<all_urls>" && o !== "*://*/*").sort();
  } catch {
    return [];
  }
}

/** True if a blanket grant is held, which makes every per-site row moot. */
export async function hasBlanketAccess(): Promise<boolean> {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins ?? []).some((o) => o === "<all_urls>" || o === "*://*/*");
  } catch {
    return false;
  }
}

/**
 * Give up an origin grant. Unlike requesting, this needs no user gesture and
 * works from any context.
 *
 * Resolves true when the permission is gone afterwards — including when it was
 * never held, since the caller's intent ("this origin must not be reachable")
 * is satisfied either way.
 */
export async function revokeOriginPermission(input: string): Promise<boolean> {
  const pattern = originPatternFor(input);
  if (!pattern) return false;
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    // Fall through to the check — `remove` rejects for a permission that was
    // never granted, which is not a failure of intent.
  }
  return !(await hasOriginPermission(pattern));
}

/** Human-readable host for a permission prompt's explanatory copy. */
export function displayHostFor(input: string): string {
  const pattern = originPatternFor(input);
  if (!pattern) return input;
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
}
