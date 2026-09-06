// `persona/local/*` 1.0 — profiles and bindings that live INSIDE one context.
//
// For an identity the holder keeps only here, with no pool attribute behind
// it: a handle for one game, a display name for one workspace. Because nothing
// crosses the boundary to build one, these are the persona writes a
// context-scoped wallet may make.
//
// ## The entries are inline only, and that is the boundary
//
// A local profile's entries admit a single `inline` member — the `ref`, pinned
// and override forms of a pool profile are absent from the schema. A profile
// authored inside a context therefore has nowhere to name an attribute in the
// holder's pool. That is not a validation rule the agent applies on top of a
// permissive shape; it is the shape, which is why the same refusal happens in
// the type system here, in the agent, and in any other client generated from
// the same schema.
//
// To present a pool value in a context, the holder binds an agent-scoped
// profile with `pnm persona binding set`. The push comes from above; nothing
// here reaches up.
//
// ## A local value carries no provenance, which has a consequence
//
// The inline shape here is `{type, valueType, value, label?}` — narrower than
// a pool profile's inline entry, which also carries `provenance`. So a value
// authored in a context is self-asserted by construction: there is no way to
// mark one credential-backed, and therefore no way to present a
// credential-backed claim through a local profile at all. That route runs
// through the pool, where the holder authorizes it.
//
// Worth knowing rather than worked around. If a context ever needs to present
// an attested claim, the answer is a bound pool profile, not a member added
// here — adding one would let a context assert an issuer's authority over a
// value the issuer never saw.

import type { TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as LOCAL_PROFILE_PUT,
  RESPONSE_TYPE_URI as LOCAL_PROFILE_PUT_RESPONSE,
  type PersonaLocalProfilePutPayload,
  type PersonaLocalProfilePutResponsePayload,
} from "@openvtc/trust-tasks/persona/local/profile/put/1.0/payload";
import {
  TYPE_URI as LOCAL_PROFILE_GET,
  RESPONSE_TYPE_URI as LOCAL_PROFILE_GET_RESPONSE,
  type PersonaLocalProfileGetPayload,
  type PersonaLocalProfileGetResponsePayload,
} from "@openvtc/trust-tasks/persona/local/profile/get/1.0/payload";
import {
  TYPE_URI as LOCAL_PROFILE_LIST,
  RESPONSE_TYPE_URI as LOCAL_PROFILE_LIST_RESPONSE,
  type PersonaLocalProfileListPayload,
  type PersonaLocalProfileListResponsePayload,
} from "@openvtc/trust-tasks/persona/local/profile/list/1.0/payload";
import {
  TYPE_URI as LOCAL_PROFILE_DELETE,
  RESPONSE_TYPE_URI as LOCAL_PROFILE_DELETE_RESPONSE,
  type PersonaLocalProfileDeletePayload,
  type PersonaLocalProfileDeleteResponsePayload,
} from "@openvtc/trust-tasks/persona/local/profile/delete/1.0/payload";
import {
  TYPE_URI as LOCAL_BINDING_SET,
  RESPONSE_TYPE_URI as LOCAL_BINDING_SET_RESPONSE,
  type PersonaLocalBindingSetPayload,
  type PersonaLocalBindingSetResponsePayload,
} from "@openvtc/trust-tasks/persona/local/binding/set/1.0/payload";

import { call, type PersonaCallerParams } from "./call.js";

/** One line of a context-local profile. Inline only — see the module header. */
export type LocalProfileEntry = PersonaLocalProfilePutPayload["entries"][number];

export interface PutLocalProfileParams extends PersonaCallerParams {
  /** The holder's name for it. */
  name: string;
  /** Its values, carried in full. */
  entries: LocalProfileEntry[];
  /** Update an existing local profile, or make a create idempotent. */
  profileId?: PersonaLocalProfilePutPayload["profileId"];
  /** Require the profile to be at exactly this version. */
  expectedVersion?: PersonaLocalProfilePutPayload["expectedVersion"];
}

/** Create or update a context-local profile. */
export async function putLocalProfile(
  sender: TrustTaskSender,
  params: PutLocalProfileParams,
): Promise<PersonaLocalProfilePutResponsePayload> {
  const payload: PersonaLocalProfilePutPayload = {
    contextId: params.contextId,
    name: params.name,
    entries: params.entries,
    ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
    ...(params.expectedVersion !== undefined
      ? { expectedVersion: params.expectedVersion }
      : {}),
  };
  return call<
    PersonaLocalProfilePutPayload,
    PersonaLocalProfilePutResponsePayload
  >(
    sender,
    params,
    LOCAL_PROFILE_PUT,
    LOCAL_PROFILE_PUT_RESPONSE,
    "persona/local/profile/put",
    payload,
  );
}

export interface LocalProfileRef extends PersonaCallerParams {
  profileId: string;
}

/** Read one context-local profile. */
export async function getLocalProfile(
  sender: TrustTaskSender,
  params: LocalProfileRef,
): Promise<PersonaLocalProfileGetResponsePayload> {
  const payload: PersonaLocalProfileGetPayload = {
    contextId: params.contextId,
    profileId: params.profileId,
  };
  return call<
    PersonaLocalProfileGetPayload,
    PersonaLocalProfileGetResponsePayload
  >(
    sender,
    params,
    LOCAL_PROFILE_GET,
    LOCAL_PROFILE_GET_RESPONSE,
    "persona/local/profile/get",
    payload,
  );
}

export interface ListLocalProfilesParams extends PersonaCallerParams {
  limit?: PersonaLocalProfileListPayload["limit"];
  cursor?: PersonaLocalProfileListPayload["cursor"];
}

/** Enumerate this context's own profiles. */
export async function listLocalProfiles(
  sender: TrustTaskSender,
  params: ListLocalProfilesParams,
): Promise<PersonaLocalProfileListResponsePayload> {
  const payload: PersonaLocalProfileListPayload = {
    contextId: params.contextId,
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  return call<
    PersonaLocalProfileListPayload,
    PersonaLocalProfileListResponsePayload
  >(
    sender,
    params,
    LOCAL_PROFILE_LIST,
    LOCAL_PROFILE_LIST_RESPONSE,
    "persona/local/profile/list",
    payload,
  );
}

export interface DeleteLocalProfileParams extends LocalProfileRef {
  /**
   * Also clear any local binding pointing at it.
   *
   * Without this the delete is refused while a persona still presents under
   * the profile. A persona losing its face mid-relationship is not something
   * to do by omission.
   */
  unbind?: boolean;
}

/** Remove a context-local profile. */
export async function deleteLocalProfile(
  sender: TrustTaskSender,
  params: DeleteLocalProfileParams,
): Promise<PersonaLocalProfileDeleteResponsePayload> {
  const payload: PersonaLocalProfileDeletePayload = {
    contextId: params.contextId,
    profileId: params.profileId,
    ...(params.unbind === true ? { unbind: true } : {}),
  };
  return call<
    PersonaLocalProfileDeletePayload,
    PersonaLocalProfileDeleteResponsePayload
  >(
    sender,
    params,
    LOCAL_PROFILE_DELETE,
    LOCAL_PROFILE_DELETE_RESPONSE,
    "persona/local/profile/delete",
    payload,
  );
}

export interface SetLocalBindingParams extends PersonaCallerParams {
  personaDid: string;
  /**
   * The context-local profile to bind. **Omit to clear the binding** — after
   * which the persona presents nothing in this context until it is rebound.
   *
   * The agent refuses a `profileId` naming an agent-scoped profile: a context
   * cannot bind itself to something above the boundary, only the holder can
   * push one down.
   */
  profileId?: PersonaLocalBindingSetPayload["profileId"];
  expectedVersion?: PersonaLocalBindingSetPayload["expectedVersion"];
}

/** Bind a persona DID to a context-local profile, or clear the binding. */
export async function setLocalBinding(
  sender: TrustTaskSender,
  params: SetLocalBindingParams,
): Promise<PersonaLocalBindingSetResponsePayload> {
  const payload: PersonaLocalBindingSetPayload = {
    contextId: params.contextId,
    personaDid: params.personaDid,
    ...(params.profileId !== undefined ? { profileId: params.profileId } : {}),
    ...(params.expectedVersion !== undefined
      ? { expectedVersion: params.expectedVersion }
      : {}),
  };
  return call<
    PersonaLocalBindingSetPayload,
    PersonaLocalBindingSetResponsePayload
  >(
    sender,
    params,
    LOCAL_BINDING_SET,
    LOCAL_BINDING_SET_RESPONSE,
    "persona/local/binding/set",
    payload,
  );
}
