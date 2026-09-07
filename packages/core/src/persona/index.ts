// `persona/*` 1.0 — the holder's own identity, as much of it as a wallet may
// touch.
//
// The family has two halves and this module implements one of them. The
// **attribute pool** and the **profiles** over it are agent-scoped: they sit
// above every trust context, and the agent gates them on an *unscoped holder*
// credential — `Admin` with unrestricted scope. This wallet's holder identity
// is scoped to a context, so `persona/attribute/*`, `persona/profile/*`,
// `persona/binding/set`, `persona/correlation/analyze` and
// `persona/disclosure/history` would be refused with `e.p.msg.forbidden` on
// every call. They are absent here because they cannot work, not because
// nobody got to them; authoring a persona is done from `pnm`, which holds the
// holder credential.
//
// What is left is exactly what a wallet is for:
//
//   - **disclosure** (`./disclosure.js`) — the two-call gate. `preview` says
//     what would be revealed and to whom; `present` hands it over. There is no
//     one-call form, and this module deliberately offers no wrapper that would
//     look like one.
//   - **renderers** (`./renderers.js`) — the output formats the agent can
//     produce, and what each one DISCARDS.
//   - **bindings** (`./bindings.js`) — which persona is presenting in this
//     context, read-only. Thin by design: whether bound and how many claims,
//     never contents. Contents arrive only through disclosure.
//   - **contacts** (`./contacts.js`) — what other people have disclosed to the
//     holder, filed against the persona that knows them.
//   - **local** (`./local.js`) — profiles and bindings that live INSIDE one
//     context, built only from inline values. A context-local profile cannot
//     reference the pool, and the published schema is what makes that true:
//     its entries admit a single `inline` member and there is nowhere to put a
//     pool identifier.
//
// **`disclosure/history` is holder-scoped and that is not a gap for this
// wallet.** The reading it would give — "what has this verifier had from me
// before" — is already in the preview, as `newToThisVerifier` on each claim.
// The agent derives it from history it can see and hands over the conclusion,
// which is the part a consent screen needs, without opening a cross-context
// read to a context-scoped caller.

export * from "./disclosure.js";
export * from "./step-up.js";
export * from "./consent-view.js";
export * from "./renderers.js";
export * from "./bindings.js";
export * from "./contacts.js";
export * from "./local.js";
