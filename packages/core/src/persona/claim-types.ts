// `persona/claim-types/list/1.0` — the claim-type registry, read from the agent
// rather than compiled in.
//
// ## Why this exists
//
// The console vendored this table, and the copy was *correct*. That is not the
// problem being solved. The problem is that a copy of a table two repositories
// do not own costs a re-sync pull request against each of them on every change
// — which is the argument `CLAIM-TYPES.md` §1 makes for the registry existing
// at all, applied one layer down — and that a compiled copy can only ever
// describe the tokens its own build knew about. An agent serving an extension
// type is invisible to a client that ships its own table.
//
// ## Resolution belongs here, not at the call site
//
// `resolveTreatment` is §4 in full, and the parts that look like detail are the
// parts that were got wrong before: the walk is on **dot boundaries**, it is a
// **proper** prefix, `x:` borrows nothing, and the prefix can only ever
// *tighten* against the floor. A caller that walked prefixes itself would have
// to get all four right, and the loosening direction fails quietly — an
// unregistered `name.somethingNew` inheriting `name`'s `none` is a value shown
// in the clear that the registry never said to show.
//
// The orderings come from the agent's `strictness`, not from a constant here.
// That is the half that makes "more protective wins" mean the same thing on
// both sides: a maintainer that adds a mask style stricter than `full` says so
// in the ordering it serves, and this resolves against it without a rebuild.

import type { TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as CLAIM_TYPES_LIST,
  RESPONSE_TYPE_URI as CLAIM_TYPES_LIST_RESPONSE,
  type PersonaClaimTypesListPayload,
  type PersonaClaimTypesListResponsePayload,
} from "@openvtc/trust-tasks/persona/claim-types/list/1.0/payload";

import { call, type PersonaCallerParams } from "./call.js";

/**
 * Who is asking, and of which agent — **without** a context.
 *
 * Every other task in this directory takes `PersonaCallerParams`, which
 * requires one. This task must not: its payload is empty, and the agent gates
 * it as reachable by any authenticated caller precisely so the two callers that
 * need it can both get it. Requiring a context here would refuse the holder's
 * own tooling, which has none to name — and a context invented to satisfy a
 * signature is a lie in an audit trail.
 */
export type ClaimTypesCaller = Omit<PersonaCallerParams, "contextId">;

export type ClaimTypeRegistry = PersonaClaimTypesListResponsePayload;
export type RegistryEntry = ClaimTypeRegistry["entries"][number];

/** How carefully a value is shown to its own holder, and how it is drawn. */
export interface ClaimTreatment {
  sensitivity: string;
  mask: string;
}

/**
 * Read the agent's claim-type registry.
 *
 * The response is a constant for a given agent, so a caller **may** hold it for
 * the life of a session, keyed on `registryVersion`. It **must not** be cached
 * across agents: two agents may serve different extension types, and a table
 * from one applied to the other resolves tokens it has never heard of.
 */
export async function listClaimTypes(
  sender: TrustTaskSender,
  params: ClaimTypesCaller,
): Promise<ClaimTypeRegistry> {
  return call<PersonaClaimTypesListPayload, ClaimTypeRegistry>(
    sender,
    params,
    CLAIM_TYPES_LIST,
    CLAIM_TYPES_LIST_RESPONSE,
    "persona/claim-types/list",
    {},
  );
}

/** The reverse-DNS `ext` key the agent reports its own configuration under —
 *  kept in lockstep with `vta-service`'s `handle_claim_types_list`. */
const EXT_KEY_CLAIM_TYPES = "org.openvtc.claim-types";

/** One claim type this deployment declared and its agent would not apply. */
export interface UnappliedClaimType {
  /** The token as the operator's file spelled it. */
  type: string;
  /** The agent's reason, in its words. */
  reason: string;
}

/** What the agent could not apply from its own configuration. */
export interface UnappliedReport {
  rejected: UnappliedClaimType[];
  /** Set when the extension file itself could not be read — a different
   *  sentence from a rejected row, because then *nothing* the deployment
   *  declared is in force. */
  fileError?: string;
}

/**
 * What this agent could not apply from its own claim-type file.
 *
 * **Why a client reads this at all.** A refused row is otherwise invisible: the
 * token resolves from the core table exactly as it would with no file, so an
 * operator's intended tightening is quietly not in force and the screen looks
 * completely normal. The agent reports its refusals precisely so somebody can
 * be told, and this is the half that tells them.
 *
 * Read defensively, member by member, because it is `ext` — a vendor-namespaced
 * object the schema does not constrain, so nothing upstream has checked its
 * shape. A malformed report is dropped rather than rendered: a banner built
 * from `undefined` is a second fault reported as the first.
 */
export function unappliedClaimTypes(registry: ClaimTypeRegistry | null): UnappliedReport {
  const none: UnappliedReport = { rejected: [] };
  const ext = registry?.ext as Record<string, unknown> | undefined;
  const report = ext?.[EXT_KEY_CLAIM_TYPES];
  if (!report || typeof report !== "object") return none;
  const { rejected, fileError } = report as { rejected?: unknown; fileError?: unknown };

  const rows = Array.isArray(rejected)
    ? rejected.filter(
        (r): r is UnappliedClaimType =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as { type?: unknown }).type === "string" &&
          typeof (r as { reason?: unknown }).reason === "string",
      )
    : [];

  return {
    rejected: rows,
    ...(typeof fileError === "string" ? { fileError } : {}),
  };
}

/** The open extension namespace. `ClaimType` in `persona-record.schema.json`. */
const EXTENSION_PREFIX = "x:";

/**
 * The more protective of two values on one axis, per the agent's ordering.
 *
 * A value the ordering does not contain is treated as **most** protective
 * rather than least. That is the unknown-value branch, and it is the difference
 * between showing a value and hiding it: a maintainer serving a style this
 * build has never heard of must not have it read as "no mask".
 */
function stricter(order: readonly string[], a: string, b: string): string {
  const rank = (v: string) => {
    const i = order.indexOf(v);
    return i === -1 ? -1 : i;
  };
  return rank(a) <= rank(b) ? a : b;
}

/**
 * How this type's values are treated — `CLAIM-TYPES.md` §4.
 *
 * Rule 1 — a holder's per-attribute override — is deliberately *not* here. It
 * belongs above this call, because "the holder decided" and "the registry says"
 * are different facts and a UI that wants to explain the difference needs both.
 */
export function resolveTreatment(
  registry: ClaimTypeRegistry,
  type: string,
): ClaimTreatment {
  const floor: ClaimTreatment = {
    sensitivity: registry.unregistered.sensitivity,
    mask: registry.unregistered.mask,
  };

  // Rule 4 taken first: `x:` is unregistered *by construction*, so it must
  // borrow neither an entry nor a family however much of a registered token it
  // happens to spell.
  if (type.startsWith(EXTENSION_PREFIX)) return floor;

  // Rule 2 — an exact entry, as written.
  const exact = registry.entries.find((e) => e.type === type);
  if (exact) return { sensitivity: exact.sensitivity, mask: exact.mask };

  // Rule 3 — the longest registered *proper* prefix, on dot boundaries only.
  // `payment` is a prefix of `payment.card`; `paymentology.card` is a member of
  // nothing.
  const segments = type.split(".");
  let prefix: RegistryEntry | undefined;
  for (let i = segments.length - 1; i > 0; i--) {
    const candidate = registry.entries.find(
      (e) => e.type === segments.slice(0, i).join("."),
    );
    if (candidate) {
      prefix = candidate;
      break;
    }
  }
  if (!prefix) return floor;

  // ...and it can only tighten. `payment.giftCard` inherits `payment`'s gating,
  // because a gated family must not be leavable by inventing a token; while
  // `name.somethingNew` does **not** inherit `name`'s `none`, because a family
  // entry cannot make an unknown token visible.
  return {
    sensitivity: stricter(
      registry.strictness.sensitivity ?? [],
      prefix.sensitivity,
      floor.sensitivity,
    ),
    mask: stricter(registry.strictness.mask ?? [], prefix.mask, floor.mask),
  };
}

/**
 * Whether the registry **declares** this token, or a family it belongs to.
 *
 * The same walk [`resolveTreatment`] performs, asked as a question — a caller
 * applying a holder's override needs it, because the floor and a declared
 * entry are different kinds of answer. An `x:` token is never registered, per
 * §4's last rule.
 */
export function isRegisteredType(registry: ClaimTypeRegistry, type: string): boolean {
  if (type.startsWith(EXTENSION_PREFIX)) return false;
  if (registry.entries.some((e) => e.type === type)) return true;
  const segments = type.split(".");
  for (let i = segments.length - 1; i > 0; i--) {
    const head = segments.slice(0, i).join(".");
    if (registry.entries.some((e) => e.type === head)) return true;
  }
  return false;
}

/**
 * The first segment of every registered token — the roots a UI may group by.
 *
 * Served rather than derived from a compiled list, so a family the agent knows
 * and this build does not still groups.
 */
export function registeredRoots(registry: ClaimTypeRegistry): ReadonlySet<string> {
  return new Set(registry.entries.map((e) => e.type.split(".")[0]!));
}
