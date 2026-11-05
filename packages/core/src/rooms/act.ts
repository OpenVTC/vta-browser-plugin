// Acting in a room **as the member** — `rooms/keys/act` 0.11, and
// `rooms/keys/seal/0.3` with `signAsPrincipal`.
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
// `assertionMethod` before sealing it (`rooms/keys/seal/0.3`, `signAsPrincipal`).
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
import { roomsKeysProfileRead } from "./profile.js";
import {
  isNameWithdrawal,
  MEMBER_PROFILE_KIND,
  memberNameRefusal,
  memberNameRewriteDue,
  memberNameWriteRefusal,
} from "./member-name.js";

import {
  TYPE_URI as KEYS_ACT,
  RESPONSE_TYPE_URI as KEYS_ACT_RESPONSE,
  type RoomsKeysActPayload,
  type RoomsKeysActResponsePayload,
  type UnsignedRoomRequest,
} from "../specs/rooms/keys/act/0.11/payload.js";
import {
  TYPE_URI as KEYS_SEAL,
  RESPONSE_TYPE_URI as KEYS_SEAL_RESPONSE,
  type RoomsKeysSealPayload,
  type RoomsKeysSealResponsePayload,
} from "../specs/rooms/keys/seal/0.3/payload.js";
import {
  TYPE_URI as INFO,
  RESPONSE_TYPE_URI as INFO_RESPONSE,
  type RoomsInfoResponsePayload,
} from "../specs/rooms/info/0.3/payload.js";
import {
  TYPE_URI as RECORDS_LIST,
  RESPONSE_TYPE_URI as RECORDS_LIST_RESPONSE,
  type RoomsRecordsListResponsePayload,
} from "../specs/rooms/records/list/0.6/payload.js";
import {
  TYPE_URI as RECORDS_PUT,
  RESPONSE_TYPE_URI as RECORDS_PUT_RESPONSE,
  type RoomsRecordsPutResponsePayload,
} from "../specs/rooms/records/put/0.5/payload.js";
import {
  TYPE_URI as RECORDS_CURATE,
  RESPONSE_TYPE_URI as RECORDS_CURATE_RESPONSE,
  type RoomsRecordsCurateResponsePayload,
} from "../specs/rooms/records/curate/0.1/payload.js";

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
): Promise<{ principal: string; document: Record<string, unknown> }> {
  // 0.11 completes every request this wallet makes as a member — the host-bound
  // room requests (records at `rooms/records/put/0.5`, with or without a file,
  // read at `rooms/records/get/0.3` and listed at `rooms/records/list/0.6`) and a
  // member's requests to a community about the rooms it offers them
  // (`vtc/rooms/offers/*`, `vtc/rooms/memberships/list/0.2`) alike. 0.11 is
  // 0.10's table plus put/0.5, list/0.6 and get/0.3.
  const payload: RoomsKeysActPayload = { document };
  const envelope = buildTrustTask(KEYS_ACT, payload, {
    issuer: parties.holder.did,
    recipient: parties.service.did,
  });
  const res = await sender.send<RoomsKeysActResponsePayload>(envelope, {
    expectedResponseType: KEYS_ACT_RESPONSE,
    operationLabel: "rooms/keys/act/0.11",
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
 * (`rooms/keys/seal/0.3`, `signAsPrincipal`). `body` carries no proof; the VTA
 * refuses one whose `author` is not a member it may act as.
 */
export async function roomsKeysSealAsPrincipal(
  sender: TrustTaskSender,
  parties: RoomsCaller,
  params: { roomId: string; key: string; version: number; body: Record<string, unknown> },
  // `author` in the body names the member, so no `ext` member is needed here.
): Promise<RoomsKeysSealResponsePayload["sealed"]> {
  const payload: RoomsKeysSealPayload = {
    roomId: params.roomId,
    key: params.key,
    version: params.version,
    plaintext: base64url.encode(new TextEncoder().encode(JSON.stringify(params.body))),
    signAsPrincipal: true,
  };
  const envelope = buildTrustTask(KEYS_SEAL, payload, {
    issuer: parties.holder.did,
    recipient: parties.service.did,
  });
  const res = await sender.send<RoomsKeysSealResponsePayload>(envelope, {
    expectedResponseType: KEYS_SEAL_RESPONSE,
    operationLabel: "rooms/keys/seal/0.3",
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
  /** What the record is to a reader (`RecordKind`). Written only where the room's profile lists `kind`. */
  kind?: string;
  /** When the author wrote it (`RecordWrittenAt`). Written only where the room's profile lists `writtenAt`. */
  writtenAt?: string;
  /** When the author edited it (`RecordEditedAt`). Written only where the room's profile lists `editedAt`. */
  editedAt?: string;
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
    const put = (await actAndSend<RoomsRecordsPutResponsePayload>(room, RECORDS_PUT, RECORDS_PUT_RESPONSE, payload))
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
 * The cleartext's `body` is required by `rooms/records/put/0.5`, so a note with
 * none is sent with an empty one.
 *
 * With `file` — its manifest, `fileKey` included — and the `blobRef` it
 * describes, the record carries that file, naming exactly that blob, as its
 * host requires.
 */
export async function putCleartextAsMember(
  room: PersonaRoom,
  params: {
    key: string;
    title?: string;
    body?: string;
    description?: string;
    tags?: string[];
    /** `kind`, `writtenAt` and `editedAt` (`rooms/records/put/0.5`): only where the room's profile lists them. */
    kind?: string;
    writtenAt?: string;
    editedAt?: string;
    replaces?: number;
    file?: { manifest: Record<string, unknown>; blobRef: string };
  },
): Promise<number> {
  const cleartext: Record<string, unknown> = { body: params.body ?? "" };
  if (params.kind !== undefined) cleartext.kind = params.kind;
  if (params.title !== undefined) cleartext.title = params.title;
  if (params.writtenAt !== undefined) cleartext.writtenAt = params.writtenAt;
  if (params.editedAt !== undefined) cleartext.editedAt = params.editedAt;
  if (params.description !== undefined) cleartext.description = params.description;
  if (params.tags !== undefined) cleartext.tags = params.tags;
  const payload: Record<string, unknown> = {
    roomId: room.roomId,
    key: params.key,
    cleartext,
    expectedVersion: params.replaces ?? 0,
  };
  if (params.file) {
    cleartext.file = params.file.manifest;
    payload.blobs = [params.file.blobRef];
  }
  const { reply } = await actAndSend<RoomsRecordsPutResponsePayload>(
    room,
    RECORDS_PUT,
    RECORDS_PUT_RESPONSE,
    payload,
  );
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
  if (body.kind !== undefined) out.kind = body.kind;
  if (body.title !== undefined) out.title = body.title;
  if (body.description !== undefined) out.description = body.description;
  if (body.body !== undefined) out.body = body.body;
  if (body.tags !== undefined && body.tags.length > 0) out.tags = body.tags;
  if (body.file !== undefined) out.file = body.file;
  if (body.writtenAt !== undefined) out.writtenAt = body.writtenAt;
  if (body.editedAt !== undefined) out.editedAt = body.editedAt;
  return out;
}

/** The room's `recordMembers`, as its current profile states them, read through the member's VTA. `undefined`: none. */
export async function roomRecordMembersAsMember(room: PersonaRoom): Promise<string[] | undefined> {
  const read = await roomsKeysProfileRead(room.vta.sender, {
    holder: room.holder,
    service: { did: room.vta.did },
    roomId: room.roomId,
    host: room.host.did,
    ...(room.member !== undefined ? { member: room.member } : {}),
  });
  if (read.status !== "found") return undefined;
  const listed = (read.profile as { recordMembers?: unknown } | undefined)?.recordMembers;
  return Array.isArray(listed) && listed.every((m) => typeof m === "string") ? listed : undefined;
}

/** Thrown when a write is refused before anything is sent: the room's profile does not permit it, or the value is not one the schema allows. */
export class RecordWriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordWriteRefused";
  }
}

/** A name record a member already holds in the room: the one a new name is written over. */
export interface HeldMemberName {
  author: string;
  key: string;
  version: number;
}

/**
 * Write the member's own name in the room — a record of kind `memberProfile`
 * with the name in `title` (rooms/_shared/0.3 `MemberProfileRecord`,
 * trust-tasks-tf #1035). An empty name (or only white space) withdraws it.
 *
 * **Refused before anything is sent** unless the room's current profile lists
 * both `kind` and `memberProfile` in `recordMembers` — a reader that predates the
 * kind would show every member's name as a note — and unless `name` is a
 * `MemberName`. The profile is read here, as the member, every time.
 *
 * The member keeps one name record: where `held` names one by the member, the
 * name is a new version of it (`replaces` its version, so the host refuses the
 * write if anything has replaced it since); otherwise a new one, create-only,
 * so a retry after a lost answer cannot leave a second. Sealed and signed by
 * the VTA as the member on `attributed` and `private`, in the clear on `open`
 * (`rooms/records/put/0.5`) — as the room says, never assumed. `writtenAt`, and
 * `editedAt` on a new version, are written where the profile lists them.
 */
export async function writeMemberNameAsMember(
  room: PersonaRoom,
  params: { name: string; held?: readonly HeldMemberName[]; now?: () => Date },
): Promise<{ principal: string; key: string; version: number }> {
  const bad = memberNameRefusal(params.name);
  if (bad !== undefined) throw new RecordWriteRefused(`Not written: ${bad}.`);
  const listed = await roomRecordMembersAsMember(room);
  const refused = memberNameWriteRefusal(listed);
  if (refused !== undefined) throw new RecordWriteRefused(refused);
  const lists = (m: string) => listed!.includes(m);
  const now = (params.now ?? (() => new Date()))().toISOString().replace(/\.\d{3}Z$/, "Z");

  const { principal, info } = await roomInfoAsMember(room);
  const mine = params.held?.find((h) => h.author === principal);
  const key = mine?.key ?? opaqueRecordKey();
  const times = {
    ...(lists("writtenAt") ? { writtenAt: now } : {}),
    ...(mine !== undefined && lists("editedAt") ? { editedAt: now } : {}),
  };
  const version =
    info.visibility === "open"
      ? await putCleartextAsMember(room, {
          key,
          kind: MEMBER_PROFILE_KIND,
          title: params.name,
          body: "",
          ...times,
          ...(mine !== undefined ? { replaces: mine.version } : {}),
        })
      : await writeSealedAsMember(
          room,
          { roomId: room.roomId, key, author: principal, kind: MEMBER_PROFILE_KIND, title: params.name, ...times },
          undefined,
          mine !== undefined ? { replaces: mine.version } : {},
        );
  return { principal, key, version };
}

/** The member's own name record, as rule 2 gives it from the records its client holds: what a rewrite near the head writes again. */
export interface OwnMemberName {
  key: string;
  version: number;
  /** The name rule 2 gives. A withdrawn (or refused, or retracted) name is never written again. */
  name: string;
  /** The version's own `writtenAt` and `editedAt`, kept unchanged by the rewrite. */
  writtenAt?: string;
  editedAt?: string;
}

/**
 * After a write the host assigned `writeVersion`, write the member's name again
 * where it has fallen more than `MEMBER_NAME_REWRITE_DISTANCE` (500) versions
 * behind (*Near the room's head*, rooms/_shared/0.3 `MemberProfileRecord`,
 * trust-tasks-tf #1038), so a reader that opens only recent pages still finds
 * it. Answers the new version, or `undefined` when nothing was due.
 *
 * **Writing it again** is a new version of the same record — the same key, the
 * name rule 2 gives (`own`, from the records the client holds, never a name a
 * device remembers), `writtenAt` kept unchanged and no new `editedAt` (an
 * earlier one stays as it is), since the name has not changed. It `replaces`
 * the version read, so a concurrent change on another device wins and this
 * writes nothing. The writer's gate applies as to any name: a room whose
 * profile no longer lists `kind` and `memberProfile` gets nothing.
 */
export async function rewriteMemberNameAsMember(
  room: PersonaRoom,
  own: OwnMemberName | undefined,
  writeVersion: number,
): Promise<number | undefined> {
  if (own === undefined || !memberNameRewriteDue(own, writeVersion)) return undefined;
  if (isNameWithdrawal(own.name) || memberNameRefusal(own.name) !== undefined) return undefined;
  const listed = await roomRecordMembersAsMember(room);
  if (memberNameWriteRefusal(listed) !== undefined) return undefined;
  const { principal, info } = await roomInfoAsMember(room);
  const times = {
    ...(own.writtenAt !== undefined ? { writtenAt: own.writtenAt } : {}),
    ...(own.editedAt !== undefined ? { editedAt: own.editedAt } : {}),
  };
  return info.visibility === "open"
    ? putCleartextAsMember(room, {
        key: own.key,
        kind: MEMBER_PROFILE_KIND,
        title: own.name,
        body: "",
        ...times,
        replaces: own.version,
      })
    : writeSealedAsMember(
        room,
        { roomId: room.roomId, key: own.key, author: principal, kind: MEMBER_PROFILE_KIND, title: own.name, ...times },
        undefined,
        { replaces: own.version },
      );
}

/** An opaque record key, as a sealed tier requires: 16 random bytes. */
export function opaqueRecordKey(): string {
  return base64url.encode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}
