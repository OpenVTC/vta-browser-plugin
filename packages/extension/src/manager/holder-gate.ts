// What the persona pane says when the caller does not hold the authority the
// holder's own identity takes.
//!
// Its own module, and a `.ts` one, for the reason the consent view already
// lives outside its component: what the screen says here is a security
// property, and nothing tests a component's reasoning. The pane's test runner
// cannot load a `.tsx` file, so a decision left inside one is a decision no
// test can reach.

// A *type-only* import: erased at run time, so this module drags no component
// code behind it and the pane's test runner can load it.
import type { Authority } from "./use-vta.js";
import { PERSONA_HOLDER_CAPABILITY } from "../grant-command.js";

/**
 * Whether the agent reports this caller as holding `persona-holder`.
 *
 * **That capability is the whole test, and no role stands in for it.** The
 * holder's attribute pool, the faces over it and the disclosure history sit
 * above every trust context. The agent admits a caller to them on an ACL entry
 * granted `persona-holder` by name, and on nothing else — not a context admin,
 * and since verifiable-trust-infrastructure #1673 not an admin with no context
 * restriction either. This used to be `isUnscopedHolder` (`Admin` and an empty
 * scope list), which mirrored the agent's old `require_super_admin` gate; after
 * #1673 that test passed exactly the credential most likely to be refused, and
 * the pane said nothing to it.
 *
 * Read from `auth/whoami`'s `capabilities`, the *effective* set: the role's
 * own, narrowed, plus anything granted by name. It is the only member that can
 * show an additive grant, which is why it exists (whoami 0.1).
 *
 * Advisory: the agent decides again on every task regardless of what this
 * returns.
 */
export function holdsPersonaHolder(authority: Authority | null): boolean {
  return authority?.capabilities.includes(PERSONA_HOLDER_CAPABILITY) ?? false;
}

/** The command that grants a caller holder authority. `pnm acl update` takes
 *  the entry's DID as a positional argument, not `--did`. `--capabilities
 *  persona-holder` is additive — it narrows nothing the role already holds. */
export function personaHolderGrantCommand(did: string): string {
  return `pnm acl update ${did} --capabilities ${PERSONA_HOLDER_CAPABILITY}`;
}

/** Why the holder-scoped tasks on this page will be refused. Null while the
 *  answer is not yet in, and when the caller holds what it takes.
 *
 *  **No role is named as a way in.** The old text offered "an agent credential
 *  with no context restriction" as one of two answers; after #1673 it is no
 *  answer at all, and an operator following it widens a credential and is
 *  refused anyway. The grant is the one route, so the note prints it. */
export function holderGate(authority: Authority | null): string | null {
  if (!authority) return null;
  if (holdsPersonaHolder(authority)) return null;
  return (
    "Your attributes sit above every context, so reaching them takes the " +
    "`persona-holder` capability, and your agent reports that this wallet's credential " +
    "does not hold it. No role includes it — not even one with no context restriction. " +
    "Someone with the whole agent can grant it: " +
    `\`${personaHolderGrantCommand(authority.session.subject)}\``
  );
}
