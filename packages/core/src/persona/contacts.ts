// `persona/contact/*` 1.0 — what other people have disclosed to the holder.
//
// The mirror image of the disclosure path: those tasks send the holder's
// identity out, these record what came back the other way. A contact is stored
// **as received** and is never merged into the holder's own attributes — that
// separation is the point. A contact is somebody else's account of themselves,
// not a fact the holder is asserting, and a store that blurred the two would
// let a peer's claim about their own name be re-presented as the holder's.
//
// Every contact is filed against `knownByPersona`: which of the holder's own
// faces knows this person. Required, not optional. A contact filed against no
// persona is one the holder cannot later reason about disclosing to, and
// "which of me does this person know" is exactly the question a wallet has to
// answer before it can answer anything else.
//
// **`put` writes a revision, not an overwrite.** The previous one is retained
// while anything still references it, so "what did they tell me in March"
// survives them changing their mind in April.

import type { TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as CONTACT_PUT,
  RESPONSE_TYPE_URI as CONTACT_PUT_RESPONSE,
  type PersonaContactPutPayload,
  type PersonaContactPutResponsePayload,
  type ContactDocument,
} from "@openvtc/trust-tasks/persona/contact/put/1.0/payload";
import {
  TYPE_URI as CONTACT_GET,
  RESPONSE_TYPE_URI as CONTACT_GET_RESPONSE,
  type PersonaContactGetPayload,
  type PersonaContactGetResponsePayload,
} from "@openvtc/trust-tasks/persona/contact/get/1.0/payload";
import {
  TYPE_URI as CONTACT_LIST,
  RESPONSE_TYPE_URI as CONTACT_LIST_RESPONSE,
  type PersonaContactListPayload,
  type PersonaContactListResponsePayload,
} from "@openvtc/trust-tasks/persona/contact/list/1.0/payload";
import {
  TYPE_URI as CONTACT_DELETE,
  RESPONSE_TYPE_URI as CONTACT_DELETE_RESPONSE,
  type PersonaContactDeletePayload,
  type PersonaContactDeleteResponsePayload,
} from "@openvtc/trust-tasks/persona/contact/delete/1.0/payload";

import { call, type PersonaCallerParams } from "./call.js";

export type { ContactDocument };

export interface PutContactParams extends PersonaCallerParams {
  /** The DID the disclosure came from. */
  subjectDid: string;
  /** Which of the holder's own personas knows this contact. */
  knownByPersona: string;
  /** What they disclosed, as received. */
  document: ContactDocument;
  /** Credentials received alongside it. */
  credentialRefs?: PersonaContactPutPayload["credentialRefs"];
  /** The holder's private annotation. Never disclosed. */
  notes?: string;
}

/** Record what a peer disclosed, as a new revision. */
export async function putContact(
  sender: TrustTaskSender,
  params: PutContactParams,
): Promise<PersonaContactPutResponsePayload> {
  const payload: PersonaContactPutPayload = {
    contextId: params.contextId,
    subjectDid: params.subjectDid,
    knownByPersona: params.knownByPersona,
    document: params.document,
    ...(params.credentialRefs !== undefined
      ? { credentialRefs: params.credentialRefs }
      : {}),
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
  };
  return call<PersonaContactPutPayload, PersonaContactPutResponsePayload>(
    sender,
    params,
    CONTACT_PUT,
    CONTACT_PUT_RESPONSE,
    "persona/contact/put",
    payload,
  );
}

export interface GetContactParams extends PersonaCallerParams {
  contactId: string;
  /** Read one specific revision instead of the current one. */
  rev?: PersonaContactGetPayload["rev"];
  /** Return every retained revision, so a holder can see what changed and when. */
  includeHistory?: boolean;
}

/** Read one contact. */
export async function getContact(
  sender: TrustTaskSender,
  params: GetContactParams,
): Promise<PersonaContactGetResponsePayload> {
  const payload: PersonaContactGetPayload = {
    contextId: params.contextId,
    contactId: params.contactId,
    ...(params.rev !== undefined ? { rev: params.rev } : {}),
    ...(params.includeHistory === true ? { includeHistory: true } : {}),
  };
  return call<PersonaContactGetPayload, PersonaContactGetResponsePayload>(
    sender,
    params,
    CONTACT_GET,
    CONTACT_GET_RESPONSE,
    "persona/contact/get",
    payload,
  );
}

export interface ListContactsParams extends PersonaCallerParams {
  /** Only contacts filed against this persona. */
  knownByPersona?: string;
  /** Only contacts whose current revision is newer than this (RFC 3339). */
  changedSince?: string;
  limit?: PersonaContactListPayload["limit"];
  cursor?: PersonaContactListPayload["cursor"];
}

/** Enumerate contacts in this context. */
export async function listContacts(
  sender: TrustTaskSender,
  params: ListContactsParams,
): Promise<PersonaContactListResponsePayload> {
  const payload: PersonaContactListPayload = {
    contextId: params.contextId,
    ...(params.knownByPersona !== undefined
      ? { knownByPersona: params.knownByPersona }
      : {}),
    ...(params.changedSince !== undefined
      ? { changedSince: params.changedSince }
      : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  return call<PersonaContactListPayload, PersonaContactListResponsePayload>(
    sender,
    params,
    CONTACT_LIST,
    CONTACT_LIST_RESPONSE,
    "persona/contact/list",
    payload,
  );
}

export interface DeleteContactParams extends PersonaCallerParams {
  contactId: string;
}

/** Forget a contact. */
export async function deleteContact(
  sender: TrustTaskSender,
  params: DeleteContactParams,
): Promise<PersonaContactDeleteResponsePayload> {
  const payload: PersonaContactDeletePayload = {
    contextId: params.contextId,
    contactId: params.contactId,
  };
  return call<PersonaContactDeletePayload, PersonaContactDeleteResponsePayload>(
    sender,
    params,
    CONTACT_DELETE,
    CONTACT_DELETE_RESPONSE,
    "persona/contact/delete",
    payload,
  );
}
