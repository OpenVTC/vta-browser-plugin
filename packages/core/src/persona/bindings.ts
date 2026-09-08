// `persona/binding/{get,list}/1.0` — which persona is presenting in this
// context, and under which profile.
//
// **Read-only here, and the write is missing on purpose.** `persona/binding/
// set` resolves an agent-scoped profile and pushes a materialised copy of its
// values down into the context; it therefore reads the pool, and the agent
// gates it on an unscoped holder credential. Deciding what a context sees is
// the holder's act, done from `pnm`. A wallet inside the context reads the
// result.
//
// The response is thin by construction: whether bound, the profile's label, a
// claim count, when. **Never the claim contents.** Those reach an application
// only through `persona/disclosure/*`, after a preview a human can be shown —
// a binding read that returned values would make that gate decorative.

import type { TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as BINDING_GET,
  RESPONSE_TYPE_URI as BINDING_GET_RESPONSE,
  type PersonaBindingGetPayload,
  type PersonaBindingGetResponsePayload,
} from "@openvtc/trust-tasks/persona/binding/get/1.0/payload";
import {
  TYPE_URI as BINDING_LIST,
  RESPONSE_TYPE_URI as BINDING_LIST_RESPONSE,
  type PersonaBindingListPayload,
  type PersonaBindingListResponsePayload,
} from "@openvtc/trust-tasks/persona/binding/list/1.0/payload";

import { collectPages } from "../util/pages.js";

import { call, type PersonaCallerParams } from "./call.js";

export type PersonaBinding = PersonaBindingGetResponsePayload;

export interface GetBindingParams extends PersonaCallerParams {
  personaDid: string;
}

/**
 * What one persona presents in this context.
 *
 * An unbound persona is an answer, not an error: `bound` is `false` and
 * `profileId` / `profileName` / `boundAt` are **absent**. Check `bound`, and do
 * not infer it from a missing `profileId` — the two would agree today and are
 * not the same question.
 */
export async function getBinding(
  sender: TrustTaskSender,
  params: GetBindingParams,
): Promise<PersonaBinding> {
  const payload: PersonaBindingGetPayload = {
    contextId: params.contextId,
    personaDid: params.personaDid,
  };
  return call<PersonaBindingGetPayload, PersonaBinding>(
    sender,
    params,
    BINDING_GET,
    BINDING_GET_RESPONSE,
    "persona/binding/get",
    payload,
  );
}

export interface ListBindingsParams extends PersonaCallerParams {
  limit?: PersonaBindingListPayload["limit"];
  cursor?: PersonaBindingListPayload["cursor"];
}

/**
 * Every persona present in this context — **to the end of the listing**.
 *
 * Not "every persona *bound*": the response carries `bound` per entry precisely
 * because an unbound persona is still present, and a caller deciding what a
 * context knows of the holder needs both kinds.
 *
 * The returned document carries no `nextCursor`, because there is nothing left
 * to fetch. That absence is the honest report of what this now does, and a
 * caller that used to ignore the member is correct by construction rather than
 * by luck — which is what it was before: two console surfaces read `.personas`
 * off the first page and drew the result as the whole truth.
 *
 * `limit` is the page size to ask for; `cursor` is where to start. Neither caps
 * the result.
 */
export async function listBindings(
  sender: TrustTaskSender,
  params: ListBindingsParams,
): Promise<PersonaBindingListResponsePayload> {
  const payload: PersonaBindingListPayload = {
    contextId: params.contextId,
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  const personas = await collectPages("persona/binding/list", async (cursor) => {
    const res = await call<PersonaBindingListPayload, PersonaBindingListResponsePayload>(
      sender,
      params,
      BINDING_LIST,
      BINDING_LIST_RESPONSE,
      "persona/binding/list",
      cursor === undefined ? payload : { ...payload, cursor },
    );
    return { items: res.personas ?? [], nextCursor: res.nextCursor };
  });
  return { personas };
}
