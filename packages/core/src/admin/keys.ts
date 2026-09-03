// Key management — the canonical `keys/*` Trust Tasks.
//
// The surface behind `pnm keys …`: what an agent holds, what it will sign with,
// and what has been revoked. Private key material never crosses this boundary —
// the agent derives, holds and uses it, and returns public halves and
// signatures.
//
// Payload and response types come from `@openvtc/trust-tasks` (generated from
// the published schemas). This file owns the call layer only.
//
// **The two local extensions this file used to carry are gone.** `internal` on
// `keys/create` and `internal` as a `KeyRecord.origin` value were the agent's
// own, modelled here as explicit widenings of the generated types. The registry
// has since specified both — `KeysCreatePayload.internal` and
// `KeyOrigin = "derived" | "imported" | "internal"` — so the widenings were
// removed rather than left to be maintained. The note that stood here promised
// exactly that: "if the spec catches up, these annotations disappear".
//
// **`keysImport` carries private key material.** Three carriers, exactly one
// of which may be present: `sealed` (an armored bundle only the agent can
// open), `jwe`, or `multibase` — and the last is a **cleartext private key**.
// The schema's one-of constraint does not survive into the generated type, so
// the parameter type enforces it here; the cleartext warning cannot be
// enforced by any type and is stated where a caller will read it.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as KEYS_CREATE,
  RESPONSE_TYPE_URI as KEYS_CREATE_RESPONSE,
  type KeysCreatePayload,
  type KeysCreateResponsePayload,
  type KeyType,
} from "@openvtc/trust-tasks/keys/create/0.1/payload";
import {
  TYPE_URI as KEYS_LIST,
  RESPONSE_TYPE_URI as KEYS_LIST_RESPONSE,
  type KeysListPayload,
  type KeysListResponsePayload,
} from "@openvtc/trust-tasks/keys/list/0.1/payload";
import {
  TYPE_URI as KEYS_SHOW,
  RESPONSE_TYPE_URI as KEYS_SHOW_RESPONSE,
  type KeysShowResponsePayload,
  type KeyRecord as SpecKeyRecord,
  type KeyOrigin,
  type KeyStatus,
} from "@openvtc/trust-tasks/keys/show/0.1/payload";
import {
  TYPE_URI as KEYS_RENAME,
  RESPONSE_TYPE_URI as KEYS_RENAME_RESPONSE,
  type KeysRenameResponsePayload,
} from "@openvtc/trust-tasks/keys/rename/0.1/payload";
import {
  TYPE_URI as KEYS_REVOKE,
  RESPONSE_TYPE_URI as KEYS_REVOKE_RESPONSE,
  type KeysRevokePayload,
  type KeysRevokeResponsePayload,
} from "@openvtc/trust-tasks/keys/revoke/0.1/payload";
import {
  TYPE_URI as KEYS_IMPORT,
  RESPONSE_TYPE_URI as KEYS_IMPORT_RESPONSE,
  type KeysImportPayload,
  type KeysImportResponsePayload,
} from "@openvtc/trust-tasks/keys/import/0.1/payload";
import {
  TYPE_URI as KEYS_DERIVE_SIGN,
  RESPONSE_TYPE_URI as KEYS_DERIVE_SIGN_RESPONSE,
  type KeysDeriveAndSignPayload,
  type KeysDeriveAndSignResponsePayload,
} from "@openvtc/trust-tasks/keys/derive-and-sign/0.1/payload";
import {
  TYPE_URI as KEYS_DERIVE_SIGN_DOC,
  RESPONSE_TYPE_URI as KEYS_DERIVE_SIGN_DOC_RESPONSE,
  type KeysDeriveAndSignDocumentPayload,
  type KeysDeriveAndSignDocumentResponsePayload,
} from "@openvtc/trust-tasks/keys/derive-and-sign-document/0.1/payload";
import {
  TYPE_URI as KEYS_SIGN,
  RESPONSE_TYPE_URI as KEYS_SIGN_RESPONSE,
  type KeysSignPayload,
  type KeysSignResponsePayload,
  type SignAlgorithm,
} from "@openvtc/trust-tasks/keys/sign/0.1/payload";

export type { KeyType, KeyStatus, SignAlgorithm };

/**
 * Where a key came from, and what that costs.
 *
 * `derived` keys come from the BIP-39 master seed, which is what makes an agent
 * recoverable — and also what makes "the operator cannot obtain this key"
 * false. `internal` is generated from the system CSPRNG: in no backup and no
 * export, and **recoverable by no means at all**. Losing the keyspace loses the
 * key and everything it authorises.
 */
export type { KeyOrigin };

export type KeyRecord = SpecKeyRecord;

export interface KeysCallerParams {
  /** Envelope `issuer` — the caller's DIDComm identity. */
  holder: TaskParty;
  /** The agent — envelope `recipient`. */
  service: TaskParty;
}

export interface KeysCreateParams extends KeysCallerParams {
  keyType: KeyType;
  /** BIP-32 path to derive at. Optional per the schema: omitting it leaves the
   *  choice to the agent. */
  derivationPath?: string;
  /**
   * BIP-39 phrase to derive from instead of the agent's own seed.
   *
   * The schema is emphatic, and it is worth repeating at the call site: this
   * member is secret-bearing in a way the rest of the payload is not — the
   * phrase reconstitutes the key anywhere. Do not send it over a transport that
   * is not end-to-end confidential, and do not log it.
   */
  mnemonic?: string;
  label?: string;
  contextId?: string;
  /**
   * Durable identifier to give the new key.
   *
   * Optional in the schema, and for a *derived* key the agent defaults it to
   * `derivationPath`. **It is not optional in practice for `internal: true`**:
   * such a key is derived from no seed and records no path, so there is nothing
   * for the agent to name it after. That gap is why the member was added to
   * `keys/create/0.1` in the first place (dtgwg-trust-tasks-tf#275), and it is
   * what `vta-sdk` 0.30.0 was cut for.
   */
  keyId?: string;
  /** Generate from the CSPRNG instead of the seed — unrecoverable by design.
   *  Pair it with {@link KeysCreateParams.keyId}. */
  internal?: boolean;
}

/** Mint a key. Returns the realized record — public half only. */
export async function keysCreate(
  sender: TrustTaskSender,
  params: KeysCreateParams,
): Promise<KeyRecord> {
  const payload: KeysCreatePayload = {
    keyType: params.keyType,
    ...(params.derivationPath ? { derivationPath: params.derivationPath } : {}),
    ...(params.keyId ? { keyId: params.keyId } : {}),
    ...(params.mnemonic ? { mnemonic: params.mnemonic } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.contextId ? { contextId: params.contextId } : {}),
    // `!== undefined`, not truthiness: `internal: false` is a caller saying
    // "derive it, keep it recoverable", and dropping it would let the agent's
    // default decide the one thing this flag exists to decide.
    ...(params.internal !== undefined ? { internal: params.internal } : {}),
  };
  const envelope = buildTrustTask(KEYS_CREATE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<KeysCreateResponsePayload>(envelope, {
    expectedResponseType: KEYS_CREATE_RESPONSE,
    operationLabel: "keys/create/0.1",
  });
  return res.key as KeyRecord;
}

export interface KeysListParams extends KeysCallerParams {
  offset?: number;
  limit?: number;
  status?: KeyStatus;
  contextId?: string;
}

export interface KeysListResult {
  keys: KeyRecord[];
  /** Total matching the filter, not the length of `keys` — page with `offset`. */
  total: number;
  offset: number;
  limit: number;
}

/** List keys, filtered and paged. */
export async function keysList(
  sender: TrustTaskSender,
  params: KeysListParams,
): Promise<KeysListResult> {
  const payload: KeysListPayload = {
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.contextId ? { contextId: params.contextId } : {}),
  };
  const envelope = buildTrustTask(KEYS_LIST, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<KeysListResponsePayload>(envelope, {
    expectedResponseType: KEYS_LIST_RESPONSE,
    operationLabel: "keys/list/0.1",
  });
  return {
    keys: (res.keys ?? []) as KeyRecord[],
    total: res.total ?? 0,
    offset: res.offset ?? 0,
    limit: res.limit ?? 0,
  };
}

export interface KeysShowParams extends KeysCallerParams {
  keyId: string;
}

/**
 * Fetch one key.
 *
 * Resolves to `null` for a key the agent does not hold — a successful response
 * carrying no record, not a rejection, so callers distinguish "no such key"
 * from "the request failed" without inspecting an error.
 */
export async function keysShow(
  sender: TrustTaskSender,
  params: KeysShowParams,
): Promise<KeyRecord | null> {
  const envelope = buildTrustTask(
    KEYS_SHOW,
    { keyId: params.keyId },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  const res = await sender.send<KeysShowResponsePayload>(envelope, {
    expectedResponseType: KEYS_SHOW_RESPONSE,
    operationLabel: "keys/show/0.1",
  });
  return (res.key ?? null) as KeyRecord | null;
}

export interface KeysRenameParams extends KeysCallerParams {
  keyId: string;
  /** The identifier the key takes. This renames the *id*, not the label —
   *  anything referencing the old id stops resolving. */
  newKeyId: string;
}

export async function keysRename(
  sender: TrustTaskSender,
  params: KeysRenameParams,
): Promise<KeysRenameResponsePayload> {
  const envelope = buildTrustTask(
    KEYS_RENAME,
    { keyId: params.keyId, newKeyId: params.newKeyId },
    { issuer: params.holder.did, recipient: params.service.did },
  );
  return sender.send<KeysRenameResponsePayload>(envelope, {
    expectedResponseType: KEYS_RENAME_RESPONSE,
    operationLabel: "keys/rename/0.1",
  });
}

export interface KeysRevokeParams extends KeysCallerParams {
  keyId: string;
  reason?: string;
}

/** Revoke a key. The record survives with `status: "revoked"` — revocation is
 *  a state, not a deletion, so an audit of what signed what stays answerable. */
export async function keysRevoke(
  sender: TrustTaskSender,
  params: KeysRevokeParams,
): Promise<KeysRevokeResponsePayload> {
  const payload: KeysRevokePayload = {
    keyId: params.keyId,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  const envelope = buildTrustTask(KEYS_REVOKE, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<KeysRevokeResponsePayload>(envelope, {
    expectedResponseType: KEYS_REVOKE_RESPONSE,
    operationLabel: "keys/revoke/0.1",
  });
}

export interface KeysSignParams extends KeysCallerParams {
  keyId: string;
  /** The bytes to sign, base64. The agent signs what it is given and cannot
   *  tell you what you are signing — a UI that shows the operator something
   *  must derive that from the payload it built, never from the agent. */
  payload: string;
  algorithm: SignAlgorithm;
}

/** Sign with a key the agent holds. The private half never leaves it. */
export async function keysSign(
  sender: TrustTaskSender,
  params: KeysSignParams,
): Promise<KeysSignResponsePayload> {
  const payload: KeysSignPayload = {
    keyId: params.keyId,
    payload: params.payload,
    algorithm: params.algorithm,
  };
  const envelope = buildTrustTask(KEYS_SIGN, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<KeysSignResponsePayload>(envelope, {
    expectedResponseType: KEYS_SIGN_RESPONSE,
    operationLabel: "keys/sign/0.1",
  });
}

/**
 * Import an externally-generated key.
 *
 * **Exactly one carrier**, and they are not equivalent:
 *
 * - `sealed` — an armored bundle encrypted to the agent. The safe form: the
 *   key is unreadable in transit and at rest in any log that captured the
 *   request.
 * - `jwe` — a JWE the agent can decrypt.
 * - `multibase` — the **private key in cleartext**. It is in the payload, so
 *   it is in anything that touched the payload: proxy logs, a browser's
 *   network panel, an error report that echoed the request. Use it only on a
 *   transport you control end to end, and prefer `sealed` everywhere else.
 *
 * The union is enforced by this parameter type. The schema states it too, but
 * as a `oneOf` that does not survive into the generated TypeScript, so without
 * this a caller could send two carriers and have the agent decide which one
 * counts.
 */
export type KeysImportParams = KeysCallerParams & {
  keyType: KeyType;
  label?: string;
  contextId?: string;
} & (
    | { sealed: string; jwe?: never; multibase?: never }
    | { jwe: string; sealed?: never; multibase?: never }
    | { multibase: string; sealed?: never; jwe?: never }
  );

export async function keysImport(
  sender: TrustTaskSender,
  params: KeysImportParams,
): Promise<KeyRecord> {
  const payload: KeysImportPayload = {
    keyType: params.keyType,
    ...(params.sealed !== undefined ? { privateKeySealed: params.sealed } : {}),
    ...(params.jwe !== undefined ? { privateKeyJwe: params.jwe } : {}),
    ...(params.multibase !== undefined ? { privateKeyMultibase: params.multibase } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.contextId ? { contextId: params.contextId } : {}),
  };
  const envelope = buildTrustTask(KEYS_IMPORT, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  const res = await sender.send<KeysImportResponsePayload>(envelope, {
    expectedResponseType: KEYS_IMPORT_RESPONSE,
    operationLabel: "keys/import/0.1",
  });
  return res.key as KeyRecord;
}

export interface KeysDeriveAndSignParams extends KeysCallerParams {
  keyType: KeyType;
  /** BIP-32 path. The key is derived for this signature and not stored. */
  derivationPath: string;
  /** The bytes to sign, base64. */
  payload: string;
  algorithm: SignAlgorithm;
}

/**
 * Derive a key at a path, sign with it, and keep nothing.
 *
 * Different from {@link keysSign} in a way worth knowing: there is no key
 * record afterwards, so nothing lists it and nothing can revoke it. What ties
 * the signature to the agent is the returned `publicKey` and the seed the path
 * derives from — an audit answers "who signed this" by re-deriving, not by
 * looking it up.
 */
export async function keysDeriveAndSign(
  sender: TrustTaskSender,
  params: KeysDeriveAndSignParams,
): Promise<KeysDeriveAndSignResponsePayload> {
  const payload: KeysDeriveAndSignPayload = {
    keyType: params.keyType,
    derivationPath: params.derivationPath,
    payload: params.payload,
    algorithm: params.algorithm,
  };
  const envelope = buildTrustTask(KEYS_DERIVE_SIGN, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<KeysDeriveAndSignResponsePayload>(envelope, {
    expectedResponseType: KEYS_DERIVE_SIGN_RESPONSE,
    operationLabel: "keys/derive-and-sign/0.1",
  });
}

export interface KeysDeriveAndSignDocumentParams extends KeysCallerParams {
  keyType: KeyType;
  derivationPath: string;
  /** The document to sign. Returned with its proof attached. */
  document: KeysDeriveAndSignDocumentPayload["document"];
  /** Data Integrity proof purpose, e.g. `assertionMethod`. */
  proofPurpose?: string;
}

/** Derive a key and attach a Data Integrity proof to a document. Returns the
 *  signed document and the `signerDid` a verifier resolves to check it. */
export async function keysDeriveAndSignDocument(
  sender: TrustTaskSender,
  params: KeysDeriveAndSignDocumentParams,
): Promise<KeysDeriveAndSignDocumentResponsePayload> {
  const payload: KeysDeriveAndSignDocumentPayload = {
    keyType: params.keyType,
    derivationPath: params.derivationPath,
    document: params.document,
    ...(params.proofPurpose ? { proofPurpose: params.proofPurpose } : {}),
  };
  const envelope = buildTrustTask(KEYS_DERIVE_SIGN_DOC, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<KeysDeriveAndSignDocumentResponsePayload>(envelope, {
    expectedResponseType: KEYS_DERIVE_SIGN_DOC_RESPONSE,
    operationLabel: "keys/derive-and-sign-document/0.1",
  });
}
