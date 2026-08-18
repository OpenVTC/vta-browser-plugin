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
// **One divergence to know about.** The agent implements two things this
// version of the specification does not describe: a top-level `internal` member
// on `keys/create`, and a matching `internal` value for `KeyRecord.origin`
// (`vta-sdk`'s `KeyOrigin::Internal` — a key generated from the CSPRNG, absent
// from every backup, and by design **unrecoverable**). Since the schema's
// `KeyOrigin` is `"derived" | "imported"` and its create payload has no
// `internal`, both are modelled here as explicit extensions rather than
// smuggled in as `any`. If the spec catches up, these annotations disappear;
// until then they are the honest description of what the agent accepts.
//
// `keys/import` is not wrapped yet: its payload carries the private key in one
// of several mutually exclusive encodings, and offering it without a
// sealed-envelope helper would invite the cleartext one.

import type { Identity } from "../didcomm/index.js";
import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
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
 * false. `internal` is the VTA's extension: generated from the system CSPRNG,
 * in no backup and no export, and **recoverable by no means at all**. Losing
 * the keyspace loses the key and everything it authorises.
 */
export type KeyOrigin = "derived" | "imported" | "internal";

/** A key record, with the agent's `origin: "internal"` extension admitted. */
export type KeyRecord = Omit<SpecKeyRecord, "origin"> & { origin?: KeyOrigin };

export interface KeysCallerParams {
  /** Envelope `issuer` — the caller's DIDComm identity. */
  holder: Identity;
  /** The agent — envelope `recipient`. */
  service: RemoteDidcommEndpoint;
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
  /** Generate from the CSPRNG instead of the seed — unrecoverable by design.
   *  A VTA extension; see the note at the top of this file. */
  internal?: boolean;
}

/** Mint a key. Returns the realized record — public half only. */
export async function keysCreate(
  sender: TrustTaskSender,
  params: KeysCreateParams,
): Promise<KeyRecord> {
  const payload: KeysCreatePayload & { internal?: boolean } = {
    keyType: params.keyType,
    ...(params.derivationPath ? { derivationPath: params.derivationPath } : {}),
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
