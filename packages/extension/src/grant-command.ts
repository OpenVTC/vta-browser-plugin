// The `pnm acl create` line the operator runs to authorise this wallet.
//
// Its own module, and a `.ts` one, because what it prints is a security
// decision wearing the clothes of a display string. The command grants the
// ephemeral did:key whatever authority the wallet is about to inherit, and the
// two ways it can be wrong are both silent:
//
//   * **Too wide.** Omit `--contexts` and the grant is a *super-admin* — an
//     admin with an empty context list is unrestricted, which is the entire
//     mechanism (`vti-common`'s `act_scope`). The wallet asked to work inside
//     one context and the operator handed it the agent. Nothing on screen says
//     so, because a successful grant looks identical either way.
//   * **Too narrow.** Pass `--contexts` when the wallet asked for the whole
//     agent and the ephemeral cannot confer what it does not hold: the
//     provisioning is refused with `forbidden`, after the operator has run a
//     command they were told was correct.
//
// So the scope choice and the printed command are one decision, taken here,
// and tested.
//
// **There is no `--role super-admin`.** The CLI's roles are `admin`,
// `initiator`, `application` and `reader`; super-admin is the *shape* of an
// admin grant, not a role name. This used to print `--role super-admin` when
// the operator asked to create a context inline — a command `pnm` rejects
// outright — which is the concrete version of why this lives in a tested
// module.

import type { AdminScope } from "@openvtc/pnm-core";

export interface GrantCommandInput {
  /** The ephemeral `did:key` the wallet just minted and needs authorised. */
  ephemeralDid: string;
  /** What the wallet is being set up to do. */
  adminScope: AdminScope;
  /** The context the wallet will live in.
   *
   *  Required for a `"context"` grant — it is the `--contexts` value. Ignored
   *  for `"unrestricted"`, where the whole point is that the grant names no
   *  context: the wallet still has a home context, but it is chosen *after*
   *  the grant, from the list the now-authorised ephemeral can read. */
  context?: string;
}

/**
 * Build the grant command for a scope, or throw when the inputs cannot
 * produce a correct one.
 *
 * Throws rather than degrading: a context-scoped ask with no context would
 * otherwise render as the unrestricted form, which is the "too wide" failure
 * above — and it would be the operator, not this code, who found out.
 */
export function grantCommand({ ephemeralDid, adminScope, context }: GrantCommandInput): string {
  // `--expires 1h` so an abandoned onboarding — prepared, never connected —
  // does not leave a permanent grant for a key nobody will use again. The
  // successful path deletes the row at swap time regardless of expiry, and the
  // ACL sweeper prunes the rest.
  const base = `pnm acl create --did ${ephemeralDid} --role admin`;
  if (adminScope === "unrestricted") {
    // No `--contexts`. `pnm acl create` documents this precisely: omitting the
    // flag leaves the list empty, which is *unrestricted* for `--role admin`.
    // Passing `--contexts ''` is not the same thing and is rejected — it
    // parses to one context named empty-string.
    return `${base} --expires 1h`;
  }
  const ctx = context?.trim();
  if (!ctx) {
    throw new Error(
      "a context-scoped grant needs the context it is scoped to — without it the " +
        "command would grant the whole agent",
    );
  }
  return `${base} --contexts ${ctx} --expires 1h`;
}

/**
 * Whether an operator running this command would be conferring authority they
 * must themselves hold unrestricted.
 *
 * Only `"unrestricted"` is: an admin may not grant wider than itself, so a
 * context-scoped operator running the unrestricted form gets a refusal from
 * their own agent. Surfaced so the screen can say that up front rather than
 * letting the operator discover it from a failed paste.
 */
export function needsSuperAdminOperator(adminScope: AdminScope): boolean {
  return adminScope === "unrestricted";
}
