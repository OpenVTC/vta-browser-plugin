// Scope checks for SessionBlob cookie injection.
//
// `handleInjectCookies` writes cookies that arrived over the wire from a VTA
// into the user's own cookie jar. That is the most powerful thing this
// extension does, and the one a Web Store reviewer will look hardest at — the
// shape of the operation is indistinguishable from session hijacking unless
// the scoping is provably tight.
//
// Chrome does enforce most of this itself: `chrome.cookies.set` rejects a
// `domain` that is not a suffix of the URL's host, and applies the public
// suffix list so nobody sets a cookie on `.co.uk`. But relying on that alone
// has two problems. The rejection surfaces as a thrown error inside a
// per-cookie `catch` that logs and continues, so a mis-scoped cookie is
// indistinguishable from a transient failure. And "the browser would stop us"
// is not a claim anyone can verify by reading this extension's source.
//
// So these functions restate the rules explicitly, ahead of the API call.
// They are the belt; Chrome's own checks (including the PSL, which is not
// reimplemented here) remain the braces.
//
// Kept dependency-free — no `chrome.*`, no imports — so it is directly
// testable under `node --test`. See `tests/cookie-scope.test.mts`.

/** Structured result: `reason` is surfaced to the user, so keep it specific. */
export type OriginCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Cookie `Domain` handling, mirroring the three cases the caller must
 * distinguish:
 *
 *  - `host-only` — emit no `domain` field, letting Chrome derive the host
 *    from the URL. This is what the third party meant when it sent no
 *    `Domain` attribute, and forcing a bare host in its place would widen
 *    the cookie to subdomains the third party deliberately excluded.
 *  - `domain` — emit this (validated) parent domain.
 *  - `rejected` — do not write the cookie at all.
 */
export type CookieDomainScope =
  | { kind: "host-only" }
  | { kind: "domain"; domain: string }
  | { kind: "rejected"; reason: string };

/**
 * Loopback hosts, where `http:` is still a secure context and is the only way
 * a local demo RP can be exercised. Everything else must be `https:`.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h === "::1"
  );
}

/**
 * Validate the origin cookies are about to be written under.
 *
 * `https:` only, loopback excepted. Without this, a SessionBlob naming
 * `http://example.com` would have the wallet plant a session cookie
 * retrievable by any network attacker on the path — and a `file:` or
 * `javascript:` bindOrigin would parse cleanly as a URL and reach
 * `chrome.cookies.set` before anything noticed.
 */
export function checkInjectableOrigin(raw: string): OriginCheck {
  if (!raw) {
    return { ok: false, reason: "missing bindOrigin — cookies need a host to write under" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `bindOrigin is not a URL: ${raw}` };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return {
      ok: false,
      reason:
        `bindOrigin must be https (or http on loopback for local testing), ` +
        `got ${url.protocol}//${url.host}`,
    };
  }
  if (!url.hostname) {
    return { ok: false, reason: `bindOrigin has no host: ${raw}` };
  }
  return { ok: true, url };
}

/**
 * Decide how a cookie's `Domain` attribute maps onto the bound host.
 *
 * The rule is RFC 6265 §5.1.3's domain-match: the domain must equal the host,
 * or the host must end with `"." + domain`. That trailing-dot boundary is the
 * whole point — a plain `host.endsWith(domain)` would let a SessionBlob
 * bound to `evilexample.com` claim `Domain=example.com`, and the resulting
 * cookie would be sent to the real site.
 *
 * Single-label domains (`com`, `localhost`) are refused unless they *are* the
 * host, since a cookie on a bare TLD would be readable by every site under
 * it. Multi-label public suffixes (`co.uk`) are left to Chrome's PSL.
 */
export function cookieDomainScope(
  domain: string | undefined,
  host: string,
): CookieDomainScope {
  if (!domain) return { kind: "host-only" };

  // A leading dot is the canonical spelling for a parent-domain cookie and
  // carries no meaning beyond that (RFC 6265 §4.1.2.3); strip it before
  // comparing. Trailing dots (the FQDN root) are not accepted by Chrome.
  const d = domain.trim().toLowerCase().replace(/^\./, "");
  const h = host.trim().toLowerCase();

  if (!d) return { kind: "host-only" };
  if (d.endsWith(".")) {
    return { kind: "rejected", reason: `cookie domain has a trailing dot: ${domain}` };
  }
  if (/\s/.test(d)) {
    return { kind: "rejected", reason: `cookie domain contains whitespace: ${domain}` };
  }
  // Equal to the host: the cookie is host-only however it was spelled.
  if (d === h) return { kind: "host-only" };

  if (!d.includes(".")) {
    return {
      kind: "rejected",
      reason: `cookie domain "${domain}" is a single label and is not the bound host "${host}"`,
    };
  }
  if (!h.endsWith(`.${d}`)) {
    return {
      kind: "rejected",
      reason: `cookie domain "${domain}" does not domain-match the bound host "${host}"`,
    };
  }
  return { kind: "domain", domain: d };
}
