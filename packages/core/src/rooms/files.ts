// Room files — `rooms/blobs/*`, `rooms/info`, `rooms/records/get/0.3`, `rooms/records/put/0.4`,
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

// The one shape taken from the package rather than `../specs/`: FileManifest is
// a definition in `rooms/_shared/0.1/blobs.schema.json` that no task schema
// references (it travels inside a sealed record body), so no generated task
// module re-exports it. Type-only, so nothing of the prebuilt modules loads.
import type { FileManifest } from "../specs/_shared/components.js";
import { base64url, multibase } from "@openvtc/vti-didcomm-js";

import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import type { RoomsCaller } from "./index.js";
import { memberExt } from "./member.js";

import {
  TYPE_URI as UPLOAD_CHUNK,
  RESPONSE_TYPE_URI as UPLOAD_CHUNK_RESPONSE,
  type RoomsBlobsUploadChunkPayload,
  type RoomsBlobsUploadChunkResponsePayload,
} from "../specs/rooms/blobs/upload/chunk/0.2/payload.js";
import {
  TYPE_URI as UPLOAD_COMMIT,
  RESPONSE_TYPE_URI as UPLOAD_COMMIT_RESPONSE,
  type RoomsBlobsUploadCommitPayload,
  type RoomsBlobsUploadCommitResponsePayload,
} from "../specs/rooms/blobs/upload/commit/0.2/payload.js";
import {
  TYPE_URI as UPLOAD_ABORT,
  RESPONSE_TYPE_URI as UPLOAD_ABORT_RESPONSE,
  type RoomsBlobsUploadAbortPayload,
  type RoomsBlobsUploadAbortResponsePayload,
} from "../specs/rooms/blobs/upload/abort/0.2/payload.js";
import type { RoomsBlobsChunkResponsePayload } from "../specs/rooms/blobs/chunk/0.1/payload.js";
import {
  TYPE_URI as KEYS_FILE_KEY,
  RESPONSE_TYPE_URI as KEYS_FILE_KEY_RESPONSE,
  type RoomsKeysFileKeyPayload,
  type RoomsKeysFileKeyResponsePayload,
} from "../specs/rooms/keys/file-key/0.2/payload.js";

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
// Lives in `./record-body.ts`, which carries no task URI, so that the console
// can verify what it reads without importing this module. Re-exported here for
// the offscreen document's existing imports.

export * from "./record-body.js";

// ── The rest of the offscreen document's room-file surface ──────────────────

export * from "./host-channel.js";
export * from "./file-engine.js";
