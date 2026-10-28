// The holder's own marks on their contacts — a star, a petname, their lists, a
// link to a community directory entry (`persona/contact/put/1.2`,
// `persona/contact/list/1.1`) — and the lists themselves
// (`persona/contact/lists/put/1.1`, `list` and `delete` 1.0).
//
// Annotations are the holder's, and stay in the holder's agent: the agent sends
// them to nobody, and this module only ever talks to the agent. Changing one
// appends no revision to the contact.
//
// Three ways to reach a contact's annotations:
//   - **annotate** one the agent already keeps, by `contactId`;
//   - **link** a community directory member whose DID the holder has not been
//     shown — by their entry (`directoryRef`) and the persona that knows them —
//     which finds, or makes, the contact the agent keeps for that entry;
//   - a **filing** may carry them too (`putContact` in `./contacts.js` files
//     disclosures; this module does not re-file).

import type { TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as PUT,
  RESPONSE_TYPE_URI as PUT_RESPONSE,
  type PersonaContactPutPayload,
  type PersonaContactPutResponsePayload,
  type DirectoryRef,
} from "../specs/persona/contact/put/1.2/payload.js";
import {
  TYPE_URI as LIST,
  RESPONSE_TYPE_URI as LIST_RESPONSE,
  type PersonaContactListPayload,
  type PersonaContactListResponsePayload,
} from "../specs/persona/contact/list/1.1/payload.js";
import {
  TYPE_URI as LISTS_PUT,
  RESPONSE_TYPE_URI as LISTS_PUT_RESPONSE,
  type PersonaContactListsPutPayload,
  type PersonaContactListsPutResponsePayload,
} from "../specs/persona/contact/lists/put/1.1/payload.js";
import {
  TYPE_URI as LISTS_LIST,
  RESPONSE_TYPE_URI as LISTS_LIST_RESPONSE,
  type PersonaContactListsListPayload,
  type PersonaContactListsListResponsePayload,
} from "../specs/persona/contact/lists/list/1.0/payload.js";
import {
  TYPE_URI as LISTS_DELETE,
  RESPONSE_TYPE_URI as LISTS_DELETE_RESPONSE,
  type PersonaContactListsDeletePayload,
  type PersonaContactListsDeleteResponsePayload,
} from "../specs/persona/contact/lists/delete/1.0/payload.js";

import { call, type PersonaCallerParams } from "./call.js";

export type { DirectoryRef };

/** What one request changes. Each member given replaces the stored one; each
 *  `remove…` removes one; anything absent is unchanged. */
export interface AnnotationChange {
  starred?: boolean;
  petname?: string;
  removePetname?: true;
  /** Replaces the whole set. */
  lists?: string[];
  removeLists?: true;
  notes?: string;
  removeNotes?: true;
}

function changeMembers(c: AnnotationChange): Partial<PersonaContactPutPayload> {
  return {
    ...(c.starred !== undefined ? { starred: c.starred } : {}),
    ...(c.petname !== undefined ? { petname: c.petname } : {}),
    ...(c.removePetname ? { removePetname: true as const } : {}),
    ...(c.lists !== undefined && c.lists.length > 0 ? { lists: c.lists as never } : {}),
    // An empty set is "on no list", which the wire says one way.
    ...(c.removeLists || (c.lists !== undefined && c.lists.length === 0)
      ? { removeLists: true as const }
      : {}),
    ...(c.notes !== undefined ? { notes: c.notes } : {}),
    ...(c.removeNotes ? { removeNotes: true as const } : {}),
  };
}

export interface AnnotateContactParams extends PersonaCallerParams {
  contactId: string;
  change: AnnotationChange;
}

/** Change a contact's annotations. Appends no revision. */
export async function annotateContact(
  sender: TrustTaskSender,
  params: AnnotateContactParams,
): Promise<PersonaContactPutResponsePayload> {
  const payload = {
    contextId: params.contextId,
    contactId: params.contactId,
    ...changeMembers(params.change),
  } as PersonaContactPutPayload;
  return call(sender, params, PUT, PUT_RESPONSE, "persona/contact/put", payload);
}

export interface LinkContactParams extends PersonaCallerParams {
  /** The community directory entry. */
  directoryRef: DirectoryRef;
  /** Which of the holder's personas knows them — at a community, the
   *  identity the holder is a member as. */
  knownByPersona: string;
  change: AnnotationChange;
}

/** Find, or make, the contact the agent keeps for a directory entry, and
 *  change its annotations. Appends no revision. */
export async function linkContact(
  sender: TrustTaskSender,
  params: LinkContactParams,
): Promise<PersonaContactPutResponsePayload> {
  const payload = {
    contextId: params.contextId,
    knownByPersona: params.knownByPersona,
    directoryRef: params.directoryRef,
    ...changeMembers(params.change),
  } as PersonaContactPutPayload;
  return call(sender, params, PUT, PUT_RESPONSE, "persona/contact/put", payload);
}

export interface ListAnnotatedParams extends PersonaCallerParams {
  /** Only contacts linked to this community's directory. */
  directoryVtcDid?: string;
  starred?: boolean;
  listId?: string;
  knownByPersona?: string;
  cursor?: string;
  limit?: number;
}

/** One page of contact summaries with their annotations. */
export async function listAnnotated(
  sender: TrustTaskSender,
  params: ListAnnotatedParams,
): Promise<PersonaContactListResponsePayload> {
  const payload = {
    contextId: params.contextId,
    ...(params.directoryVtcDid !== undefined ? { directoryVtcDid: params.directoryVtcDid } : {}),
    ...(params.starred !== undefined ? { starred: params.starred } : {}),
    ...(params.listId !== undefined ? { listId: params.listId } : {}),
    ...(params.knownByPersona !== undefined ? { knownByPersona: params.knownByPersona } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  } as PersonaContactListPayload;
  return call(sender, params, LIST, LIST_RESPONSE, "persona/contact/list", payload);
}

/** Every summary a listing yields, following its cursor (at most `maxPages`). */
export async function listAllAnnotated(
  sender: TrustTaskSender,
  params: Omit<ListAnnotatedParams, "cursor">,
  maxPages = 20,
): Promise<PersonaContactListResponsePayload["contacts"]> {
  const out: PersonaContactListResponsePayload["contacts"] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await listAnnotated(sender, { ...params, ...(cursor ? { cursor } : {}), limit: 500 });
    out.push(...page.contacts);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export interface PutListParams extends PersonaCallerParams {
  /** Absent: create. */
  listId?: string;
  name?: string;
  /** `#rrggbb`, lowercase. */
  colour?: string;
  removeColour?: true;
  order?: number;
}

/** Create a list, or change one. */
export async function putList(
  sender: TrustTaskSender,
  params: PutListParams,
): Promise<PersonaContactListsPutResponsePayload> {
  const payload = {
    contextId: params.contextId,
    ...(params.listId !== undefined ? { listId: params.listId } : {}),
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.colour !== undefined ? { colour: params.colour } : {}),
    ...(params.removeColour ? { removeColour: true as const } : {}),
    ...(params.order !== undefined ? { order: params.order } : {}),
  } as PersonaContactListsPutPayload;
  return call(sender, params, LISTS_PUT, LISTS_PUT_RESPONSE, "persona/contact/lists/put", payload);
}

/** The holder's lists in this context, in their order. */
export async function listLists(
  sender: TrustTaskSender,
  params: PersonaCallerParams,
): Promise<PersonaContactListsListResponsePayload> {
  const payload: PersonaContactListsListPayload = { contextId: params.contextId, limit: 500 } as never;
  return call(sender, params, LISTS_LIST, LISTS_LIST_RESPONSE, "persona/contact/lists/list", payload);
}

/** Delete a list, taking it off every contact. */
export async function deleteList(
  sender: TrustTaskSender,
  params: PersonaCallerParams & { listId: string },
): Promise<PersonaContactListsDeleteResponsePayload> {
  const payload = { contextId: params.contextId, listId: params.listId } as PersonaContactListsDeletePayload;
  return call(sender, params, LISTS_DELETE, LISTS_DELETE_RESPONSE, "persona/contact/lists/delete", payload);
}
