// The holder's own identity — `persona/*`, the half that sits ABOVE every
// trust context.
//
// ## Why this is here and not in `../persona/`
//
// `@openvtc/pnm-core/persona` is the **wallet's** half of this family, and it
// is deliberately incomplete: a wallet's holder identity is scoped to a
// context, so every task in this file would come back `e.p.msg.forbidden` if a
// wallet surface called it. That module says so in its own header, and CI greps
// the built extension bundles for the ten task URIs below to keep the statement
// true rather than merely written down.
//
// So this module is the other half, and it lives beside the console's other
// operator surface for the same reason `admin/acl.ts` does: the management
// console is the one browser surface that administers an agent rather than
// acting as one inside it. The guard in `ci.yml` now names `manager.js` as its
// single exception, exactly as the `admin/*` guard does — and every wallet
// surface keeps the property that guard was protecting.
//
// ## The gate
//
// The agent refuses all ten unless the caller is an **unscoped holder** —
// `Admin` *and* unrestricted scope (`require_super_admin`, not `role ==
// Admin`). That distinction is the whole design: an administrator scoped to one
// context who could read the pool would be reading identity data belonging to
// every *other* context, so they are refused here exactly as an application
// would be. `isUnscopedHolder` in the console's `use-vta.ts` is the client-side
// mirror, used to explain rather than to decide.
//
// ## The direction
//
// Nothing here reads *up* out of a context. `personaBindingSet` is the only
// call that touches both sides, and it writes **downwards**: it resolves an
// agent-scoped profile and pushes a materialised copy of the values into one
// context. A context never pulls, and there is no task in this file that would
// let it.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as ATTRIBUTE_PUT,
  RESPONSE_TYPE_URI as ATTRIBUTE_PUT_RESPONSE,
  type PersonaAttributePutPayload,
  type PersonaAttributePutResponsePayload,
} from "@openvtc/trust-tasks/persona/attribute/put/1.0/payload";
import {
  TYPE_URI as ATTRIBUTE_LIST,
  RESPONSE_TYPE_URI as ATTRIBUTE_LIST_RESPONSE,
  type PersonaAttributeListPayload,
  type PersonaAttributeListResponsePayload,
} from "@openvtc/trust-tasks/persona/attribute/list/1.0/payload";
import {
  TYPE_URI as ATTRIBUTE_DELETE,
  RESPONSE_TYPE_URI as ATTRIBUTE_DELETE_RESPONSE,
  type PersonaAttributeDeletePayload,
  type PersonaAttributeDeleteResponsePayload,
} from "@openvtc/trust-tasks/persona/attribute/delete/1.0/payload";
import {
  TYPE_URI as PROFILE_PUT,
  RESPONSE_TYPE_URI as PROFILE_PUT_RESPONSE,
  type PersonaProfilePutPayload,
  type PersonaProfilePutResponsePayload,
} from "@openvtc/trust-tasks/persona/profile/put/1.0/payload";
import {
  TYPE_URI as PROFILE_GET,
  RESPONSE_TYPE_URI as PROFILE_GET_RESPONSE,
  type PersonaProfileGetPayload,
  type PersonaProfileGetResponsePayload,
} from "@openvtc/trust-tasks/persona/profile/get/1.0/payload";
import {
  TYPE_URI as PROFILE_LIST,
  RESPONSE_TYPE_URI as PROFILE_LIST_RESPONSE,
  type PersonaProfileListPayload,
  type PersonaProfileListResponsePayload,
} from "@openvtc/trust-tasks/persona/profile/list/1.0/payload";
import {
  TYPE_URI as PROFILE_DELETE,
  RESPONSE_TYPE_URI as PROFILE_DELETE_RESPONSE,
  type PersonaProfileDeletePayload,
  type PersonaProfileDeleteResponsePayload,
} from "@openvtc/trust-tasks/persona/profile/delete/1.0/payload";
import {
  TYPE_URI as BINDING_SET,
  RESPONSE_TYPE_URI as BINDING_SET_RESPONSE,
  type PersonaBindingSetPayload,
  type PersonaBindingSetResponsePayload,
} from "@openvtc/trust-tasks/persona/binding/set/1.0/payload";
import {
  TYPE_URI as CORRELATION_ANALYZE,
  RESPONSE_TYPE_URI as CORRELATION_ANALYZE_RESPONSE,
  type PersonaCorrelationAnalyzePayload,
  type PersonaCorrelationAnalyzeResponsePayload,
} from "@openvtc/trust-tasks/persona/correlation/analyze/1.0/payload";
import {
  TYPE_URI as DISCLOSURE_HISTORY,
  RESPONSE_TYPE_URI as DISCLOSURE_HISTORY_RESPONSE,
  type PersonaDisclosureHistoryPayload,
  type PersonaDisclosureHistoryResponsePayload,
} from "@openvtc/trust-tasks/persona/disclosure/history/1.0/payload";

/**
 * The two DIDs an envelope names, and **no `contextId`**.
 *
 * The absence is the contract, not an omission. Every other family in this
 * module takes a context because its records live in one; the pool and the
 * profiles over it sit above all of them, and a parameter here would imply a
 * compartment they do not have. The one call that names a context —
 * {@link personaBindingSet} — takes it as an argument to the write, because it
 * is choosing where to push a copy.
 */
export interface PersonaHolderParams {
  holder: TaskParty;
  service: TaskParty;
}

/** One attribute in the pool. */
export type PoolAttribute = PersonaAttributeListResponsePayload["attributes"][number];
/** One profile — a whitelist projection over the pool. */
export type PoolProfile = PersonaProfileListResponsePayload["profiles"][number];
/** An entry in a profile: reference live, pinned, overridden, or inline. */
export type PoolProfileEntry = PoolProfile["entries"][number];
/** Where a value came from, and what that says about how it may be proved. */
export type AttributeProvenance = PersonaAttributePutPayload["provenance"];
/** What the value IS — the schema's own five. */
export type AttributeValueType = PersonaAttributePutPayload["valueType"];
/** One place the holder's identities link, and what can be done about it. */
export type CorrelationFinding = PersonaCorrelationAnalyzeResponsePayload["findings"][number];
/** One record of something that left, and to whom. */
export type DisclosureRecord = PersonaDisclosureHistoryResponsePayload["disclosures"][number];

async function holderCall<Req, Res>(
  sender: TrustTaskSender,
  params: PersonaHolderParams,
  type: string,
  responseType: string,
  label: string,
  payload: Req,
): Promise<Res> {
  const envelope = buildTrustTask(type, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<Res>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}

// ── The pool ────────────────────────────────────────────────────────────────

export interface AttributeListParams extends PersonaHolderParams {
  /**
   * A dotted prefix, compared over the raw bytes. The vocabulary is
   * most-general-segment-first for this reason — `phone` selects `phone.mobile`
   * and `phone.work` — and the agent MUST NOT interpret it further, so a prefix
   * ending mid-segment is a byte comparison like any other.
   */
  typePrefix?: string;
  /**
   * Return the values, not just the metadata.
   *
   * **Opt-in, and the default is the point.** Rendering a picker needs the type
   * and the label; asking for the values turns a listing into a read of the
   * holder's identity, and the agent decrypts every one to answer it.
   */
  includeValues?: boolean;
  /**
   * Include attributes whose backing credential can no longer be re-derived.
   * Defaults to *included* at the agent: a holder deciding what to present
   * needs to see that something went stale rather than have it quietly omitted.
   */
  includeStale?: boolean;
  limit?: PersonaAttributeListPayload["limit"];
  cursor?: PersonaAttributeListPayload["cursor"];
}

/** Enumerate the pool. Metadata only unless `includeValues` is set. */
export async function personaAttributeList(
  sender: TrustTaskSender,
  params: AttributeListParams,
): Promise<PoolAttribute[]> {
  const payload: PersonaAttributeListPayload = {
    ...(params.typePrefix !== undefined ? { typePrefix: params.typePrefix } : {}),
    ...(params.includeValues !== undefined ? { includeValues: params.includeValues } : {}),
    ...(params.includeStale !== undefined ? { includeStale: params.includeStale } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  const res = await holderCall<PersonaAttributeListPayload, PersonaAttributeListResponsePayload>(
    sender,
    params,
    ATTRIBUTE_LIST,
    ATTRIBUTE_LIST_RESPONSE,
    "persona/attribute/list/1.0",
    payload,
  );
  return res.attributes ?? [];
}

export interface AttributePutParams extends PersonaHolderParams {
  /** Omit to create. Supplying one addresses an existing attribute, which also
   *  makes a create idempotent. */
  attributeId?: string;
  /** The vocabulary token naming what this value IS — `name.legal`,
   *  `phone.mobile`. Dotted, most-general segment first. `x:` is an open
   *  extension namespace and an `x:` attribute behaves exactly like a known
   *  one. */
  type: string;
  valueType: AttributeValueType;
  /**
   * The fact itself. Must agree with `valueType`; the agent refuses a document
   * where it does not.
   *
   * Typed `unknown` deliberately. The published schema places no type
   * constraint on this member — a `string` attribute's value is a string — but
   * the TypeScript bindings render an unconstrained JSON member as an index
   * signature, so the generated payload type says "object". That is a codegen
   * artifact, not the contract (`vta-sdk`'s Rust mirror types it `Value`), and
   * typing callers into an object they would have to invent would make this
   * module the thing that is wrong. See the cast in the body, which is the only
   * place it happens.
   */
  value: unknown;
  /** The holder's own name for it — "work mobile", "the flat". */
  label?: string;
  provenance: AttributeProvenance;
  /** Optimistic concurrency: the attribute must be at exactly this version.
   *  The agent's conflict rejection carries its own view of the record, so a
   *  caller does not have to re-read to find out what it lost to. */
  expectedVersion?: number;
}

/**
 * Create or replace one attribute.
 *
 * The response's `correlation` is **advisory and computed after the write**.
 * The agent does not refuse on correlation grounds — the holder decides whether
 * two of their identities may share a value, and a maintainer that vetoed it
 * would be making that decision for them.
 */
export async function personaAttributePut(
  sender: TrustTaskSender,
  params: AttributePutParams,
): Promise<PersonaAttributePutResponsePayload> {
  const payload: PersonaAttributePutPayload = {
    type: params.type,
    valueType: params.valueType,
    // The one cast, explained on `AttributePutParams.value`.
    value: params.value as PersonaAttributePutPayload["value"],
    provenance: params.provenance,
    ...(params.attributeId !== undefined ? { attributeId: params.attributeId } : {}),
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
  };
  return holderCall<PersonaAttributePutPayload, PersonaAttributePutResponsePayload>(
    sender,
    params,
    ATTRIBUTE_PUT,
    ATTRIBUTE_PUT_RESPONSE,
    "persona/attribute/put/1.0",
    payload,
  );
}

export interface AttributeDeleteParams extends PersonaHolderParams {
  attributeId: string;
  /** Also remove the attribute from every profile that references it. Without
   *  it the agent refuses while a profile still names the attribute, because a
   *  profile silently projecting one fewer claim is a failure the holder
   *  discovers from the far side of a disclosure. */
  cascade?: boolean;
  expectedVersion?: number;
}

/** Delete an attribute. `existed: false` is a successful no-op, not a failure. */
export async function personaAttributeDelete(
  sender: TrustTaskSender,
  params: AttributeDeleteParams,
): Promise<PersonaAttributeDeleteResponsePayload> {
  const payload: PersonaAttributeDeletePayload = {
    attributeId: params.attributeId,
    ...(params.cascade !== undefined ? { cascade: params.cascade } : {}),
    ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
  };
  return holderCall<PersonaAttributeDeletePayload, PersonaAttributeDeleteResponsePayload>(
    sender,
    params,
    ATTRIBUTE_DELETE,
    ATTRIBUTE_DELETE_RESPONSE,
    "persona/attribute/delete/1.0",
    payload,
  );
}

// ── Profiles ────────────────────────────────────────────────────────────────

/** Every profile the holder has. Names and entries; never resolved values —
 *  see {@link personaProfileGet} for why there is no `resolve` here. */
export async function personaProfileList(
  sender: TrustTaskSender,
  params: PersonaHolderParams & { limit?: PersonaProfileListPayload["limit"]; cursor?: string },
): Promise<PoolProfile[]> {
  const payload: PersonaProfileListPayload = {
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  const res = await holderCall<PersonaProfileListPayload, PersonaProfileListResponsePayload>(
    sender,
    params,
    PROFILE_LIST,
    PROFILE_LIST_RESPONSE,
    "persona/profile/list/1.0",
    payload,
  );
  return res.profiles ?? [];
}

export interface ProfileGetParams extends PersonaHolderParams {
  profileId: string;
  /**
   * Resolve the entries into the values they project.
   *
   * **Opt-in because it is the disclosing answer, not merely the expensive
   * one** — it decrypts pool values and re-derives credential-backed ones.
   * `personaProfileList` offers no equivalent for the same reason: resolving
   * every profile at once would decrypt the holder's entire pool to answer a
   * question about names.
   *
   * A resolved entry is a claim, not a pool attribute: an `inline` one has no
   * `attributeId`, `version` or `updatedAt`, and their absence is what says the
   * value lives only in this profile.
   */
  resolve?: boolean;
}

/**
 * One profile.
 *
 * A missing profile is a rejection, never an empty success — a caller that
 * cannot tell "absent" from "empty" treats a typo as a profile that discloses
 * nothing.
 */
export async function personaProfileGet(
  sender: TrustTaskSender,
  params: ProfileGetParams,
): Promise<PersonaProfileGetResponsePayload> {
  const payload: PersonaProfileGetPayload = {
    profileId: params.profileId,
    ...(params.resolve !== undefined ? { resolve: params.resolve } : {}),
  };
  return holderCall<PersonaProfileGetPayload, PersonaProfileGetResponsePayload>(
    sender,
    params,
    PROFILE_GET,
    PROFILE_GET_RESPONSE,
    "persona/profile/get/1.0",
    payload,
  );
}

export interface ProfilePutParams extends PersonaHolderParams {
  /** Omit to create. */
  profileId?: string;
  name: string;
  /**
   * What this profile projects. **Omission is exclusion** — a profile is a
   * whitelist, because a blacklist over a growing pool leaks by default the
   * first time an attribute is added.
   */
  entries: PoolProfileEntry[];
  credentialRefs?: string[];
  expectedVersion?: number;
}

/** Create or replace a profile. */
export async function personaProfilePut(
  sender: TrustTaskSender,
  params: ProfilePutParams,
): Promise<PersonaProfilePutResponsePayload> {
  const payload: PersonaProfilePutPayload = {
    name: params.name,
    entries: params.entries,
    ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
    ...(params.credentialRefs !== undefined ? { credentialRefs: params.credentialRefs } : {}),
    ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
  };
  return holderCall<PersonaProfilePutPayload, PersonaProfilePutResponsePayload>(
    sender,
    params,
    PROFILE_PUT,
    PROFILE_PUT_RESPONSE,
    "persona/profile/put/1.0",
    payload,
  );
}

export interface ProfileDeleteParams extends PersonaHolderParams {
  profileId: string;
  /**
   * Unbind every persona presenting this profile, in every context, first.
   *
   * Without it the agent **refuses** while any persona is bound, and names them
   * in the rejection's details. That refusal is the useful half: a persona that
   * silently stopped presenting anything is a failure the holder discovers from
   * the far side of a disclosure that did not happen.
   */
  unbind?: boolean;
  expectedVersion?: number;
}

/** Delete a profile. */
export async function personaProfileDelete(
  sender: TrustTaskSender,
  params: ProfileDeleteParams,
): Promise<PersonaProfileDeleteResponsePayload> {
  const payload: PersonaProfileDeletePayload = {
    profileId: params.profileId,
    ...(params.unbind !== undefined ? { unbind: params.unbind } : {}),
    ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
  };
  return holderCall<PersonaProfileDeletePayload, PersonaProfileDeleteResponsePayload>(
    sender,
    params,
    PROFILE_DELETE,
    PROFILE_DELETE_RESPONSE,
    "persona/profile/delete/1.0",
    payload,
  );
}

// ── Bindings ────────────────────────────────────────────────────────────────

export interface BindingSetParams extends PersonaHolderParams {
  /** Where the materialised copy lands. An argument to the write, not a filter
   *  on it — see {@link PersonaHolderParams}. */
  contextId: string;
  /** Which persona presents. Two contexts holding the same persona DID hold two
   *  unrelated bindings. */
  personaDid: string;
  /** The profile it presents. **`null` unbinds** — distinct from omitting the
   *  member, which leaves the binding as it stands. */
  profileId?: string | null;
  /** Entry ids this binding may reveal without a per-disclosure decision. */
  publicEntries?: string[];
  expectedVersion?: number;
}

/**
 * Decide what one persona presents in one context.
 *
 * **The critical gate of the whole family, and the reason it is holder-only.**
 * An application able to call this could bind any profile to a persona it
 * controls and then read the values back through a disclosure it requests of
 * itself — every other holder-scoped task leaks, this one is directly
 * exploitable.
 *
 * It writes downwards: the agent resolves the profile here, above the boundary,
 * and pushes a *materialised copy* of the values into the context. The context
 * gets claims, never a pool reference, so nothing inside it can address the
 * pool afterwards.
 *
 * The response's `correlation` is worth surfacing: binding one profile to a
 * second persona makes them the same person by construction, and no later
 * narrowing undoes it for anyone who saw both.
 */
export async function personaBindingSet(
  sender: TrustTaskSender,
  params: BindingSetParams,
): Promise<PersonaBindingSetResponsePayload> {
  const payload: PersonaBindingSetPayload = {
    contextId: params.contextId,
    personaDid: params.personaDid,
    ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
    ...(params.publicEntries !== undefined ? { publicEntries: params.publicEntries } : {}),
    ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
  };
  return holderCall<PersonaBindingSetPayload, PersonaBindingSetResponsePayload>(
    sender,
    params,
    BINDING_SET,
    BINDING_SET_RESPONSE,
    "persona/binding/set/1.0",
    payload,
  );
}

// ── Reading across the whole of it ──────────────────────────────────────────

export interface CorrelationAnalyzeParams extends PersonaHolderParams {
  /** Narrow to one attribute. Omit both this and `candidate` to scan the pool. */
  attributeId?: string;
  profileId?: string;
  /**
   * A value the holder is *considering* and has not written.
   *
   * This is what makes the task a report rather than a guard: it can warn
   * before the mistake instead of after. A candidate is analysed and never
   * stored.
   */
  candidate?: PersonaCorrelationAnalyzePayload["candidate"];
}

/**
 * Where the holder's identities link.
 *
 * Holder-only because the response **is** the linkage map — the artifact this
 * whole family exists to keep anyone else from assembling. An empty `findings`
 * is a real answer: nothing in the pool correlates.
 *
 * Severity inverts intuition, and a caller rendering it should not "fix" that:
 * a credential presented whole correlates *more* than a self-asserted value,
 * because it carries an identical issuer signature to every verifier that sees
 * it, while a derived proof correlates less.
 */
export async function personaCorrelationAnalyze(
  sender: TrustTaskSender,
  params: CorrelationAnalyzeParams,
): Promise<CorrelationFinding[]> {
  const payload: PersonaCorrelationAnalyzePayload = {
    ...(params.attributeId !== undefined ? { attributeId: params.attributeId } : {}),
    ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
    ...(params.candidate !== undefined ? { candidate: params.candidate } : {}),
  };
  const res = await holderCall<
    PersonaCorrelationAnalyzePayload,
    PersonaCorrelationAnalyzeResponsePayload
  >(
    sender,
    params,
    CORRELATION_ANALYZE,
    CORRELATION_ANALYZE_RESPONSE,
    "persona/correlation/analyze/1.0",
    payload,
  );
  return res.findings ?? [];
}

export interface DisclosureHistoryParams extends PersonaHolderParams {
  /** Narrow to one context. **Omitting it queries across every context**, which
   *  is precisely why this task sits above the boundary. */
  contextId?: string;
  verifierDid?: string;
  attributeType?: string;
  /** RFC 3339. */
  since?: string;
  limit?: PersonaDisclosureHistoryPayload["limit"];
  cursor?: string;
}

/**
 * What has left, and to whom.
 *
 * Returns the whole response rather than just the array, because `nextCursor`
 * is the difference between "that is all of it" and "the agent stopped early" —
 * and a truncated disclosure history read as complete is the exact misreading a
 * disclosure history exists to prevent.
 */
export async function personaDisclosureHistory(
  sender: TrustTaskSender,
  params: DisclosureHistoryParams,
): Promise<PersonaDisclosureHistoryResponsePayload> {
  const payload: PersonaDisclosureHistoryPayload = {
    ...(params.contextId !== undefined ? { contextId: params.contextId } : {}),
    ...(params.verifierDid !== undefined ? { verifierDid: params.verifierDid } : {}),
    ...(params.attributeType !== undefined ? { attributeType: params.attributeType } : {}),
    ...(params.since !== undefined ? { since: params.since } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  return holderCall<PersonaDisclosureHistoryPayload, PersonaDisclosureHistoryResponsePayload>(
    sender,
    params,
    DISCLOSURE_HISTORY,
    DISCLOSURE_HISTORY_RESPONSE,
    "persona/disclosure/history/1.0",
    payload,
  );
}
