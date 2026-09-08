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

import {
  TYPE_URI as KEYS_PRESENT,
  RESPONSE_TYPE_URI as KEYS_PRESENT_RESPONSE,
  type RoomsKeysPresentPayload,
  type RoomsKeysPresentResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/present/0.1/payload";
import {
  TYPE_URI as KEYS_CHAIN,
  RESPONSE_TYPE_URI as KEYS_CHAIN_RESPONSE,
  type RoomsKeysChainPayload,
  type RoomsKeysChainResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/chain/0.1/payload";

export interface RoomsPresentParams extends RoomsCaller {
  roomId: string;
  /** The action the presentation must confer, and no more. */
  action: RoomAction;
  /**
   * Who it is for — a host's DID.
   *
   * Optional on the wire and never omitted here: it is what stops a presentation
   * being replayed at a different host, and a caller that has one has no reason
   * to leave it out.
   */
  audience: string;
  /** A verifier-supplied freshness value, where one was offered. */
  nonce?: string;
}

/**
 * Ask this agent's own VTA for a presentation of the room's credentials.
 *
 * **Every host call needs one, and only this produces one.** The credentials
 * themselves never cross — the VTA holds them and hands back a presentation
 * bound to one operation, which is why `action` and `audience` are asked for
 * rather than defaulted: a presentation minted for `read` should not open a
 * `write`, and one minted for everything hands the caller the holder's whole
 * standing.
 *
 * `nonce` is optional because a room host does not issue one. Freshness there is
 * anchored by the request document's own proof and `issuedAt` — the host binds
 * the presentation to the DID that signed the envelope, so an observed
 * presentation is not replayable by anyone else. Pass a nonce when some other
 * verifier supplies one; its absence here is a property of the host, not an
 * omission.
 *
 * ## Why the answer is checked before it is returned
 *
 * The published schemas type the two ends of this value differently: this
 * response declares `presentation` as a bare open object, while every host task
 * `$ref`s `AuthorityPresentation`, whose `membership` and `authority` are
 * REQUIRED. So the type that comes back does not fit the parameter it exists to
 * fill, and the only ways past that are a blind cast or a check.
 *
 * A blind cast moves the failure: a presentation missing its chain reaches the
 * host and comes back "no authority chain presented; a room operation is
 * authorized by the chain" — an accusation aimed at the member, three hops from
 * the agent that actually produced the empty answer. Checking here names the
 * party that did.
 */
export async function roomsKeysPresent(
  sender: TrustTaskSender,
  params: RoomsPresentParams,
): Promise<{ presentation: Presentation; expiresAt?: string }> {
  // Built as a typed literal rather than spread-and-cast: the casts elsewhere in
  // this module hide a misspelled member, and this payload has three of them
  // whose names are easy to guess wrong (`nonce`, not `challenge`).
  const payload: RoomsKeysPresentPayload = {
    roomId: params.roomId,
    action: params.action,
    audience: params.audience,
    ...(params.nonce ? { nonce: params.nonce } : {}),
  };
  const res = await call<RoomsKeysPresentResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_PRESENT,
    KEYS_PRESENT_RESPONSE,
    "rooms/keys/present/0.1",
    payload,
  );

  const got = res.presentation as Partial<Presentation> | undefined;
  if (!got || typeof got.membership !== "string" || !Array.isArray(got.authority)) {
    throw new Error(
      `${params.service.did} returned a presentation for room ${params.roomId} with no ` +
        `membership credential or no authority chain. A host authorizes from the chain ` +
        `alone, so it would refuse this — and the refusal would read as if the member ` +
        `lacked authority rather than as an agent that answered incompletely.`,
    );
  }

  return {
    presentation: got as Presentation,
    ...(res.expiresAt ? { expiresAt: res.expiresAt } : {}),
  };
}

/**
 * Hand this agent's own VTA the rungs its principal fetched from the host.
 *
 * The last leg of a joining member's backfill, and the repair for a room that
 * reads only from the epoch its holder joined at. The VTA accrues a rung for
 * every membership change it lives through; this is for the history it did not.
 *
 * **The response is the answer worth having.** `earliestReadableEpoch` is not a
 * restatement of what was sent — a rung extends reach only if every rung above
 * it is present too, so a set with a gap in it is reported here rather than at
 * the first record that will not open, which reads like corruption.
 */
export async function roomsKeysChain(
  sender: TrustTaskSender,
  params: RoomsCaller & { roomId: string; links: EpochLink[] },
): Promise<RoomsKeysChainResponsePayload> {
  const payload: RoomsKeysChainPayload = {
    roomId: params.roomId,
    // `links` is `[EpochLink, ...EpochLink[]]` — the schema's `minItems: 1`. A
    // caller with nothing to deliver must not send an empty delivery, so the
    // narrowing is here rather than left to the agent to reject.
    links: params.links as RoomsKeysChainPayload["links"],
  };
  return call<RoomsKeysChainResponsePayload>(
    sender,
    { holder: params.holder, service: params.service },
    KEYS_CHAIN,
    KEYS_CHAIN_RESPONSE,
    "rooms/keys/chain/0.1",
    payload,
  );
}

// ── The host side ────────────────────────────────────────────────────────
//
// Everything below goes to the room's HOST and carries an authority
// presentation — the credentials the room issued, which is the only thing a
// host consults. Mint one with `roomsKeysPresent` above; nothing else in this
// library produces one, and a caller that has none cannot do these at all.
//
// **The browser console cannot call any of these, and that is a property of the
// extension rather than of this module.** Its bridge (`manager/carrier.ts`)
// passes exactly `{type, payload}` — so that the offscreen document mints and
// signs the envelope rather than counter-signing one composed in a page — and
// the background then addresses it to the wallet's own VTA. A `service` naming a
// host is therefore dropped, and the call lands at an agent that does not serve
// it. Nothing type-checks as wrong; it simply goes to the wrong party.
//
// A surface holding a channel to a host of its own — a server-side consumer, a
// CLI — uses these directly. A surface that only reaches its own agent asks the
// agent to make the call: `rooms/keys/backfill` and `rooms/owner/register`
// (trustoverip/dtgwg-trust-tasks-tf#402) exist for exactly that, and will appear
// above, in the VTA-terminating half, once they ship.

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
import {
  TYPE_URI as EPOCH_CHAIN,
  RESPONSE_TYPE_URI as EPOCH_CHAIN_RESPONSE,
  type RoomsEpochChainPayload,
  type RoomsEpochChainResponsePayload,
  type EpochLink,
} from "@openvtc/trust-tasks/rooms/epoch/chain/0.1/payload";

/** One rung of the epoch key chain: an epoch's storage key sealed under the next. */
export type { EpochLink };

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
 * Fetch the room's epoch key chain from its host.
 *
 * The first of the two hops that repair a member who can only read from where
 * they joined. This gets the rungs; [`roomsKeysChain`] hands them to the
 * member's own VTA, which is the only party that can say how far back they
 * actually reach.
 *
 * **Needs a `read` presentation, not a special one.** Reading the room and
 * reading the parts written earlier are the same act, so they take the same
 * grant — a separate one would be a grant nobody could explain.
 *
 * What comes back is ciphertext the host cannot read: a rung is an epoch's
 * storage key sealed under the next, and no host holds either. Serving them to a
 * party with no epoch key discloses only how many epochs there have been, which
 * the room's epoch number already said.
 */
export async function roomsEpochChain(
  sender: TrustTaskSender,
  params: RoomsHostCall & { fromEpoch?: number; limit?: number },
): Promise<EpochLink[]> {
  const { holder, service, ...rest } = params;
  const res = await call<RoomsEpochChainResponsePayload>(
    sender,
    { holder, service },
    EPOCH_CHAIN,
    EPOCH_CHAIN_RESPONSE,
    "rooms/epoch/chain/0.1",
    rest as unknown as RoomsEpochChainPayload,
  );
  return res.links ?? [];
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
