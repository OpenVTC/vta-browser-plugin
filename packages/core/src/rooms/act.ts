// Acting in a room **as the member** — `rooms/keys/act/0.1` and
// `rooms/keys/seal/0.2` with `signAsPrincipal`.
//
// ## The member is the persona, never this wallet
//
// A room admitted the member's **persona**: a DID their VTA holds for them in a
// trust context, the subject of their membership and authority credentials. The
// wallet holds a key of its own and none of the persona's. So the wallet never
// reaches a host as itself. It builds each host-bound room request **unsigned**
// — no presentation, no proof — and hands it to the member's VTA, which
// completes it as the persona: the persona's own authority narrowed to the one
// action the request's type needs, the persona as `issuer`, the persona's
// signature. The wallet then sends the result to the host unchanged. The host
// sees the persona as presenter, signer and, on an `attributed` room, author,
// and nothing of the wallet or the VTA. That is the CLI's flow
// (`vta-cli-common::commands::rooms`, `act_and_send`), step for step.
//
// The same holds for a sealed record's body: it is built without a proof, with
// the persona as `author`, and the VTA signs it as the persona for
// `assertionMethod` before sealing it (`rooms/keys/seal/0.2`, `signAsPrincipal`).
//
// ## Two recipients
//
// `act` and `seal` go to the member's own **VTA**, over the wallet's ordinary
// channel to it. The completed document goes to the room's **host** over HTTPS
// (`CompletedDocumentSender`) — a document signed by the persona rides HTTPS
// only, because a DIDComm or TSP consumer requires the sender to be the signer,
// and the wallet's socket is the wallet's.
//
// `act` is not a signing oracle: the VTA completes only the specification's
// table of host-bound room requests, never an ownership change, a
// `rooms/create` or a chunk upload.

import { base64url } from "@openvtc/vti-didcomm-js";

import type { SendOpts, TaskParty, TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";

import {
  TYPE_URI as KEYS_ACT,
  RESPONSE_TYPE_URI as KEYS_ACT_RESPONSE,
  type RoomsKeysActPayload,
  type RoomsKeysActResponsePayload,
  type UnsignedRoomRequest,
} from "@openvtc/trust-tasks/rooms/keys/act/0.1/payload";
import {
  TYPE_URI as KEYS_ACT_V5,
  RESPONSE_TYPE_URI as KEYS_ACT_V5_RESPONSE,
} from "@openvtc/trust-tasks/rooms/keys/act/0.5/payload";
import {
  TYPE_URI as KEYS_SEAL_V2,
  RESPONSE_TYPE_URI as KEYS_SEAL_V2_RESPONSE,
  type RoomsKeysSealPayload as RoomsKeysSealV2Payload,
  type RoomsKeysSealResponsePayload as RoomsKeysSealV2ResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/seal/0.2/payload";
import {
  TYPE_URI as INFO,
  RESPONSE_TYPE_URI as INFO_RESPONSE,
  type RoomsInfoResponsePayload,
} from "@openvtc/trust-tasks/rooms/info/0.1/payload";
import {
  TYPE_URI as RECORDS_LIST,
  RESPONSE_TYPE_URI as RECORDS_LIST_RESPONSE,
  type RoomsRecordsListResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/list/0.1/payload";
import {
  TYPE_URI as RECORDS_PUT_V1,
  RESPONSE_TYPE_URI as RECORDS_PUT_V1_RESPONSE,
  type RoomsRecordsPutResponsePayload as RoomsRecordsPutV1ResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/put/0.1/payload";
import {
  TYPE_URI as RECORDS_CURATE,
  RESPONSE_TYPE_URI as RECORDS_CURATE_RESPONSE,
  type RoomsRecordsCurateResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/curate/0.1/payload";
import {
  TYPE_URI as RECORDS_PUT_V2,
  RESPONSE_TYPE_URI as RECORDS_PUT_V2_RESPONSE,
  type RoomsRecordsPutResponsePayload as RoomsRecordsPutV2ResponsePayload,
} from "@openvtc/trust-tasks/rooms/records/put/0.2/payload";

export type { RoomsInfoResponsePayload as RoomInfo, UnsignedRoomRequest };

/** Who asks the member's VTA: the wallet, and the VTA. (`RoomsCaller`, restated so this module imports nothing of `index.ts`.) */
interface RoomsCaller {
  holder: TaskParty;
  service: TaskParty;
}

/** Sends a document the member's VTA completed, unchanged, and reads the host's reply. */
export interface CompletedDocumentSender {
  sendCompleted<Res>(document: Record<string, unknown>, opts?: SendOpts): Promise<Res>;
}

/**
 * Everything a request made as the member needs: the room, the member's own VTA
 * (and the wallet's DID, which is who asks it), and the host.
 */
export interface PersonaRoom {
  roomId: string;
  /** The wallet's DID — the caller of the VTA tasks. It reaches no host. */
  holder: TaskParty;
  vta: { did: string; sender: TrustTaskSender };
  host: { did: string; sender: CompletedDocumentSender };
  /**
   * The member to act as: a persona DID the VTA holds. Every request made for
   * this room names it — `issuer` on `rooms/keys/act`, the author of a sealed
   * body, `ext["org.openvtc.rooms"].member` on the custody tasks — so a VTA
   * holding two members of the room is never asked to choose (it refuses, and
   * must). Omitted only where the caller has no member to name yet.
   */
  member?: string;
}

/**
 * The document `rooms/keys/act` takes: addressed to the host, no proof, no
 * presentation, and the wallet's own DID nowhere. `issuer` only when it names
 * the member to act as — needed for a document that names no room (a download
 * chunk), and to choose among several members the caller may act as.
 */
export function unsignedRoomRequest(
  type: string,
  hostDid: string,
  payload: Record<string, unknown>,
  issuer?: string,
): UnsignedRoomRequest {
  const doc = buildTrustTask(type, payload, {
    id: `urn:uuid:${globalThis.crypto.randomUUID()}`,
    recipient: hostDid,
    ...(issuer !== undefined ? { issuer } : {}),
  });
  return doc as unknown as UnsignedRoomRequest;
}

/**
 * Have the member's VTA complete `document` as the member.
 *
 * Returns the member it acted as and the completed document, which the caller
 * sends to the host unchanged. The answer is checked before it is returned: a
 * completed document must still be the request that was asked for — same id,
 * type, recipient and payload apart from the presentation — and be issued and
 * signed by the member named, or the VTA has signed something other than what
 * the member's client built.
 */
export async function roomsKeysAct(
  sender: TrustTaskSender,
  parties: RoomsCaller,
  document: UnsignedRoomRequest,
  /**
   * `0.5` for a member's requests to a community about the rooms it offers them
   * (`vtc/rooms/offers/*`, `vtc/rooms/memberships/list`), which only it completes;
   * `0.1` — what every VTA serving rooms speaks — for the rest.
   */
  version: "0.1" | "0.5" = "0.1",
): Promise<{ principal: string; document: Record<string, unknown> }> {
  const payload: RoomsKeysActPayload = { document };
  const envelope = buildTrustTask(version === "0.5" ? KEYS_ACT_V5 : KEYS_ACT, payload, {
    issuer: parties.holder.did,
    recipient: parties.service.did,
  });
  // 0.5's request and response members are 0.1's; only the table grew.
  const res = await sender.send<RoomsKeysActResponsePayload>(envelope, {
    expectedResponseType: version === "0.5" ? KEYS_ACT_V5_RESPONSE : KEYS_ACT_RESPONSE,
    operationLabel: `rooms/keys/act/${version}`,
  });
  const completed = res.document as Record<string, unknown>;
  const principal = res.principal;
  const refuse = (why: string): never => {
    throw new Error(`${parties.service.did} completed ${document.type} as the member, but ${why}`);
  };
  if (typeof principal !== "string" || !principal.startsWith("did:")) refuse("named no member it acted as");
  if (!completed || typeof completed !== "object") refuse("returned no document");
  if (completed.id !== document.id || completed.type !== document.type || completed.recipient !== document.recipient) {
    refuse("the document it returned is not the one it was asked to complete");
  }
  if (completed.issuer !== principal) refuse(`the document is issued by ${String(completed.issuer)}, not ${principal}`);
  if (document.issuer !== undefined && principal !== document.issuer) {
    refuse(`it acted as ${principal}, not ${String(document.issuer)}, the member named`);
  }
  if (!completed.proof) refuse("the document carries no proof");
  const asked = document.payload as Record<string, unknown>;
  const got = (completed.payload ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(asked)) {
    if (canonical(got[k]) !== canonical(v)) refuse(`it changed the payload's ${k}`);
  }
  for (const k of Object.keys(got)) {
    if (!(k in asked) && k !== "presentation") refuse(`it added ${k} to the payload`);
  }
  return { principal, document: completed };
}

/** JSON with object members in sorted order, so two spellings of one value compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** A host's refusal of a completed request, or the VTA's refusal to complete one. */
export class RoomActError extends Error {
  constructor(
    readonly code: "notAMember" | "principalAmbiguous" | "actionNotHeld" | "issuerNotPrincipal" | "other",
    message: string,
  ) {
    super(message);
    this.name = "RoomActError";
  }
}

function actFailure(e: unknown): Error {
  const text = e instanceof Error ? e.message : String(e);
  for (const code of ["notAMember", "principalAmbiguous", "actionNotHeld", "issuerNotPrincipal"] as const) {
    if (text.includes(code)) {
      const hint = {
        notAMember: "Your VTA holds no credential this room issued to an identity you may act as.",
        principalAmbiguous:
          "Your agent holds this room as more than one member, and the request did not say which one to act as.",
        actionNotHeld: "Your own credentials for this room do not allow that.",
        issuerNotPrincipal: "That identity is not a member of this room you may act as.",
      }[code];
      return new RoomActError(code, `${hint} (${text})`);
    }
  }
  return e instanceof Error ? e : new Error(text);
}

/**
 * Send one room request to the host **as the member**: built here unsigned,
 * completed by the VTA, sent unchanged. Returns the member the VTA acted as and
 * the host's response payload.
 */
export async function actAndSend<Res>(
  room: PersonaRoom,
  type: string,
  responseType: string,
  payload: Record<string, unknown>,
  issuer: string | undefined = room.member,
): Promise<{ principal: string; reply: Res }> {
  const vta = { holder: room.holder, service: { did: room.vta.did } };
  let completed: { principal: string; document: Record<string, unknown> };
  try {
    completed = await roomsKeysAct(room.vta.sender, vta, unsignedRoomRequest(type, room.host.did, payload, issuer));
  } catch (e) {
    throw actFailure(e);
  }
  const reply = await room.host.sender.sendCompleted<Res>(completed.document, {
    expectedResponseType: responseType,
    operationLabel: type.replace(/^https:\/\/trusttasks\.org\/spec\//, ""),
  });
  return { principal: completed.principal, reply };
}

/**
 * Seal a record body, signed by the VTA **as its author** — the member — first
 * (`rooms/keys/seal/0.2`, `signAsPrincipal`). `body` carries no proof; the VTA
 * refuses one whose `author` is not a member it may act as.
 */
export async function roomsKeysSealAsPrincipal(
  sender: TrustTaskSender,
  parties: RoomsCaller,
  params: { roomId: string; key: string; version: number; body: Record<string, unknown> },
  // `author` in the body names the member, so no `ext` member is needed here.
): Promise<RoomsKeysSealV2ResponsePayload["sealed"]> {
  const payload: RoomsKeysSealV2Payload = {
    roomId: params.roomId,
    key: params.key,
    version: params.version,
    plaintext: base64url.encode(new TextEncoder().encode(JSON.stringify(params.body))),
    signAsPrincipal: true,
  };
  const envelope = buildTrustTask(KEYS_SEAL_V2, payload, {
    issuer: parties.holder.did,
    recipient: parties.service.did,
  });
  const res = await sender.send<RoomsKeysSealV2ResponsePayload>(envelope, {
    expectedResponseType: KEYS_SEAL_V2_RESPONSE,
    operationLabel: "rooms/keys/seal/0.2",
  });
  return res.sealed;
}

/** The room's tier, epoch, limits and usage, read as the member — and who the member is. */
export async function roomInfoAsMember(room: PersonaRoom): Promise<{ principal: string; info: RoomsInfoResponsePayload }> {
  const { principal, reply } = await actAndSend<RoomsInfoResponsePayload>(room, INFO, INFO_RESPONSE, {
    roomId: room.roomId,
  });
  if (reply.roomId !== room.roomId) {
    throw new Error(`${room.host.did} answered rooms/info for ${reply.roomId}, not ${room.roomId}`);
  }
  return { principal, info: reply };
}

/**
 * The room's head version, read as the member: the version the next write is
 * predicted to take, less one. `0` for a room holding no records, and for a
 * host that keeps no record tree (which then corrects the prediction on the put).
 */
export async function roomHeadVersionAsMember(room: PersonaRoom): Promise<number> {
  const { reply } = await actAndSend<RoomsRecordsListResponsePayload>(room, RECORDS_LIST, RECORDS_LIST_RESPONSE, {
    roomId: room.roomId,
    limit: 1,
  });
  return reply.headVersion ?? 0;
}

/** How many times a write re-seals for the version the host assigned. The CLI's figure. */
const SEALED_WRITE_ATTEMPTS = 4;

/** A sealed record body as the writer builds it: the member as author, no proof. */
export interface UnsignedRecordBody {
  roomId: string;
  key: string;
  author: string;
  title?: string;
  description?: string;
  /** Markdown. */
  body?: string;
  tags?: string[];
  /** The file manifest, for a record that carries a file. */
  file?: Record<string, unknown>;
}

/** Thrown when a record landed at a version it was not sealed for, every time. */
export class VersionRaceError extends Error {
  constructor(
    readonly key: string,
    readonly landed: number,
  ) {
    super(
      `${key} is stored at version ${landed} but sealed for another, so it does not open: the room kept ` +
        `moving under ${SEALED_WRITE_ATTEMPTS} attempts. Write it again.`,
    );
    this.name = "VersionRaceError";
  }
}

/**
 * Have the VTA sign `body` as the member and seal it, and put it as the member,
 * re-sealing at the version the host assigned whenever that is not the one
 * sealed for. Returns the version written.
 *
 * Create-only by default: the key is fresh, and `expectedVersion` 0 makes the
 * host refuse it if it is not. Pass `replaces` — the version the writer read —
 * to replace a record instead: the host refuses the put if anything has been
 * written over it since, so an edit never silently undoes someone else's.
 *
 * The record's associated data and its signed body both name the version, and
 * the host assigns it from a room-wide counter, so the version is predicted
 * from the room's head and a miss is corrected by a rewrite — over exactly the
 * version that landed, never blind.
 */
export async function writeSealedAsMember(
  room: PersonaRoom,
  body: UnsignedRecordBody,
  blobRef?: string,
  opts: { replaces?: number } = {},
): Promise<number> {
  if (room.member !== undefined && body.author !== room.member) {
    throw new Error(`a record written as ${room.member} cannot name ${body.author} as its author`);
  }
  const vta = { holder: room.holder, service: { did: room.vta.did } };
  let intended = (await roomHeadVersionAsMember(room)) + 1;
  let expected = opts.replaces ?? 0;
  let landed = 0;
  for (let attempt = 0; attempt < SEALED_WRITE_ATTEMPTS; attempt++) {
    const sealed = await roomsKeysSealAsPrincipal(room.vta.sender, vta, {
      roomId: room.roomId,
      key: body.key,
      version: intended,
      body: wireBody({ ...body, version: intended }),
    });
    const payload: Record<string, unknown> = {
      roomId: room.roomId,
      key: body.key,
      sealed,
      expectedVersion: expected,
      ...(blobRef !== undefined ? { blobs: [blobRef] } : {}),
    };
    const put =
      blobRef !== undefined
        ? (await actAndSend<RoomsRecordsPutV2ResponsePayload>(room, RECORDS_PUT_V2, RECORDS_PUT_V2_RESPONSE, payload))
            .reply
        : (await actAndSend<RoomsRecordsPutV1ResponsePayload>(room, RECORDS_PUT_V1, RECORDS_PUT_V1_RESPONSE, payload))
            .reply;
    landed = put.version;
    if (landed === intended) return landed;
    expected = landed;
    intended = landed + 1;
  }
  throw new VersionRaceError(body.key, landed);
}

/**
 * Put a record in the clear, as the member — for an `open` room, whose records
 * the host stores and reads. `replaces`, as for {@link writeSealedAsMember}.
 */
export async function putCleartextAsMember(
  room: PersonaRoom,
  params: { key: string; title?: string; body?: string; replaces?: number },
): Promise<number> {
  const cleartext: Record<string, unknown> = {};
  if (params.title !== undefined) cleartext.title = params.title;
  if (params.body !== undefined) cleartext.body = params.body;
  const { reply } = await actAndSend<RoomsRecordsPutV1ResponsePayload>(room, RECORDS_PUT_V1, RECORDS_PUT_V1_RESPONSE, {
    roomId: room.roomId,
    key: params.key,
    cleartext,
    expectedVersion: params.replaces ?? 0,
  });
  return reply.version;
}

/** What a member may do to a record's standing (`rooms/records/curate/0.1`). */
export interface CurateParams {
  key: string;
  /** `retracted` drops the body and keeps a tombstone; `deprecated` demotes it; `active` restores a demoted one. */
  status?: "active" | "deprecated" | "retracted";
  pinned?: boolean;
  /** Why, for the room's audit trail. */
  reason?: string;
  /** The version the member read; the host refuses if the record has moved since. */
  expectedVersion?: number;
}

/**
 * Curate a record, as the member. The VTA presents the member's own authority
 * narrowed to `curate` — which `write` does not imply, so a member who may add
 * to a room may still be refused this — and the host decides.
 */
export async function curateRecordAsMember(
  room: PersonaRoom,
  params: CurateParams,
): Promise<RoomsRecordsCurateResponsePayload> {
  const payload: Record<string, unknown> = { roomId: room.roomId, key: params.key };
  if (params.status !== undefined) payload.status = params.status;
  if (params.pinned !== undefined) payload.pinned = params.pinned;
  if (params.reason !== undefined && params.reason !== "") payload.reason = params.reason;
  if (params.expectedVersion !== undefined) payload.expectedVersion = params.expectedVersion;
  const { reply } = await actAndSend<RoomsRecordsCurateResponsePayload>(
    room,
    RECORDS_CURATE,
    RECORDS_CURATE_RESPONSE,
    payload,
  );
  if (reply.key !== params.key) {
    throw new Error(`${room.host.did} answered rooms/records/curate for ${reply.key}, not ${params.key}`);
  }
  return reply;
}

/** The body as the schema serialises it: absent members omitted, never `null`. */
function wireBody(body: UnsignedRecordBody & { version: number }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    roomId: body.roomId,
    key: body.key,
    version: body.version,
    author: body.author,
  };
  if (body.title !== undefined) out.title = body.title;
  if (body.description !== undefined) out.description = body.description;
  if (body.body !== undefined) out.body = body.body;
  if (body.tags !== undefined && body.tags.length > 0) out.tags = body.tags;
  if (body.file !== undefined) out.file = body.file;
  return out;
}

/** An opaque record key, as a sealed tier requires: 16 random bytes. */
export function opaqueRecordKey(): string {
  return base64url.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}
