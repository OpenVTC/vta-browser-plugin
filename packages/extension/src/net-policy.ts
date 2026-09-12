// Which endpoints this wallet is willing to dial — decided in one place.
//
// A mediator's REST, auth and WebSocket URLs come out of a DID document the
// wallet did not write, and its VTA's REST base is written from one at
// onboarding. `@openvtc/vti-didcomm-js` 0.8 checks each of them before it is
// dialed (`netPolicy`, `net-guard.js`): https/wss only, no credentials in the
// URL, no loopback, RFC 1918, link-local/metadata, carrier-NAT or local-only
// name, and no redirect followed. Without that, a mediator DID handed to this
// wallet — from a QR code, or a document that changed after onboarding — is a
// way to make the user's own browser reach a machine on the user's own network
// and hand it this wallet's mediator JWT.
//
// **Production gets neither opt-out, and that is the whole reason this module
// exists rather than a literal at each call site.** There are two flags,
// `allowInsecure` (admit `http:`/`ws:`) and `allowPrivate` (admit a non-public
// host), and since 0.8 the first no longer implies the second. A build that set
// only `allowInsecure` — sufficient before 0.8 — would today refuse a local
// stack while a build that set both in production would accept
// `https://169.254.169.254`. Deciding it once, from the build, is what keeps
// those two states from drifting apart at nine call sites.
//
// The build is the decision: `npm run dev` builds with `--mode development`, so
// vite defines `import.meta.env.DEV`. Every packaged build — `npm run build`,
// which is what CI and the Web Store zip run — is production.
//
// Fails closed. Outside a vite build `import.meta.env` does not exist (under
// `node --test`, for instance), and that reads as production, so a test has to
// ask for the dev policy explicitly rather than inherit it.
//
// What this cannot do in a browser: an extension has no DNS API, so a public
// name that *resolves* to a private address (`127.0.0.1.nip.io`, a rebinding
// domain) passes every check above. `allowHosts` is the only strong control
// against that, and it needs a list of hosts the wallet trusts — which this
// wallet does not have: it records its mediators and agents as DIDs
// (`config.ts` inboxes, the persisted connections), and their hosts are
// whatever those documents say at resolution time. Narrowing to a list derived
// from the same document would check a value against itself. So the parameter
// is plumbed through and left unset, and pinning it is a follow-up that belongs
// beside the inbox in `config.ts`, where an operator can state it.

import type { NetPolicy } from "@openvtc/pnm-core";

/** True in a `--mode development` vite build, false anywhere else. */
export function isDevBuild(): boolean {
  // `import.meta.env` is substituted at build time and simply absent outside a
  // vite build, hence the guard rather than a bare property read.
  return typeof import.meta.env !== "undefined" && import.meta.env.DEV === true;
}

/**
 * The policy every mediator and VTA endpoint this extension dials is held to.
 *
 * `allowHosts` is accepted so a caller holding a pinned list can narrow
 * further; it never widens, since the guard applies it on top of the address
 * and name checks rather than instead of them.
 */
export function walletNetPolicy(opts: { allowHosts?: readonly string[] } = {}): NetPolicy {
  const allowHosts =
    opts.allowHosts && opts.allowHosts.length > 0 ? [...opts.allowHosts] : undefined;
  return {
    // Local development only, and both together: see the header.
    ...(isDevBuild() ? { allowInsecure: true, allowPrivate: true } : {}),
    ...(allowHosts ? { allowHosts } : {}),
  };
}
