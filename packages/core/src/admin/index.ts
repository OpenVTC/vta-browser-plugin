// Agent administration — who may act at a VTA, and the contexts they act in.
//
// **Deliberately not re-exported from the package root.** Everything here is
// operator surface: granting authority, revoking it, destroying contexts. The
// browser extension is a wallet and has no business shipping any of it, and the
// root barrel is what would put it in that bundle. Reach it explicitly:
//
//   import { aclGrant } from "@openvtc/pnm-core/admin";
//
// CI asserts the extension's service-worker bundle contains no symbol from this
// module, so the separation is enforced rather than remembered.

export * from "./acl.js";
export * from "./acl-capabilities.js";
export * from "./keys.js";
export * from "./policy.js";
export * from "./sessions.js";
export * from "./devices.js";
export * from "./observability.js";
export * from "./did-templates.js";
export * from "./memory.js";
export * from "./consent.js";
export * from "./contexts.js";
// The holder-scoped half of `persona/*`. Deliberately NOT in the `./persona`
// subpath, which is the wallet's half — see the header of `./persona.ts`.
export * from "./persona.js";
export * from "./services.js";
export * from "./credentials.js";
export * from "./backup.js";
