// The capability narrowing on an ACL entry — what a subject may do *within*
// the role it holds.
//
// ## Why this file exists rather than a generated binding
//
// Everything else in `admin/acl.ts` comes from `@openvtc/trust-tasks`, and the
// header there is emphatic about why: a hand-transcribed copy of the agent's
// shapes drifts. This file is the exception, and it is one because the
// framework has no vocabulary to generate from. `AclEntry.role` is specified as
// "an opaque role identifier interpreted by the ACL maintainer" — the schema
// deliberately does not know what `admin` means, and it knows even less about
// capabilities. So the narrowing rides `ext` under a reverse-DNS namespace,
// which is exactly what SPEC.md §4.5.1 reserves that member for.
//
// The two tables below are therefore a copy of `vti-common::acl`, and a copy is
// a liability. `task-surface.json` answers the same problem the same way, so
// this reuses that machinery: `acl-capabilities.json` is a committed snapshot
// refreshed by `scripts/sync-acl-capabilities.mjs`, and
// `tests/acl.capabilities.mjs` fails when this file and the snapshot disagree.
// A drift here is not cosmetic — a role whose derived set has grown at the
// agent and not here makes the console under-report what an entry can do,
// which is the exact misreading #1279 was written to end.
//
// ## What a narrowing means
//
// An explicit set only ever **narrows**, never widens: the effective set is the
// role's derived set intersected with the entry's own. Empty means "whatever
// the role implies" — the shape of every entry written before the agent gained
// this feature — so `role` stays a true upper bound, and an operator reading
// `role: reader` knows the entry holds no more than a reader whatever else its
// list says.
//
// The agent enforces this per gated call by reading the entry, not the token,
// so a narrowing binds the subject's next request rather than waiting for their
// next token mint. That matters to a console: the effect of a change here is
// immediate, and the UI should not imply otherwise.

import type { AclEntry } from "@openvtc/trust-tasks/acl/grant/0.1/payload";
import type { Ext } from "@openvtc/trust-tasks/_shared/components";

/**
 * The `ext` member a capability narrowing travels in, on `acl/update/0.1`
 * requests and on the `acl/{grant,show,list}` entries that echo it back.
 *
 * Same convention as `org.openvtc.vault-session`.
 */
export const CAPABILITIES_EXT_MEMBER = "org.openvtc.capabilities";

/**
 * The capabilities this build knows how to name.
 *
 * **Not closed.** The agent's `Capability` is `#[non_exhaustive]` on purpose,
 * and its own doc comment says why: a capability a consumer has never heard of
 * is precisely the one it must not silently treat as granted. Every function
 * here takes `string` on the read path for that reason, and reports what it did
 * not recognise rather than dropping it.
 */
export const ACL_CAPABILITIES = [
  "vault-read",
  "vault-write",
  "proxy-login",
  "fill-release",
  "policy-admin",
  "device-admin",
  "sign",
  "key-mint",
  "sign-trust-task",
  "credential-write",
  "memory-read",
  "memory-write",
  "room-present",
  "room-open",
] as const;

export type AclCapability = (typeof ACL_CAPABILITIES)[number];

/** The roles this agent's ACL defines. Ecosystem-local, like the capabilities. */
export const ACL_ROLES = ["admin", "initiator", "application", "reader", "monitor"] as const;

export type AclRole = (typeof ACL_ROLES)[number];

/**
 * What each role implies — the **ceiling** an entry's own set is intersected
 * with, never a default that a narrowing replaces.
 *
 * `monitor` derives nothing, which is not a gap: it is the least-privileged
 * role and the agent's `Default`, so a claim that leaks past its expected reach
 * lands on the most restricted role rather than the most privileged. A
 * consequence worth knowing before building a UI over this: narrowing a
 * monitor is a no-op, because the intersection is empty either way.
 */
export const DERIVED_CAPABILITIES: Readonly<Record<AclRole, readonly AclCapability[]>> = {
  admin: [
    "vault-read",
    "vault-write",
    "credential-write",
    "memory-read",
    "memory-write",
    "room-present",
    "room-open",
    "proxy-login",
    "fill-release",
    "policy-admin",
    "device-admin",
    "sign",
    "sign-trust-task",
    "key-mint",
  ],
  // Everything `admin` has except `policy-admin`.
  initiator: [
    "vault-read",
    "vault-write",
    "credential-write",
    "memory-read",
    "memory-write",
    "room-present",
    "room-open",
    "proxy-login",
    "fill-release",
    "device-admin",
    "sign",
    "sign-trust-task",
    "key-mint",
  ],
  // The role a memory agent runs as — an agent holding strictly less than its
  // human. It keeps both memory capabilities and both room ones deliberately:
  // the room oracle exists *for* this role, and without them the one consumer
  // it was built for could not call it.
  application: [
    "vault-read",
    "proxy-login",
    "fill-release",
    "sign",
    "sign-trust-task",
    "memory-read",
    "memory-write",
    "room-present",
    "room-open",
  ],
  reader: ["vault-read", "memory-read"],
  monitor: [],
};

export function isAclCapability(name: string): name is AclCapability {
  return (ACL_CAPABILITIES as readonly string[]).includes(name);
}

export function isAclRole(role: string): role is AclRole {
  return (ACL_ROLES as readonly string[]).includes(role);
}

/**
 * Read a narrowing out of an `ext` object.
 *
 * `undefined` means the member is absent. On a **response** that means the
 * entry is not narrowed — the agent omits the member rather than sending `[]`,
 * because an empty array there would read as "narrowed to nothing". On a
 * **request** it means "leave whatever is stored alone", which is a different
 * thing again; see {@link capabilitiesIntoExt}.
 *
 * A malformed member throws rather than resolving to `undefined`. Absence and
 * "the agent sent something this cannot parse" are opposite conclusions about
 * an entry's authority, and returning the safe-looking one would report an
 * entry as unnarrowed on the strength of a parse failure.
 */
export function capabilitiesFromExt(ext: Ext | undefined): string[] | undefined {
  const member = ext?.[CAPABILITIES_EXT_MEMBER];
  if (member === undefined) return undefined;
  if (!Array.isArray(member)) {
    throw new Error(`\`${CAPABILITIES_EXT_MEMBER}\` must be an array of capability names`);
  }
  for (const item of member) {
    if (typeof item !== "string") {
      throw new Error(
        `\`${CAPABILITIES_EXT_MEMBER}\` must contain strings, found ${JSON.stringify(item)}`,
      );
    }
  }
  return [...(member as string[])];
}

/**
 * Put a narrowing into an `ext` object for a **request**, preserving anything
 * else already there.
 *
 * **An empty array is written, not omitted.** That is the one place this
 * differs from the agent's own `capabilities_into_ext`, which drops an empty
 * set — because that helper serves the *response* path, where absent is the
 * only spelling for "not narrowed". On the request path the three intentions
 * are distinct and the agent acts on all three:
 *
 * - **omitted** — leave the stored narrowing alone;
 * - **`[]`** — clear it, so the entry holds everything its role implies. A
 *   privilege *increase*;
 * - **populated** — narrow to the intersection with the role's set.
 *
 * Collapsing the first two is a silent privilege increase, which is why a
 * caller reaches this function only by passing an array: to leave a narrowing
 * alone, do not call it.
 */
export function capabilitiesIntoExt(ext: Ext | undefined, capabilities: readonly string[]): Ext {
  return { ...(ext ?? {}), [CAPABILITIES_EXT_MEMBER]: [...capabilities] };
}

/** The narrowing an entry carries, or `undefined` if it names none. */
export function entryNarrowing(entry: AclEntry): string[] | undefined {
  return capabilitiesFromExt(entry.ext);
}

/** What an entry may actually do, and the working shown. */
export interface EffectiveCapabilities {
  /** The role's ceiling. */
  derived: readonly AclCapability[];
  /** The ceiling intersected with the entry's own set. */
  effective: readonly AclCapability[];
  /** True when the entry names no narrowing, so `effective` is the whole ceiling. */
  unnarrowed: boolean;
  /**
   * Names in the stored narrowing this build does not recognise.
   *
   * They are absent from `effective` because the ceiling is what grants, and
   * this build's ceiling cannot contain a name it has never heard of. Surfaced
   * rather than dropped so a console can say "this agent is newer than this
   * console" instead of quietly showing an entry as holding less than it does.
   */
  unrecognised: readonly string[];
}

/**
 * What an entry holds: its role's set, narrowed by its own.
 *
 * Returns `undefined` for a role this build does not know — **not** an empty
 * set. The two would render identically as "holds nothing", and one of them is
 * a lie about an entry that may hold everything. An unknown role means this
 * console is older than the agent, which is a thing to say out loud.
 */
export function effectiveCapabilities(
  role: string,
  narrowing: readonly string[] | undefined,
): EffectiveCapabilities | undefined {
  if (!isAclRole(role)) return undefined;
  const derived = DERIVED_CAPABILITIES[role];
  if (narrowing === undefined || narrowing.length === 0) {
    return { derived, effective: derived, unnarrowed: true, unrecognised: [] };
  }
  return {
    derived,
    effective: derived.filter((c) => narrowing.includes(c)),
    unnarrowed: false,
    unrecognised: narrowing.filter((n) => !isAclCapability(n)),
  };
}

/**
 * Whether a narrowing is one the agent will accept, checked before sending.
 *
 * The agent refuses two things rather than silently dropping them, and this
 * reproduces both so an operator learns at the form rather than from a
 * rejection: a name no build recognises, and a capability the role does not
 * carry. The second is not merely pedantic — a narrowing to a capability
 * outside the role would intersect to nothing, so accepting it would take
 * authority away by way of a request that reads like it adds some.
 *
 * Clearing a narrowing (`[]`) is always allowed: it widens back to the role,
 * which the role itself bounds.
 */
export function checkNarrowing(
  role: string,
  requested: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const unknown = requested.filter((n) => !isAclCapability(n));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason:
        `unknown capability \`${unknown.join("`, `")}\`; this console does not recognise it, ` +
        `and narrowing an entry to a capability nobody enforces would grant more than intended`,
    };
  }
  if (!isAclRole(role)) {
    return {
      ok: false,
      reason: `unknown role \`${role}\`; this console cannot tell what it may be narrowed to`,
    };
  }
  const beyond = requested.filter((n) => !(DERIVED_CAPABILITIES[role] as readonly string[]).includes(n));
  if (beyond.length > 0) {
    return {
      ok: false,
      reason:
        `the ${role} role does not carry \`${beyond.join("`, `")}\`, so narrowing to it would ` +
        `leave the entry holding nothing of what was named`,
    };
  }
  return { ok: true };
}
