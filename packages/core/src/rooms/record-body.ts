// The sealed record body — `SealedRecordBody` in `rooms/_shared/0.2/room.schema.json`:
// the plaintext inside a sealed record, signed by its author. No host task
// carries it, so there is no generated type.
//
// ## Why this is its own module
//
// Every surface that shows a sealed record has to verify it first (the schema's
// *Reading* rule): the offscreen document's file engine and page view, and the
// console's records pane. `./files.ts` carries `rooms/keys/file-key`, a URI CI
// bans from every bundle but the offscreen entry chunk, so the console cannot
// import the verifier from there. This module carries no task URI at all; it is
// exported from `@openvtc/pnm-core/rooms` and re-exported from `./files.ts`.
//
// ## The members are the released schema's, exactly
//
// A reader refuses an unknown member (rule 1), so this list decides which
// honest records a member can read. It is `SealedRecordBody`'s `properties` at
// `_shared/0.2`, no more and no fewer: a member a later schema adds is refused
// until this list is moved with the pin, which shows nothing rather than
// something wrong.

// FileManifest is a definition no task schema references (it travels inside a
// sealed record body), so no generated task module re-exports it. Type-only.
import type { FileManifest } from "../specs/_shared/components.js";
// The provenance members' shapes, as the task that writes them in the clear
// re-exports them; type-only, so none of its URIs load.
import type {
  PermittedUse,
  RecordBasis,
  RecordConfidence,
  RecordEvidence,
  RecordEvidenceList,
  RecordReference,
  RecordValidUntil,
} from "../specs/rooms/records/put/0.5/payload.js";
import type { RoomProfile } from "../specs/rooms/keys/profile/read/0.1/payload.js";

import type { SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import { resolveDidDocument } from "../didcomm/index.js";
import { isDidVersionNotFound } from "../did/resolve-at.js";
import { stripScidSrc } from "@openvtc/vti-didcomm-js";

/** Where a record was written or read: what the body's signature has to name. */
export interface RecordLocation {
  roomId: string;
  key: string;
  version: number;
}

export type { PermittedUse, RecordBasis, RecordConfidence, RecordEvidence, RecordEvidenceList, RecordValidUntil };

/**
 * `RoomProfileStatement`: the room's own profile, carried by its profile record.
 * No pinned task's schema references it (it travels inside a sealed body), so
 * there is no generated type to take.
 */
export interface RoomProfileStatement {
  profile: RoomProfile;
  issuedAt: string;
  authority: string[];
  padding?: string;
  ext?: Record<string, unknown>;
}

/**
 * `RecordReference`: another record of the same room, by key and optionally the
 * version the author was answering. A reader resolves it only against records
 * it can already read, and fetches nothing because of it.
 */
export type { RecordReference };

/** A record body before signing or after verification. */
export interface SealedRecordBody extends RecordLocation {
  /** The DID that signs: the member, or the agent acting under an attenuated credential. */
  author: string;
  title?: string;
  description?: string;
  /** Markdown. Untrusted text from another member: render it inert. */
  body?: string;
  tags?: string[];
  /**
   * `RecordKind`: `note`, `message`, `reaction`, or a kind this reader does not
   * know, which it shows as a note. Absent means `note`. Describes the record
   * and confers nothing.
   */
  kind?: string;
  /** The record this one answers or, on a `reaction`, responds to. */
  inReplyTo?: RecordReference;
  /** When the author wrote the record: their claim, kept across edits (RFC 3339, UTC). */
  writtenAt?: string;
  /** When the author made the edit that produced this version: their claim (RFC 3339, UTC). */
  editedAt?: string;
  /** Provenance for display and weighting, never authority. Absent means the author did not say. */
  basis?: RecordBasis;
  confidence?: RecordConfidence;
  evidence?: RecordEvidenceList;
  validFor?: PermittedUse;
  /** After this instant the author no longer stands behind the record as current. */
  validUntil?: RecordValidUntil;
  /** Present when the record carries a file. Its `blobRef` is the one the record names. */
  file?: FileManifest;
  /** Present only on the room's profile record, which is not one of its records. */
  roomProfile?: RoomProfileStatement;
}

/** `SealedRecordBody`'s members at `rooms/_shared/0.2`, `proof` aside. */
export const RECORD_BODY_MEMBERS: readonly string[] = Object.freeze([
  "roomId",
  "key",
  "version",
  "author",
  "title",
  "description",
  "body",
  "tags",
  "kind",
  "inReplyTo",
  "writtenAt",
  "editedAt",
  "basis",
  "confidence",
  "evidence",
  "validFor",
  "validUntil",
  "file",
  "roomProfile",
]);

const BODY_MEMBERS = new Set(RECORD_BODY_MEMBERS);

/** The members a profile record must not carry (`SealedRecordBody`, *A profile record*). */
const NOT_ON_A_PROFILE = [
  "title", "description", "body", "tags", "kind", "inReplyTo", "writtenAt", "editedAt", "file", "basis",
  "confidence", "evidence", "validFor", "validUntil",
] as const;

// The schema's bounds.
const MAX_KEY = 512;
const MAX_TITLE = 512;
const MAX_DESCRIPTION = 2048;
const MAX_BODY = 1_048_576;
const MAX_TAGS = 32;
const MAX_TAG = 64;
const BASES: readonly string[] = ["declared", "observed", "verified", "inferred"];
const MAX_EVIDENCE = 32;
const MAX_ID = 2048;
const MAX_PURPOSES = 8;
const MAX_NOTE = 512;
const MAX_AUTHORITY = 8;
const MAX_PADDING = 8192;
const MAX_PROFILE_NAME = 128;
const MAX_PROFILE_DESCRIPTION = 1000;
const MAX_PROFILE_TAGS = 8;
const MAX_EMOJI = 16;
const MAX_KIND = 64;
const MAX_RECORD_MEMBERS = 32;

const IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DIGEST_MULTIBASE = /^(z[1-9A-HJ-NP-Za-km-z]+|u[A-Za-z0-9_-]+)$/;
const PROFILE_TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EXT_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;
// `RecordKind`, and the names `RoomProfile.recordMembers` lists: lowerCamelCase.
const LOWER_CAMEL = /^[a-z][A-Za-z0-9]*$/;
// `RecordWrittenAt` / `RecordEditedAt`: RFC 3339 in UTC, `Z` only.
const UTC_DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
// RFC 3339 `date-time`, as JSON Schema's `format` names it.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Why a body was refused, or could not be signed.
 *
 * Two kinds are not refusals but the placeholder `SealedRecordBody` requires in
 * their place — the record shown as one whose author cannot be verified, none
 * of it shown, never dropped silently ({@link RecordBodyError.placeholder}):
 *
 * - `authorUnresolvable` — the author's DID does not resolve (*An author whose
 *   DID does not resolve*);
 * - `authorUnverifiable` — the proof fails against the author's **current**
 *   document, where the reader could not resolve the document as it stood at
 *   the host's `bodyStoredAt`: a forgery and a key rotated away since cannot be
 *   told apart (*Which DID document*).
 *
 * Where the author's history *can* be read, a proof that fails as of
 * `bodyStoredAt` is `signature`, and so is an author whose history says it
 * had no document then (`E_DID_VERSION_NOT_FOUND`): a body cannot have been
 * signed by a DID before the DID existed.
 */
export type RecordBodyErrorKind =
  | "malformed"
  | "signature"
  | "relocated"
  | "authorMismatch"
  | "signing"
  | "authorUnresolvable"
  | "authorUnverifiable";

/** Why a body could not be signed, or was refused on reading. */
export class RecordBodyError extends Error {
  constructor(
    readonly kind: RecordBodyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RecordBodyError";
  }

  /** Whether the record is shown as an unverifiable-author placeholder rather than refused. Nothing of it is shown either way. */
  get placeholder(): boolean {
    return this.kind === "authorUnresolvable" || this.kind === "authorUnverifiable";
  }
}

const chars = (s: string) => [...s].length;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && chars(v) >= min && chars(v) <= max;
const onlyMembers = (o: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(o).every((k) => allowed.includes(k));
const isDateTime = (v: unknown): v is string =>
  typeof v === "string" && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));
const isUtcDateTime = (v: unknown): v is string =>
  typeof v === "string" && UTC_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));
const isVersion = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1;
const isExt = (v: unknown) =>
  isObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => EXT_NAME.test(k));
const unique = (xs: unknown[]) => new Set(xs).size === xs.length;

function isEvidence(e: unknown): boolean {
  if (!isObject(e)) return false;
  if (e.kind === "record") {
    return (
      onlyMembers(e, ["kind", "key", "version", "roomId"]) &&
      isString(e.key, 1, MAX_KEY) &&
      (e.version === undefined || (Number.isSafeInteger(e.version) && (e.version as number) >= 1)) &&
      (e.roomId === undefined || (isString(e.roomId, 0, MAX_ID) && e.roomId.startsWith("did:")))
    );
  }
  if (e.kind === "credential") {
    return (
      onlyMembers(e, ["kind", "credentialId", "digest"]) &&
      isString(e.credentialId, 1, MAX_ID) &&
      (e.digest === undefined ||
        (typeof e.digest === "string" && e.digest.length >= 16 && DIGEST_MULTIBASE.test(e.digest)))
    );
  }
  return false;
}

function isPermittedUse(v: unknown): boolean {
  if (!isObject(v) || Object.keys(v).length === 0 || !onlyMembers(v, ["purposes", "note"])) return false;
  if (v.purposes !== undefined) {
    const p = v.purposes;
    if (
      !Array.isArray(p) ||
      p.length < 1 ||
      p.length > MAX_PURPOSES ||
      !unique(p) ||
      p.some((x) => !isString(x, 0, MAX_ID) || !IRI.test(x))
    ) {
      return false;
    }
  }
  return v.note === undefined || isString(v.note, 1, MAX_NOTE);
}

function isRoomProfile(v: unknown): boolean {
  if (!isObject(v) || !onlyMembers(v, ["name", "description", "tags", "emoji", "recordMembers", "ext"])) return false;
  if (!isString(v.name, 1, MAX_PROFILE_NAME)) return false;
  if (v.description !== undefined && !isString(v.description, 1, MAX_PROFILE_DESCRIPTION)) return false;
  if (
    v.tags !== undefined &&
    (!Array.isArray(v.tags) ||
      v.tags.length > MAX_PROFILE_TAGS ||
      !unique(v.tags) ||
      v.tags.some((t) => typeof t !== "string" || !PROFILE_TAG.test(t)))
  ) {
    return false;
  }
  if (v.emoji !== undefined && !isString(v.emoji, 1, MAX_EMOJI)) return false;
  // `recordMembers`: which optional body members the room's writers may use.
  // A reader that refused it would refuse every profile that turns them on.
  if (
    v.recordMembers !== undefined &&
    (!Array.isArray(v.recordMembers) ||
      v.recordMembers.length < 1 ||
      v.recordMembers.length > MAX_RECORD_MEMBERS ||
      !unique(v.recordMembers) ||
      v.recordMembers.some((m) => typeof m !== "string" || m.length > MAX_KIND || !LOWER_CAMEL.test(m)))
  ) {
    return false;
  }
  return v.ext === undefined || isExt(v.ext);
}

function isRecordReference(v: unknown): boolean {
  return (
    isObject(v) &&
    onlyMembers(v, ["key", "version"]) &&
    isString(v.key, 1, MAX_KEY) &&
    (v.version === undefined || isVersion(v.version))
  );
}

function isProfileStatement(v: unknown): boolean {
  if (!isObject(v) || !onlyMembers(v, ["profile", "issuedAt", "authority", "padding", "ext"])) return false;
  if (!isRoomProfile(v.profile) || !isDateTime(v.issuedAt)) return false;
  const a = v.authority;
  if (!Array.isArray(a) || a.length < 1 || a.length > MAX_AUTHORITY || a.some((x) => typeof x !== "string")) {
    return false;
  }
  if (v.padding !== undefined && !isString(v.padding, 0, MAX_PADDING)) return false;
  return v.ext === undefined || isExt(v.ext);
}

function checkBody(body: SealedRecordBody): void {
  const bad = (m: string) => {
    throw new RecordBodyError("malformed", `the record body is malformed: ${m}`);
  };
  if (typeof body.roomId !== "string" || body.roomId === "") bad("roomId is empty");
  if (typeof body.key !== "string" || body.key === "" || body.key.length > MAX_KEY) {
    bad(`key must be 1 to ${MAX_KEY} characters`);
  }
  if (!Number.isSafeInteger(body.version) || body.version < 1) bad("version starts at 1");
  if (typeof body.author !== "string" || !body.author.startsWith("did:")) bad("author is not a DID");
  const tooLong = (v: unknown, max: number) => v !== undefined && (typeof v !== "string" || chars(v) > max);
  if (tooLong(body.title, MAX_TITLE)) bad(`title is longer than ${MAX_TITLE} characters`);
  if (tooLong(body.description, MAX_DESCRIPTION)) bad(`description is longer than ${MAX_DESCRIPTION} characters`);
  if (tooLong(body.body, MAX_BODY)) bad(`body is longer than ${MAX_BODY} characters`);
  if (
    body.tags !== undefined &&
    (!Array.isArray(body.tags) ||
      body.tags.length > MAX_TAGS ||
      body.tags.some((t) => typeof t !== "string" || chars(t) > MAX_TAG))
  ) {
    bad(`at most ${MAX_TAGS} tags of ${MAX_TAG} characters each`);
  }
  if (body.kind !== undefined && (typeof body.kind !== "string" || body.kind.length > MAX_KIND || !LOWER_CAMEL.test(body.kind))) {
    bad("kind is not a lowerCamelCase name of at most 64 characters");
  }
  if (body.inReplyTo !== undefined && !isRecordReference(body.inReplyTo)) bad("inReplyTo is not a record reference");
  if (body.writtenAt !== undefined && !isUtcDateTime(body.writtenAt)) bad("writtenAt is not a UTC date-time");
  if (body.editedAt !== undefined && !isUtcDateTime(body.editedAt)) bad("editedAt is not a UTC date-time");
  if (body.basis !== undefined && !BASES.includes(body.basis)) bad(`basis is not one of ${BASES.join(", ")}`);
  if (
    body.confidence !== undefined &&
    (typeof body.confidence !== "number" || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1)
  ) {
    bad("confidence is not a number from 0 to 1");
  }
  if (
    body.evidence !== undefined &&
    (!Array.isArray(body.evidence) ||
      body.evidence.length < 1 ||
      body.evidence.length > MAX_EVIDENCE ||
      !body.evidence.every(isEvidence))
  ) {
    bad(`evidence must be 1 to ${MAX_EVIDENCE} cited records or credentials`);
  }
  if (body.validFor !== undefined && !isPermittedUse(body.validFor)) bad("validFor is not a permitted use");
  if (body.validUntil !== undefined && !isDateTime(body.validUntil)) bad("validUntil is not a date-time");
  if (body.file !== undefined && !isObject(body.file)) bad("file is not a manifest");
  if (body.roomProfile !== undefined) {
    if (!isProfileStatement(body.roomProfile)) bad("roomProfile is not a room profile statement");
    const also = NOT_ON_A_PROFILE.filter((m) => body[m] !== undefined);
    if (also.length > 0) bad(`a profile record carries ${also.join(", ")}`);
  }
}

/** The body as the schema serialises it: absent members omitted, never `null`. */
function wireBody(body: SealedRecordBody): Record<string, unknown> {
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
  if (body.kind !== undefined) out.kind = body.kind;
  if (body.inReplyTo !== undefined) out.inReplyTo = body.inReplyTo;
  if (body.writtenAt !== undefined) out.writtenAt = body.writtenAt;
  if (body.editedAt !== undefined) out.editedAt = body.editedAt;
  if (body.basis !== undefined) out.basis = body.basis;
  if (body.confidence !== undefined) out.confidence = body.confidence;
  if (body.evidence !== undefined) out.evidence = body.evidence;
  if (body.validFor !== undefined) out.validFor = body.validFor;
  if (body.validUntil !== undefined) out.validUntil = body.validUntil;
  if (body.file !== undefined) out.file = body.file;
  if (body.roomProfile !== undefined) out.roomProfile = body.roomProfile;
  return out;
}

/**
 * Sign `body` and return the bytes to seal (`rooms/keys/seal`'s plaintext).
 *
 * `signing` must be the author's key: a body signed by anyone else is refused
 * by every reader, so it is refused here, where the mistake is still the
 * writer's to fix.
 */
export async function signRecordBody(body: SealedRecordBody, signing: SigningIdentity): Promise<Uint8Array> {
  checkBody(body);
  if (signing.did !== body.author) {
    throw new RecordBodyError(
      "signing",
      `could not sign the record body: the key belongs to ${signing.did}, not to the author ${body.author}`,
    );
  }
  const signed = await signTrustTask({ envelope: wireBody(body), signing, proofPurpose: "assertionMethod" });
  return new TextEncoder().encode(JSON.stringify(signed));
}

declare const verifiedBrand: unique symbol;

/** A body whose signature, location and author have all been checked. Only `verifyRecordBody` makes one. */
export type VerifiedRecordBody = Readonly<SealedRecordBody> & { readonly [verifiedBrand]: true };

/**
 * How a reader may resolve the author's DID document **as it stood at an
 * instant** — `did:webvh` / `did:scid:vh:1` with `versionTime`, for a method
 * that keeps its history (`resolveDidDocumentAt`, `@openvtc/pnm-core/did`).
 *
 * - a document: the one in force at the instant;
 * - `null`: the history says no document existed then — the instant precedes
 *   the DID's first entry. Refused as `signature`, never a placeholder;
 * - `undefined`: the method keeps no history, so the current document is used.
 *
 * Throws where the DID does not resolve. A throw carrying
 * `code: "E_DID_VERSION_NOT_FOUND"` is read as `null`.
 */
export type ResolveDidAt = (did: string, at: string) => Promise<Record<string, unknown> | null | undefined>;

/** What {@link verifyRecordBody} may be told beyond the record's location. */
export interface VerifyRecordBodyOptions {
  /** Resolve a DID to its current document. Defaults to the wallet's resolver. */
  resolveDid?: (did: string) => Promise<Record<string, unknown>>;
  /**
   * The host's `bodyStoredAt` for the version being read (`RecordMetadataV3`):
   * when it stored the body this version carries. Absent from a host that
   * predates it, and from a read that does not carry it.
   */
  bodyStoredAt?: string;
  /** Resolve the author's document as of `bodyStoredAt`, where the method keeps its history. */
  resolveDidAt?: ResolveDidAt;
}

/**
 * Methods whose document can never differ from the one resolved now: the DID
 * *is* its key (or keys). A proof that fails against it cannot be a key
 * rotated away since the record was written, so it is refused, never shown as
 * the placeholder `SealedRecordBody` (*Which DID document*) keeps for a method
 * without history.
 */
const FIXED_DOCUMENT = ["did:key:", "did:peer:0", "did:peer:2"];

/** The proof's shape, checked before any key is looked for: a failure here is no key's fault. */
function proofShapeFault(proof: unknown): string | undefined {
  if (!isObject(proof)) return "no proof";
  if (proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022") {
    return `unsupported proof suite: ${String(proof.type)}/${String(proof.cryptosuite)}`;
  }
  if (proof.proofPurpose !== "assertionMethod") return `proofPurpose ${String(proof.proofPurpose)} != assertionMethod`;
  const vm = proof.verificationMethod;
  if (typeof vm !== "string" || !vm.includes("#")) return "missing/invalid verificationMethod";
  if (typeof proof.proofValue !== "string" || !proof.proofValue.startsWith("z")) {
    return "missing/invalid proofValue (expected multibase 'z')";
  }
  return undefined;
}

/**
 * Check an opened record's body before anything in it is shown or trusted.
 *
 * `plaintext` is the opened record, decoded. `readAt` is where the record was
 * sealed: its room and key, and the version the body is bound to (the host's
 * `sealed.version`, or the one the key holder says it opened at, else the
 * record's own). `hostAuthor` is the author the host recorded: present on an
 * `attributed` room, absent on a `private` one.
 *
 * Refuses, rather than returning a body with a warning, when the body is not a
 * `SealedRecordBody` or names an unknown member; carries no proof, or one that
 * does not verify for `author` under `assertionMethod`; names another location
 * than `readAt`; or is signed by someone other than `hostAuthor`.
 *
 * **Which DID document** (rule 2): the author's, as it stood at the host's
 * `bodyStoredAt` for this version. Where `opts.resolveDidAt` can resolve it as
 * of then, a proof that fails against it is refused, and so is an author whose
 * history says it had no document then (`null`, or a throw with
 * `code: "E_DID_VERSION_NOT_FOUND"`). Where it cannot — a method
 * without history, no `bodyStoredAt`, or no such resolver — the current
 * document is used, and a proof that fails there is a forgery or a key rotated
 * away since, which a reader cannot tell apart: it throws
 * `authorUnverifiable`, which a reader shows as a placeholder (nothing of the
 * record) rather than dropping. A `did:key` (or `did:peer` 0 / 2) document never
 * changes, so its failure is refused. An author whose DID does not resolve
 * throws `authorUnresolvable`, shown the same way.
 *
 * One proof, `eddsa-jcs-2022`: what every writer in the workspace produces. The
 * Rust reader also takes `ecdsa-jcs-2019` and proof sets; this one refuses them
 * as unverifiable rather than accepting what it cannot check.
 */
export async function verifyRecordBody(
  plaintext: Uint8Array,
  readAt: RecordLocation,
  hostAuthor: string | undefined,
  opts: VerifyRecordBodyOptions = {},
): Promise<VerifiedRecordBody> {
  let signed: unknown;
  try {
    signed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch (e) {
    throw new RecordBodyError("malformed", `the record body is malformed: not JSON (${String(e)})`);
  }
  if (typeof signed !== "object" || signed === null || Array.isArray(signed)) {
    throw new RecordBodyError("malformed", "the record body is malformed: not an object");
  }
  const document = signed as Record<string, unknown>;
  const refuseSignature = (why: string): never => {
    throw new RecordBodyError("signature", `the record body's signature does not hold: ${why}`);
  };

  // What no key could excuse is refused before any document is fetched.
  const fault = proofShapeFault(document.proof);
  if (fault !== undefined) refuseSignature(fault);
  const author = document.author;
  if (typeof author !== "string" || !author.startsWith("did:")) {
    throw new RecordBodyError("malformed", "the record body is malformed: author is not a DID");
  }
  const vm = (document.proof as { verificationMethod: string }).verificationMethod;
  const controller = vm.slice(0, vm.indexOf("#"));
  if (stripScidSrc(controller) !== author) {
    refuseSignature(`it is made with a key of ${stripScidSrc(controller)}, but the body names ${author} as its author`);
  }

  // The author's document: as of `bodyStoredAt` where that can be had, else now.
  const fixed = FIXED_DOCUMENT.some((p) => author.startsWith(p));
  let asOf = fixed;
  let doc: Record<string, unknown> | undefined;
  if (!controller.startsWith("did:key:")) {
    let notYet = false;
    try {
      if (opts.bodyStoredAt !== undefined && opts.resolveDidAt !== undefined) {
        let then: Record<string, unknown> | null | undefined;
        try {
          then = await opts.resolveDidAt(controller, opts.bodyStoredAt);
        } catch (e) {
          if (!isDidVersionNotFound(e)) throw e;
          then = null;
        }
        if (then === null) notYet = true;
        else if (then !== undefined) {
          doc = then;
          asOf = true;
        }
      }
      if (!notYet) doc ??= await (opts.resolveDid ?? resolveDidDocument)(controller);
    } catch (e) {
      throw new RecordBodyError(
        "authorUnresolvable",
        `the record's author ${author} does not resolve to a DID document: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // History read, and it holds no document of the author's at that instant.
    if (notYet) refuseSignature(`${author} had no DID document when the host stored the body (${opts.bodyStoredAt})`);
  }
  const resolved = doc;
  const proof = await verifyTrustTaskProof(document, {
    expectedProofPurpose: "assertionMethod",
    ...(resolved !== undefined ? { resolveDid: async () => resolved } : {}),
  });
  if (!proof.verified || !proof.signer) {
    if (!asOf) {
      throw new RecordBodyError(
        "authorUnverifiable",
        `the record's author cannot be verified: its proof does not hold against ${author}'s current DID document ` +
          `(${proof.reason ?? "unverified"}), and the document as it stood when the host stored the body could not be resolved`,
      );
    }
    refuseSignature(proof.reason ?? "unverified");
  }

  const unknown = Object.keys(document).filter((k) => k !== "proof" && !BODY_MEMBERS.has(k));
  if (unknown.length > 0) {
    throw new RecordBodyError("malformed", `the record body is malformed: unknown member ${unknown.join(", ")}`);
  }
  const body = { ...document } as unknown as SealedRecordBody & { proof?: unknown };
  delete body.proof;
  checkBody(body);

  if (proof.signer !== body.author) {
    refuseSignature(`it verifies for ${proof.signer}, but the body names ${body.author} as its author`);
  }
  if (body.roomId !== readAt.roomId || body.key !== readAt.key || body.version !== readAt.version) {
    throw new RecordBodyError(
      "relocated",
      `the record body was signed for ${body.roomId} / ${body.key} @ v${body.version}, ` +
        `but was read from ${readAt.roomId} / ${readAt.key} @ v${readAt.version}`,
    );
  }
  if (hostAuthor !== undefined && hostAuthor !== body.author) {
    throw new RecordBodyError(
      "authorMismatch",
      `the record body is signed by ${body.author}, but the host recorded ${hostAuthor} as its author`,
    );
  }
  return Object.freeze(body) as VerifiedRecordBody;
}
