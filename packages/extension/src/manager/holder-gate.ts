// What the persona pane says when the caller may not hold enough authority.
//!
// Its own module, and a `.ts` one, for the reason the consent view already
// lives outside its component: what the screen says here is a security
// property, and nothing tests a component's reasoning. The pane's test runner
// cannot load a `.tsx` file, so a decision left inside one is a decision no
// test can reach.

// A *type-only* import: erased at run time, so this module drags no component
// code behind it and the pane's test runner can load it.
import type { Authority } from "./use-vta.js";

/**
 * Whether the agent would treat this caller as an **unscoped holder** — `Admin`
 * with no context restriction.
 *
 * This is not "an administrator". The `persona/*` pool sits above every trust
 * context, and the agent gates it on `require_super_admin`, deliberately not on
 * `role == Admin`: an administrator scoped to a single context who could read
 * the pool would be reading identity data belonging to every *other* context.
 * `hasRole(authority, "admin")` is exactly the check that gets that wrong.
 *
 * **The emptiness of `scopes` means opposite things depending on the role.**
 * `vti-common`'s own `act_scope` warns about this from the other side: an empty
 * context list is *unrestricted* for an admin and *nothing at all* for every
 * other role. So the role test is not redundant with the scope test — reading
 * `scopes.length === 0` alone would promote a monitor with no scopes to the most
 * privileged caller there is.
 *
 * Advisory: the agent decides again on every task regardless of what this
 * returns. It is *sufficient* for the holder-scoped tasks and, since
 * `persona-holder` exists, no longer *necessary* — see `holderGate`.
 */
export function isUnscopedHolder(authority: Authority | null): boolean {
  if (!authority) return false;
  return authority.roles.includes("admin") && authority.scopes.length === 0;
}

/** The caution every task on this page shares. Null when the caller is known to
 *  hold what it takes.
 *
 *  **A caution, not a gate — the name is older than the model.** It used to
 *  return a refusal and disable the buttons, on the reasoning that an unscoped
 *  admin was the only credential that could reach the holder-scoped tasks. That
 *  stopped being true when the agent gained `persona-holder`
 *  (verifiable-trust-infrastructure#1286): a context-scoped entry granted that
 *  capability reaches them too, and it is now the *recommended* shape — OpenVTC's
 *  own setup asks for exactly it.
 *
 *  `isUnscopedHolder` is therefore sufficient but no longer necessary, and
 *  `auth/whoami` reports roles and scopes but not capabilities, so this console
 *  cannot tell the difference. Disabling on a check that cannot see the answer
 *  would have locked the console out of the configuration it recommends. So it
 *  explains and stands aside; the agent was always the one deciding.
 *
 *  Making it certain again means `auth/whoami` returning capabilities — a spec
 *  change, then trust-tasks-rs, then the VTA. Worth doing; not worth guessing in
 *  the meantime. */
export function holderGate(authority: Authority | null): string | null {
  if (!authority) return null;
  if (isUnscopedHolder(authority)) return null;
  return (
    "Your attributes sit above every context, so reaching them takes authority of its own: " +
    "an agent credential with no context restriction, or one granted the " +
    "`persona-holder` capability. This console cannot see which you have — " +
    "`auth/whoami` reports roles and scopes, not capabilities — so it does not stop " +
    "you trying. Your agent decides, and says so if it refuses."
  );
}
