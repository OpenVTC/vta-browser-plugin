// What the page-facing proxy is allowed to dial.
//
// `handleApiGet` / `handleApiPost` take a `baseUrl` from the page and fetch it
// with the extension's permissions rather than the page's. A host grant gates
// that, and a grant says exactly one thing: the user agreed to this wallet
// talking to that origin. It says nothing about the scheme, nothing about
// credentials smuggled into the URL, and nothing about where that origin may
// forward the request next — which is why `proxyFetch` also refuses redirects.
//
// The vet runs *before* the grant check, and the order is the point.
// `hasOriginPermission` answers false for a `file:` or `javascript:` URL, so
// without this the caller is told the origin is not granted and the popup
// offers to ask for a permission that can never be granted. Saying what is
// actually wrong costs nothing and is far cheaper to debug.
//
// Loopback `http:` stays dialable: a locally run VTA and the demo RP are real
// targets, and `content-registration.ts` keeps `http://localhost/*` grantable
// for the same reason. Everything else must be TLS on a public host.

import { assertPublicHttpsUrl } from "@openvtc/pnm-core";

/**
 * Return `url` parsed, or throw saying why the wallet will not fetch it.
 *
 * Thin on purpose — the judgement lives in `@openvtc/pnm-core`'s
 * `assertPublicHttpsUrl`, shared with the push-gateway check, so the wallet
 * has one answer to "may this be contacted" rather than one per call site.
 */
export function vetEgressUrl(url: string): URL {
  return assertPublicHttpsUrl(url, { allowLoopback: true, what: "request URL" });
}
