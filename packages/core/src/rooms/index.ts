// Data rooms — `rooms/*`.
//
// A room is a shared, credential-governed space: a set of records readable and
// writable by exactly the parties its credentials admit. Two things about the
// shape of this module follow from the design and are worth stating before the
// functions, because neither is guessable from the call signatures.
//
// ## Two services, and a call goes to exactly one of them
//
// `rooms/keys/*` go to the member's **own VTA**, which holds the group keys and
// opens and seals records. `rooms/{create,records,epoch,owner}/*` go to the
// room's **host**, which stores ciphertext it cannot read and authorises every
// operation against credentials the *room* issued — never against a list of its
// own. That is why a room can move hosts without reissuing anything, and it is
// why these helpers take `service` per call rather than binding one up front.
//
// The split is not cosmetic. Sealing a record and being allowed to store it are
// different questions asked of different parties: the VTA knows the key and
// nothing about the room's ACL; the host knows the credentials and cannot read a
// byte. A surface that wrote to a sealed room does both, in that order.
//
// ## Writing to a sealed room is two calls
//
//     roomsKeysSeal(vta, …)   → ciphertext
//     roomsRecordsPut(host, …) → stored
//
// and the `version` passed to the first must be the version the second will
// take, because it is bound into the ciphertext. Get it wrong and the record
// stores fine and never opens. `roomsWriteSealed` below does the pair correctly
// for the create-only case, which is the shape that works.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as KEYS_LIST,
  RESPONSE_TYPE_URI as KEYS_LIST_RESPONSE,
  type RoomsKeysListPayload,
  type RoomsKeysListResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/list/0.1/payload";
import {
  TYPE_URI as KEYS_OPEN,
  RESPONSE_TYPE_URI as KEYS_OPEN_RESPONSE,
  type RoomsKeysOpenPayload,
  type RoomsKeysOpenResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/open/0.1/payload";
import {
  TYPE_URI as KEYS_SEAL,
  RESPONSE_TYPE_URI as KEYS_SEAL_RESPONSE,
  type RoomsKeysSealPayload,
  type RoomsKeysSealResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/seal/0.1/payload";

/** Who is calling, and which service is being asked. */
export interface RoomsCaller {
  holder: TaskParty;
  /** The member's own VTA for `keys/*`; the room's host for everything else. */
  service: TaskParty;
}

async function call<Res>(
  sender: TrustTaskSender,
  parties: RoomsCaller,
  type: string,
  responseType: string,
  label: string,
  payload: unknown,
): Promise<Res> {
  const envelope = buildTrustTask(type, payload, {
    issuer: parties.holder.did,
    recipient: parties.service.did,
  });
  return sender.send<Res>(envelope, {
    expectedResponseType: responseType,
    operationLabel: label,
  });
}

/** One room this VTA can open. */
export type HeldRoom = RoomsKeysListResponsePayload["rooms"][number];

/**
 * The rooms this VTA holds keys for — **custody, not membership**.
 *
 * A room whose Welcome never arrived is absent even where a good membership
 * credential is held, and a VTA not yet told of a removal still lists a room it
 * can open but can no longer write to. Present this as what can be *read*, never
 * as authority to act: the host decides that, from credentials the room issued.
 *
 * Each entry carries two epochs and a surface wants both. `epoch` behind the
 * room's own means a commit has not been delivered; `earliestReadableEpoch`
 * equal to `epoch` means the chain has not arrived. Different repairs, and
 * without both a member reads "less than I expected" as loss rather than as a
 * delivery that has not happened.
 */
export async function roomsKeysList(
  sender: TrustTaskSender,
  parties: RoomsCaller,
): Promise<HeldRoom[]> {
  const res = await call<RoomsKeysListResponsePayload>(
    sender,
    parties,
    KEYS_LIST,
    KEYS_LIST_RESPONSE,
    "rooms/keys/list/0.1",
    {} satisfies RoomsKeysListPayload,
  );
  return res.rooms ?? [];
}

export interface RoomsOpenParams extends RoomsCaller {
  roomId: string;
  key: string;
  version: number;
  sealed: { ciphertext: string; nonce: string; epoch: number };
}

/**
 * Decrypt one sealed record. The key never crosses — ciphertext goes to the
 * VTA and plaintext comes back.
 *
 * A failure here is worth reading carefully rather than showing raw: the VTA
 * distinguishes "you are behind a commit" from "this history was severed or
 * never delivered", and the two have different repairs.
 */
export async function roomsKeysOpen(
  sender: TrustTaskSender,
  params: RoomsOpenParams,
): Promise<string> {
  const { holder, service, ...rest } = params;
  const res = await call<RoomsKeysOpenResponsePayload>(
    sender,
    { holder, service },
    KEYS_OPEN,
    KEYS_OPEN_RESPONSE,
    "rooms/keys/open/0.1",
    rest as unknown as RoomsKeysOpenPayload,
  );
  return res.plaintext;
}

export interface RoomsSealParams extends RoomsCaller {
  roomId: string;
  key: string;
  /**
   * The version the record will take — bound into the ciphertext, so it must
   * be the version the host is about to assign. For a create-only write that
   * is 1; for a rewrite, read the current version first.
   */
  version: number;
  /** The record body, base64url. */
  plaintext: string;
}

/** Seal a record body for storage. Does not write — see the module note. */
export async function roomsKeysSeal(
  sender: TrustTaskSender,
  params: RoomsSealParams,
): Promise<RoomsKeysSealResponsePayload["sealed"]> {
  const { holder, service, ...rest } = params;
  const res = await call<RoomsKeysSealResponsePayload>(
    sender,
    { holder, service },
    KEYS_SEAL,
    KEYS_SEAL_RESPONSE,
    "rooms/keys/seal/0.1",
    rest as unknown as RoomsKeysSealPayload,
  );
  return res.sealed;
}

// ── The host side ────────────────────────────────────────────────────────
//
// Everything below goes to the room's HOST and carries an authority
// presentation — the credentials the room issued, which is the only thing a
// host consults. `presentation` is passed through opaquely: this module does
// not mint credentials, and a caller that has none cannot do these.

import {
  TYPE_URI as ROOMS_CREATE,
  RESPONSE_TYPE_URI as ROOMS_CREATE_RESPONSE,
  type RoomsCreatePayload,
  type RoomsCreateResponsePayload,
} from "@openvtc/trust-tasks/rooms/create/0.1/payload";
import {
  TYPE_URI as RECORDS_LIST,
  RESPONSE_TYPE_URI as RECORDS_LIST_RESPONSE,
  type RoomsRecordsListPayload,
  type RoomsRecordsListResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/list/0.1/payload";
import {
  TYPE_URI as RECORDS_GET,
  RESPONSE_TYPE_URI as RECORDS_GET_RESPONSE,
  type RoomsRecordsGetPayload,
  type RoomsRecordsGetResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/get/0.1/payload";
import {
  TYPE_URI as RECORDS_PUT,
  RESPONSE_TYPE_URI as RECORDS_PUT_RESPONSE,
  type RoomsRecordsPutPayload,
  type RoomsRecordsPutResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/put/0.1/payload";
import {
  TYPE_URI as EPOCH_MINT,
  RESPONSE_TYPE_URI as EPOCH_MINT_RESPONSE,
  type RoomsEpochMintPayload,
  type RoomsEpochMintResponsePayload,
} from "@openvtc/trust-tasks/rooms/epoch/mint/0.1/payload";

/** The credentials a caller presents to a host. Opaque here. */
export type Presentation = RoomsRecordsListPayload["presentation"];

export interface RoomsHostCall extends RoomsCaller {
  roomId: string;
  presentation: Presentation;
}

/** Register a room with a host. The room's DID is minted before this call. */
export async function roomsCreate(
  sender: TrustTaskSender,
  params: RoomsCaller & {
    roomId: string;
    ownerDid: string;
    visibility: "open" | "attributed" | "private";
    retentionDays?: number;
  },
): Promise<RoomsCreateResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    ROOMS_CREATE,
    ROOMS_CREATE_RESPONSE,
    "rooms/create/0.1",
    rest as unknown as RoomsCreatePayload,
  );
}

/** Record metadata. Bodies come from `roomsRecordsGet`, one at a time. */
export async function roomsRecordsList(
  sender: TrustTaskSender,
  params: RoomsHostCall & { prefix?: string; sinceVersion?: number; limit?: number },
): Promise<RoomsRecordsListResponsePayload["records"]> {
  const { holder, service, ...rest } = params;
  const res = await call<RoomsRecordsListResponsePayload>(
    sender,
    { holder, service },
    RECORDS_LIST,
    RECORDS_LIST_RESPONSE,
    "rooms/records/list/0.1",
    rest as unknown as RoomsRecordsListPayload,
  );
  return res.records ?? [];
}

/** One record. On a sealed tier the body is ciphertext — open it with the VTA. */
export async function roomsRecordsGet(
  sender: TrustTaskSender,
  params: RoomsHostCall & { key: string },
): Promise<RoomsRecordsGetResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    RECORDS_GET,
    RECORDS_GET_RESPONSE,
    "rooms/records/get/0.1",
    rest as unknown as RoomsRecordsGetPayload,
  );
}

/** Store a record. `sealed` on the sealed tiers, `cleartext` on `open`. */
export async function roomsRecordsPut(
  sender: TrustTaskSender,
  params: RoomsHostCall & {
    key: string;
    expectedVersion?: number;
    sealed?: { ciphertext: string; nonce: string; epoch: number };
    cleartext?: { title?: string; description?: string; body: string; tags?: string[] };
  },
): Promise<RoomsRecordsPutResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    RECORDS_PUT,
    RECORDS_PUT_RESPONSE,
    "rooms/records/put/0.1",
    rest as unknown as RoomsRecordsPutPayload,
  );
}

/**
 * Renew the room by minting its next epoch. Needs `admin`.
 *
 * This is the whole lifecycle clock: a room in use renews itself in the course
 * of being used, and one nobody has committed to in a year has said something
 * real about itself. There is no separate "renew" verb and there should not be
 * — one that could be called without committing would let a room look live
 * while its key material stood still.
 */
export async function roomsEpochMint(
  sender: TrustTaskSender,
  params: RoomsHostCall & {
    epoch: number;
    link?: { epoch: number; wrapped: string; nonce: string };
    reason?: string;
  },
): Promise<RoomsEpochMintResponsePayload> {
  const { holder, service, ...rest } = params;
  return call(
    sender,
    { holder, service },
    EPOCH_MINT,
    EPOCH_MINT_RESPONSE,
    "rooms/epoch/mint/0.1",
    rest as unknown as RoomsEpochMintPayload,
  );
}

// ── Owner issuance ───────────────────────────────────────────────────────
//
// These go to the owner's own VTA, which signs AS the room with a key it
// holds. `signingKeyId` names that key — it is not looked up from `roomId`,
// because nothing maps a DID to the key it was minted with, and a mapping
// invented for convenience is a mapping that goes stale after a rotation.
//
// The pair you need comes from minting the room's DID: `vta/webvh/dids/create`
// with `template: "room"` returns both `did` and `signingKeyId`. Keep them
// together — the DID alone cannot issue anything.

import {
  TYPE_URI as OWNER_INVITE,
  RESPONSE_TYPE_URI as OWNER_INVITE_RESPONSE,
  type RoomsOwnerInvitePayload,
  type RoomsOwnerInviteResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/invite/0.1/payload";
import {
  TYPE_URI as OWNER_MEMBERSHIP,
  RESPONSE_TYPE_URI as OWNER_MEMBERSHIP_RESPONSE,
  type RoomsOwnerIssueMembershipPayload,
  type RoomsOwnerIssueMembershipResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/issue-membership/0.1/payload";
import {
  TYPE_URI as OWNER_AUTHORITY,
  RESPONSE_TYPE_URI as OWNER_AUTHORITY_RESPONSE,
  type RoomsOwnerIssueAuthorityPayload,
  type RoomsOwnerIssueAuthorityResponsePayload,
} from "@openvtc/trust-tasks/rooms/owner/issue-authority/0.1/payload";

/** What every issuance names: the room, and the key that signs as it. */
export interface RoomsIssueCall extends RoomsCaller {
  roomId: string;
  signingKeyId: string;
  subject: string;
  validUntil?: string;
}

/** A signed credential, and its id. */
export interface IssuedCredential {
  credential: string;
  credentialId: string;
}

/**
 * Mint an invitation. **Joining is consent, and this is the artefact.**
 *
 * Without it an owner seals a room key to somebody's agent and they are simply
 * in — holding keys to material they may not want, having agreed to nothing.
 * Single-use, and consumed on entry rather than presented per access, because
 * it names its subject and presenting it would disclose the member.
 */
export async function roomsOwnerInvite(
  sender: TrustTaskSender,
  params: RoomsIssueCall,
): Promise<IssuedCredential> {
  const { holder, service, ...rest } = params;
  return call<RoomsOwnerInviteResponsePayload>(
    sender,
    { holder, service },
    OWNER_INVITE,
    OWNER_INVITE_RESPONSE,
    "rooms/owner/invite/0.1",
    rest as unknown as RoomsOwnerInvitePayload,
  );
}

/**
 * Mint the membership credential a member presents on every operation.
 *
 * The host holds no roster, so **this credential is the membership**. Omitting
 * `validUntil` means it does not lapse — and removal is then an epoch advance
 * rather than an expiry, which is the honest mechanism: letting a credential
 * lapse stops a member presenting it and does not stop them reading what they
 * could already read.
 */
export async function roomsOwnerIssueMembership(
  sender: TrustTaskSender,
  params: RoomsIssueCall,
): Promise<IssuedCredential> {
  const { holder, service, ...rest } = params;
  return call<RoomsOwnerIssueMembershipResponsePayload>(
    sender,
    { holder, service },
    OWNER_MEMBERSHIP,
    OWNER_MEMBERSHIP_RESPONSE,
    "rooms/owner/issue-membership/0.1",
    rest as unknown as RoomsOwnerIssueMembershipPayload,
  );
}

/** What a grant may confer. `curate` is not implied by `write`. */
export type RoomAction = "read" | "write" | "curate" | "admin";

/**
 * Grant authority — a chain root at the room's scope.
 *
 * `admin` is the authority to mint epochs and hand the room on, so it is not a
 * larger `write`. A holder who wants to give an agent less than they hold does
 * not come back here: they attenuate their own grant, which needs no issuer and
 * is what makes a leaked agent capability not a leaked member capability.
 */
export async function roomsOwnerIssueAuthority(
  sender: TrustTaskSender,
  params: RoomsIssueCall & { actions: RoomAction[] },
): Promise<IssuedCredential> {
  const { holder, service, ...rest } = params;
  return call<RoomsOwnerIssueAuthorityResponsePayload>(
    sender,
    { holder, service },
    OWNER_AUTHORITY,
    OWNER_AUTHORITY_RESPONSE,
    "rooms/owner/issue-authority/0.1",
    rest as unknown as RoomsOwnerIssueAuthorityPayload,
  );
}
