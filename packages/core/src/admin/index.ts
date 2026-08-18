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
export * from "./keys.js";
export * from "./policy.js";
export * from "./sessions.js";
export * from "./contexts.js";
