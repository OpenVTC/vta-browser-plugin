// The capability narrowing on an ACL entry — what a subject may do *within*
// the role it holds.
//
// ## Why this file exists rather than a generated binding
//
// Everything else in `admin/acl.ts` comes from `@openvtc/trust-tasks`, and the
// header there is emphatic about why: a hand-transcribed copy of the agent's
// shapes drifts. This file is the exception, and it is one because the
// framework has no vocabulary to generate from. AclEntry 0.2 gives the
// capability scope a shape of its own (`ceiling` / `none` / `listed` grants),
// but `role` is still "an opaque role identifier interpreted by the ACL
// maintainer" and a capability is "an opaque identifier in the maintainer's
// capability registry" — the schema deliberately does not know what `admin`
// means, or what it carries.
//
// The tables below are therefore a copy of `vti-common::acl`, and a copy is
// a liability. `task-surface.json` answers the same problem the same way, so
// this reuses that machinery: `acl-capabilities.json` is a committed snapshot
// refreshed by `scripts/sync-acl-capabilities.mjs`, and
// `tests/acl.capabilities.mjs` fails when this file and the snapshot disagree.
// A drift here is not cosmetic — a role whose derived set has grown at the
// agent and not here makes the console under-report what an entry can do,
// which is the exact misreading #1279 was written to end.
//
// ## What a capability scope means (acl/_shared/0.2 CONVENTIONS §6)
//
// `ceiling` is the role's whole set. `listed` holds (the role's ceiling ∩ the
// non-additive grants) ∪ the additive grants — so a listing only ever
// **narrows** the role, except through a grant marked `additive: true`, and
// `role` stays a true upper bound for everything else. `none` holds nothing.
//
// The agent enforces this per gated call by reading the entry, not the token,
// so a narrowing binds the subject's next request rather than waiting for their
// next token mint. That matters to a console: the effect of a change here is
// immediate, and the UI should not imply otherwise.

import type {
  CapabilityGrant,
  CapabilityScope,
} from "../specs/acl/grant/0.2/payload.js";

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
  "key-export",
  "persona-holder",
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
    "key-export",
  ],
  // Everything `admin` has except `policy-admin` and `key-export` — exporting a
  // key is gated separately from using it (VTI-VTA-003), and only `admin`
  // derives it.
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

/**
 * Capabilities **no role derives**, held only where an entry was granted them
 * by name. They do not narrow: an entry's effective set is its role's set
 * narrowed by the *other* names on it, and these are then added on top.
 *
 * `persona-holder` gates the persona pool, which sits above every trust
 * context; deriving it from `admin` would have handed it to every
 * context-scoped administrator. Granting one is super-admin-only at the agent,
 * a check on the *granter* this console cannot make, so the agent's refusal is
 * the authority there.
 */
export const ADDITIVE_CAPABILITIES: readonly AclCapability[] = ["persona-holder"];

export function isAdditiveCapability(name: string): boolean {
  return (ADDITIVE_CAPABILITIES as readonly string[]).includes(name);
}

export function isAclCapability(name: string): name is AclCapability {
  return (ACL_CAPABILITIES as readonly string[]).includes(name);
}

export function isAclRole(role: string): role is AclRole {
  return (ACL_ROLES as readonly string[]).includes(role);
}

/** The capability names a scope lists, split by whether each is additive. */
function grantNames(scope: CapabilityScope): { narrowing: string[]; additive: string[] } {
  if (scope.scope !== "listed") return { narrowing: [], additive: [] };
  return {
    // `additive` is read from the grant, not from this build's table: the
    // agent states it, and a name this build has never heard of may be one.
    narrowing: scope.grants.filter((g) => g.additive !== true).map((g) => g.capability),
    additive: scope.grants.filter((g) => g.additive === true).map((g) => g.capability),
  };
}

/** What an entry may actually do, and the working shown. */
export interface EffectiveCapabilities {
  /** The role's ceiling. */
  derived: readonly AclCapability[];
  /**
   * The ceiling intersected with the entry's own non-additive grants, plus the
   * additive grants it holds.
   */
  effective: readonly AclCapability[];
  /**
   * True when the entry holds its role's whole ceiling: `ceiling`, or a
   * `listed` scope whose non-additive grants name every capability the role
   * carries.
   *
   * The second case is not a stretch. This agent stores "the whole role plus
   * an additive grant" as one shape, and 0.2 has no spelling for that but the
   * role's ceiling enumerated beside the additive grant — so that is how it
   * renders an entry granted `persona-holder`. Reading it as "narrowed, 15 of
   * 15" would describe a decision nobody took.
   */
  unnarrowed: boolean;
  /** The additive grants the entry holds (also in `effective`). */
  additive: readonly AclCapability[];
  /**
   * Names in the scope this build does not recognise.
   *
   * They are absent from `effective` because the ceiling is what grants, and
   * this build's ceiling cannot contain a name it has never heard of. Surfaced
   * rather than dropped so a console can say "this agent is newer than this
   * console" instead of quietly showing an entry as holding less than it does.
   */
  unrecognised: readonly string[];
}

/**
 * What an entry holds: its role's set, as its capability scope narrows it.
 *
 * Returns `undefined` for a role this build does not know — **not** an empty
 * set. The two would render identically as "holds nothing", and one of them is
 * a lie about an entry that may hold everything. An unknown role means this
 * console is older than the agent, which is a thing to say out loud.
 */
export function effectiveCapabilities(
  role: string,
  scope: CapabilityScope,
): EffectiveCapabilities | undefined {
  if (!isAclRole(role)) return undefined;
  const derived = DERIVED_CAPABILITIES[role];
  if (scope.scope === "ceiling") {
    return { derived, effective: derived, unnarrowed: true, additive: [], unrecognised: [] };
  }
  if (scope.scope === "none") {
    // Narrowed to nothing — stated, so it reads as a decision. Not the same
    // answer as an unknown role, which this function never gives as `[]`.
    return { derived, effective: [], unnarrowed: derived.length === 0, additive: [], unrecognised: [] };
  }
  if (scope.scope !== "listed") {
    // A discriminant this build has never seen. Throwing, not guessing: every
    // guess is a statement about the entry's authority that nobody checked,
    // and the safe-looking one ("holds nothing") is a lie about an entry that
    // may hold everything.
    throw new Error(
      `unrecognised capability scope \`${String((scope as { scope: unknown }).scope)}\``,
    );
  }
  const { narrowing, additive: additiveNames } = grantNames(scope);
  const fromRole = derived.filter((c) => narrowing.includes(c));
  const additive = additiveNames.filter(isAclCapability);
  return {
    derived,
    effective: [...fromRole, ...additive],
    unnarrowed: fromRole.length === derived.length,
    additive,
    unrecognised: [...narrowing, ...additiveNames].filter((n) => !isAclCapability(n)),
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
 * An empty list passes: it names nothing to measure. Whether that is a
 * shape the agent can hold is {@link narrowingToSend}'s question.
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
  // Additive names are exempt, as they are at the agent: no role carries them,
  // so measuring them against one would refuse every grant. Whether *this
  // caller* may confer one is the agent's check, on the granter.
  const beyond = requested.filter(
    (n) =>
      !isAdditiveCapability(n) && !(DERIVED_CAPABILITIES[role] as readonly string[]).includes(n),
  );
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

/**
 * The capability scope to send when an editor keeps `kept` of a role's derived
 * set, for an entry whose stored scope is `stored`.
 *
 * The stored scope carries two things, and an editor over the role's set can
 * only see one of them. The additive grants are carried through untouched, so
 * narrowing an entry — or clearing its narrowing — never silently revokes its
 * `persona-holder`: `acl/update` **replaces** the capability scope, and a
 * `ceiling` sent over an entry holding an additive grant would drop it.
 *
 * That is also why clearing is not always `ceiling`. With an additive grant
 * held, the only 0.2 spelling of "the whole role plus this" is the role's
 * ceiling enumerated beside it — which pins the entry to today's ceiling, the
 * same trade the agent makes when it renders such an entry.
 *
 * Refuses the one edit this agent cannot hold: narrowing to **nothing** of the
 * role. 0.2 reads a listing naming only additive grants as "none of the role",
 * and `none` as nothing at all; the agent refuses both rather than store them,
 * because its store has no "nothing". Taking all of a role's authority away is
 * a role change, not a narrowing.
 */
export function narrowingToSend(
  role: string,
  kept: readonly string[],
  stored: CapabilityScope,
  intent: "narrow" | "clear",
): { ok: true; capabilities: CapabilityScope } | { ok: false; reason: string } {
  const heldAdditive = grantNames(stored).additive;
  const additiveGrants: CapabilityGrant[] = heldAdditive.map((capability) => ({
    capability,
    additive: true,
  }));
  if (intent === "clear") {
    if (additiveGrants.length === 0) return { ok: true, capabilities: { scope: "ceiling" } };
    if (!isAclRole(role)) {
      return {
        ok: false,
        reason:
          `unknown role \`${role}\`; this console cannot spell its ceiling beside the additive ` +
          `grants the entry holds, and a \`ceiling\` scope would revoke them`,
      };
    }
    return {
      ok: true,
      capabilities: {
        scope: "listed",
        grants: [
          ...DERIVED_CAPABILITIES[role].map((capability) => ({ capability })),
          ...additiveGrants,
        ] as [CapabilityGrant, ...CapabilityGrant[]],
      },
    };
  }
  const narrowing = kept.filter((n) => !isAdditiveCapability(n));
  if (narrowing.length === 0) {
    return {
      ok: false,
      reason:
        "a narrowing cannot keep nothing: your agent cannot hold an entry with none of its " +
        "role's capabilities, and refuses one. To take the role's authority away, change the role",
    };
  }
  const check = checkNarrowing(role, narrowing);
  if (!check.ok) return check;
  return {
    ok: true,
    capabilities: {
      scope: "listed",
      grants: [...narrowing.map((capability) => ({ capability })), ...additiveGrants] as [
        CapabilityGrant,
        ...CapabilityGrant[],
      ],
    },
  };
}
