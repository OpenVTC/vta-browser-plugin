// Room files — `rooms/blobs/*`, `rooms/info`, `rooms/records/{get,put}/0.2`,
// `rooms/keys/file-key`, and the signed record body a file's manifest lives in.
//
// A file in a room is a record plus a blob. The record is an ordinary sealed
// record whose signed body carries the file's manifest (its name, size, the
// plaintext's digest, the key's epoch); the blob is the file's ciphertext, moved
// to and from the room's host in chunks and named on the record by `blobRef`.
// The design is `data-rooms-files.md` in verifiable-trust-infrastructure.
//
// ## Who may import this
//
// **The offscreen document, and nothing else.** `roomsKeysFileKey` returns one
// file's key — material, not authority, and material that never expires: a
// leaked key opens that file's ciphertext for as long as the ciphertext exists.
// The extension keeps it in the one context that is its own and is not a page:
// the offscreen document asks the VTA for it, seals or opens the file there
// with `vti-rooms-wasm`, and hands the console verified plaintext, never a key.
// CI fails the build if this task's URI appears in any bundle but the
// offscreen entry chunk. That is why this is its own subpath rather than more of
// `@openvtc/pnm-core/rooms`, which the console imports.
//
// ## Two recipients, as for the rest of `rooms/*`
//
// `rooms/keys/file-key` goes to the member's **own VTA**. Everything else goes
// to the room's **host**, which stores ciphertext it cannot read. The member's
// own requests reach it completed by their VTA as the member
// (`rooms/keys/act`, `./act.ts`); a proxied upload's chunks, commit and abort
// are signed by that upload's single-use key.
//
// ## A file's manifest is believed only through the author's signature
//
// The host serves the blob manifest and could serve any blob it likes. What
// makes a download the file its author put there is the *file* manifest inside
// the author's signed record body: the blob must be the one it names, and the
// plaintext must hash to the digest it states. `verifyRecordBody` is the only
// way to a `VerifiedRecordBody`, so code that trusts a body's `file` cannot
// have skipped the signature.

import type { FileManifest } from "@openvtc/trust-tasks/_shared/components";
import { base64url, multibase } from "@openvtc/vti-didcomm-js";

import type { SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { RoomsCaller } from "./index.js";
import { memberExt } from "./member.js";

import {
  TYPE_URI as UPLOAD_CHUNK,
  RESPONSE_TYPE_URI as UPLOAD_CHUNK_RESPONSE,
  type RoomsBlobsUploadChunkPayload,
  type RoomsBlobsUploadChunkResponsePayload,
} from "@openvtc/trust-tasks/rooms/blobs/upload/chunk/0.2/payload";
import {
  TYPE_URI as UPLOAD_COMMIT,
  RESPONSE_TYPE_URI as UPLOAD_COMMIT_RESPONSE,
  type RoomsBlobsUploadCommitPayload,
  type RoomsBlobsUploadCommitResponsePayload,
} from "@openvtc/trust-tasks/rooms/blobs/upload/commit/0.2/payload";
import {
  TYPE_URI as UPLOAD_ABORT,
  RESPONSE_TYPE_URI as UPLOAD_ABORT_RESPONSE,
  type RoomsBlobsUploadAbortPayload,
  type RoomsBlobsUploadAbortResponsePayload,
} from "@openvtc/trust-tasks/rooms/blobs/upload/abort/0.2/payload";
import type { RoomsBlobsChunkResponsePayload } from "@openvtc/trust-tasks/rooms/blobs/chunk/0.1/payload";
import {
  TYPE_URI as KEYS_FILE_KEY,
  RESPONSE_TYPE_URI as KEYS_FILE_KEY_RESPONSE,
  type RoomsKeysFileKeyPayload,
  type RoomsKeysFileKeyResponsePayload,
} from "@openvtc/trust-tasks/rooms/keys/file-key/0.2/payload";

export type { FileManifest };

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

// ── The host, under an upload's single-use key ──────────────────────────────
//
// A proxied upload's begin is the member's act (completed by their VTA through
// `rooms/keys/act`); its chunks, commit and abort are signed by the `uploadKey`
// the begin named — a `did:key` minted for that one upload, so the member's key
// holder never signs over a file's bytes (`rooms/blobs/upload/begin/0.2`). The
// host binds the key to the upload and charges the member. `holder` below is
// that key's DID, and `sender` a channel signed by it.

/** Send one chunk. Idempotent: resending a stored chunk is a success. */
export async function roomsBlobsUploadChunk(
  sender: TrustTaskSender,
  params: RoomsCaller & { uploadId: string; index: number; digestMultibase: string; data: Uint8Array },
): Promise<RoomsBlobsUploadChunkResponsePayload> {
  const payload: RoomsBlobsUploadChunkPayload = {
    uploadId: params.uploadId,
    index: params.index,
    digestMultibase: params.digestMultibase,
    data: base64url.encode(params.data),
  };
  return call(sender, params, UPLOAD_CHUNK, UPLOAD_CHUNK_RESPONSE, "rooms/blobs/upload/chunk/0.2", payload);
}

/** Finish an upload: the host checks the whole blob against the manifest and stores it. */
export async function roomsBlobsUploadCommit(
  sender: TrustTaskSender,
  params: RoomsCaller & { uploadId: string },
): Promise<RoomsBlobsUploadCommitResponsePayload> {
  const payload: RoomsBlobsUploadCommitPayload = { uploadId: params.uploadId };
  return call(sender, params, UPLOAD_COMMIT, UPLOAD_COMMIT_RESPONSE, "rooms/blobs/upload/commit/0.2", payload);
}

/** Abandon an upload and release what `begin` reserved. Safe to repeat. */
export async function roomsBlobsUploadAbort(
  sender: TrustTaskSender,
  params: RoomsCaller & { uploadId: string },
): Promise<RoomsBlobsUploadAbortResponsePayload> {
  const payload: RoomsBlobsUploadAbortPayload = { uploadId: params.uploadId };
  return call(sender, params, UPLOAD_ABORT, UPLOAD_ABORT_RESPONSE, "rooms/blobs/upload/abort/0.2", payload);
}

/**
 * Read a `rooms/blobs/chunk/0.1` reply. A reply for another index is refused
 * here. The chunk's digest is the host's claim; the caller compares the bytes
 * with the manifest's, and the AEAD decides.
 */
export function readChunkReply(
  hostDid: string,
  index: number,
  res: RoomsBlobsChunkResponsePayload,
): { index: number; digestMultibase: string; data: Uint8Array } {
  if (res.index !== index) {
    throw new Error(`${hostDid} answered chunk ${res.index} to a request for ${index}`);
  }
  return { index: res.index, digestMultibase: res.digestMultibase, data: base64url.decode(res.data) };
}

// ── The member's own VTA ────────────────────────────────────────────────────

/** A file key is 32 bytes. */
const FILE_KEY_BYTES = 32;

/**
 * One file's key, from the member's own VTA. **Offscreen document only.**
 *
 * `purpose: "seal"` derives under the room's current epoch and returns it, for
 * the uploader to write into the manifest. `purpose: "open"` takes the
 * manifest's `epoch`. The VTA audits each release with the room, file and
 * purpose, never the key.
 *
 * The key comes back as the VTA sent it (base64url), which is what
 * `FileSealer.withKey` and `FileOpener.withKey` take. It is checked to be 32
 * bytes here, so a malformed answer is named as the VTA's.
 */
export async function roomsKeysFileKey(
  sender: TrustTaskSender,
  params: RoomsCaller & {
    roomId: string;
    fileId: string;
    purpose: "seal" | "open";
    epoch?: number;
    /** The member whose group derives it, where the VTA holds more than one of the room. */
    member?: string;
  },
): Promise<{ key: string; epoch: number }> {
  const payload: RoomsKeysFileKeyPayload = {
    roomId: params.roomId,
    fileId: params.fileId,
    purpose: params.purpose,
    ...(params.epoch !== undefined ? { epoch: params.epoch } : {}),
    ...memberExt(params.member),
  };
  const res = await call<RoomsKeysFileKeyResponsePayload>(
    sender,
    params,
    KEYS_FILE_KEY,
    KEYS_FILE_KEY_RESPONSE,
    "rooms/keys/file-key/0.2",
    payload,
  );
  let bytes: Uint8Array;
  try {
    bytes = base64url.decode(res.key);
  } catch {
    throw new Error(`${params.service.did} returned a file key that is not base64url`);
  }
  if (bytes.length !== FILE_KEY_BYTES) {
    throw new Error(`${params.service.did} returned a file key of ${bytes.length} bytes, not ${FILE_KEY_BYTES}`);
  }
  bytes.fill(0);
  if (params.purpose === "open" && params.epoch !== undefined && res.epoch !== params.epoch) {
    throw new Error(
      `${params.service.did} released a key for epoch ${res.epoch} to open a file sealed under ${params.epoch}`,
    );
  }
  return { key: res.key, epoch: res.epoch };
}

// ── Digests ─────────────────────────────────────────────────────────────────

function decodeDigest(digest: string): Uint8Array | undefined {
  try {
    if (digest.startsWith("z")) return multibase.base58btcDecode(digest.slice(1));
    if (digest.startsWith("u")) return base64url.decode(digest.slice(1));
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Whether two `DigestMultibase` values name the same digest. Compared as decoded
 * bytes, never as strings: one digest has a base58btc (`z`) and a base64url (`u`)
 * spelling, and both conform.
 */
export function sameDigest(a: string, b: string): boolean {
  const x = decodeDigest(a);
  const y = decodeDigest(b);
  if (!x || !y || x.length !== y.length) return false;
  return x.every((byte, i) => byte === y[i]);
}

// ── The sealed record body ──────────────────────────────────────────────────
//
// `SealedRecordBody` in `rooms/_shared/0.1/room.schema.json`: the plaintext
// inside a sealed record, signed by its author. No host task carries it, so
// there is no generated type. This mirrors `vtc-client::rooms::body`, the
// workspace's one implementation, rule for rule.

/** Where a record was written or read: what the body's signature has to name. */
export interface RecordLocation {
  roomId: string;
  key: string;
  version: number;
}

/** A record body before signing or after verification. */
export interface SealedRecordBody extends RecordLocation {
  /** The DID that signs: the member, or the agent acting under an attenuated credential. */
  author: string;
  title?: string;
  description?: string;
  /** Markdown. Untrusted text from another member: render it inert. */
  body?: string;
  tags?: string[];
  /** Present when the record carries a file. Its `blobRef` is the one the record names. */
  file?: FileManifest;
}

const BODY_MEMBERS = new Set([
  "roomId", "key", "version", "author", "title", "description", "body", "tags", "file",
]);

// The schema's bounds, the same as the open tier's `cleartext`.
const MAX_KEY = 512;
const MAX_TITLE = 512;
const MAX_DESCRIPTION = 2048;
const MAX_BODY = 1_048_576;
const MAX_TAGS = 32;
const MAX_TAG = 64;

export type RecordBodyErrorKind = "malformed" | "signature" | "relocated" | "authorMismatch" | "signing";

/** Why a body could not be signed, or was refused on reading. */
export class RecordBodyError extends Error {
  constructor(
    readonly kind: RecordBodyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RecordBodyError";
  }
}

const chars = (s: string) => [...s].length;

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
  if (body.file !== undefined && (typeof body.file !== "object" || body.file === null)) {
    bad("file is not a manifest");
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
  if (body.file !== undefined) out.file = body.file;
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
 * Check an opened record's body before anything in it is shown or trusted.
 *
 * `plaintext` is what `rooms/keys/open` returned, decoded. `readAt` is where the
 * record was read from. `hostAuthor` is the author the host recorded: present on
 * an `attributed` room, absent on a `private` one.
 *
 * Refuses, rather than returning a body with a warning, when the body is not a
 * `SealedRecordBody` or names an unknown member; carries no proof, or one that
 * does not verify for `author` under `assertionMethod`; names another location
 * than `readAt`; or is signed by someone other than `hostAuthor`.
 *
 * One proof, `eddsa-jcs-2022`: what every writer in the workspace produces. The
 * Rust reader also takes `ecdsa-jcs-2019` and proof sets; this one refuses them
 * as unverifiable rather than accepting what it cannot check.
 */
export async function verifyRecordBody(
  plaintext: Uint8Array,
  readAt: RecordLocation,
  hostAuthor: string | undefined,
  opts: { resolveDid?: (did: string) => Promise<Record<string, unknown>> } = {},
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

  const proof = await verifyTrustTaskProof(document, {
    expectedProofPurpose: "assertionMethod",
    ...(opts.resolveDid ? { resolveDid: opts.resolveDid } : {}),
  });
  if (!proof.verified || !proof.signer) {
    throw new RecordBodyError(
      "signature",
      `the record body's signature does not hold: ${proof.reason ?? "unverified"}`,
    );
  }

  const unknown = Object.keys(document).filter((k) => k !== "proof" && !BODY_MEMBERS.has(k));
  if (unknown.length > 0) {
    throw new RecordBodyError("malformed", `the record body is malformed: unknown member ${unknown.join(", ")}`);
  }
  const body = { ...document } as unknown as SealedRecordBody & { proof?: unknown };
  delete body.proof;
  checkBody(body);

  if (proof.signer !== body.author) {
    throw new RecordBodyError(
      "signature",
      `the record body's signature does not hold: it verifies for ${proof.signer}, but the body names ${body.author} as its author`,
    );
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

// ── The rest of the offscreen document's room-file surface ──────────────────

export * from "./host-channel.js";
export * from "./file-engine.js";
