// Putting a file in a room, and getting one out — end to end.
//
// The same flow as `pnm rooms file put` / `get` (`vta-cli-common::commands::rooms`),
// step for step, so a file either writes opens in the other:
//
//   put  present(read) → rooms/info (sealed tier, files enabled) → present(write)
//        → file-key(seal) → seal locally → upload begin / chunks / commit
//        → sign the record body → rooms/keys/seal → records/put/0.2 naming the blob,
//          re-sealing for the version the host actually assigned.
//   get  present(read) → records/get/0.2 → rooms/keys/open → verify the body
//        → the record names the file's blob → blobs/get → file-key(open)
//        → each chunk checked against the manifest, then opened → finish.
//
// ## What runs where
//
// Two senders, because there are two recipients: the member's own **VTA**
// (presentations, the file key, sealing and opening the record body) and the
// room's **host** (everything else). The host channel is signed by the same DID
// the VTA minted the presentations for — a presentation is granted to its
// caller, and a host refuses one presented by anyone else.
//
// The cipher is `@openvtc/vti-rooms-wasm`, passed in rather than imported, so
// this module carries no wasm and runs under test with the real one or a fake.
//
// ## A file key never leaves this module's caller
//
// It is fetched, handed to the sealer or opener, and dropped. JavaScript cannot
// zero a string; what it can do is not keep one, not log one and not return
// one, and nothing here does.

import { base64url } from "@openvtc/vti-didcomm-js";

import type { SigningIdentity } from "../siop/self-issued.js";
import type { TaskParty, TrustTaskSender } from "../vta/channel.js";
import { roomsKeysOpen, roomsKeysPresent, roomsKeysSeal, type Presentation, type RoomAction } from "./index.js";
import {
  roomsBlobsChunk,
  roomsBlobsGet,
  roomsBlobsUploadAbort,
  roomsBlobsUploadBegin,
  roomsBlobsUploadChunk,
  roomsBlobsUploadCommit,
  roomsHeadVersion,
  roomsInfo,
  roomsKeysFileKey,
  roomsRecordsGetV2,
  roomsRecordsPutV2,
  sameDigest,
  signRecordBody,
  verifyRecordBody,
  type FileManifest,
  type SealedRecordBody,
} from "./files.js";

// ── The cipher, as this module needs it ─────────────────────────────────────

/** `FileSealer` from `@openvtc/vti-rooms-wasm`, structurally. */
export interface FileSealerHandle {
  push(data: Uint8Array): Uint8Array;
  finish(): Uint8Array;
  manifests(): string;
  readonly chunkSize: number;
  free(): void;
}

/** `FileOpener` from `@openvtc/vti-rooms-wasm`, structurally. */
export interface FileOpenerHandle {
  push(chunk: Uint8Array): Uint8Array;
  finish(): string;
  readonly verified: boolean;
  free(): void;
}

/** The two classes this engine uses, as `@openvtc/vti-rooms-wasm` exports them. */
export interface RoomFileCipher {
  FileSealer: {
    withKey(
      roomId: string,
      fileId: string,
      epoch: bigint,
      key: string,
      size: bigint,
      padme: boolean,
      name: string,
      mediaType?: string | null,
      segmentSize?: number | null,
    ): FileSealerHandle;
  };
  FileOpener: {
    withKey(roomId: string, key: string, fileManifest: string, blobManifest: string): FileOpenerHandle;
  };
}

// ── Parties and progress ────────────────────────────────────────────────────

export interface RoomFileContext {
  roomId: string;
  /** The wallet's DID: the presentations are minted for it and it signs both legs. */
  holder: TaskParty;
  /** Signs the record body. Its DID must be `holder.did` — the body's author. */
  signing: SigningIdentity;
  vta: { did: string; sender: TrustTaskSender };
  host: { did: string; sender: TrustTaskSender };
  cipher: RoomFileCipher;
  /** Stage changes and chunk counts, for a progress bar. Never carries data. */
  onProgress?: (p: RoomFileProgress) => void;
  /** Checked between steps; an abort mid-upload releases what `begin` reserved. */
  signal?: AbortSignal;
}

export type RoomFileStage =
  | "presenting"
  | "checking"
  | "sealing"
  | "uploading"
  | "writing"
  | "reading"
  | "downloading"
  | "verifying";

export interface RoomFileProgress {
  stage: RoomFileStage;
  /** Chunks done and in all, while uploading or downloading. */
  done?: number;
  total?: number;
}

/** Why a file could not be put or got, in words that name the party at fault. */
export class RoomFileError extends Error {
  constructor(
    readonly code:
      | "openRoom"
      | "filesDisabled"
      | "tooLarge"
      | "noFile"
      | "blobNotNamed"
      | "hostMisbehaved"
      | "notVerified"
      | "versionRace"
      | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "RoomFileError";
  }
}

/**
 * The largest file this engine seals in one piece.
 *
 * The blob manifest — every chunk's digest — has to exist before an upload can
 * begin, so a whole file is sealed before its first chunk moves and its
 * ciphertext is held meanwhile. That bounds what a browser should attempt well
 * below the transfer ceiling (1 GiB); `pnm rooms file put` takes larger ones.
 */
export const ROOM_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** How many times a write re-seals for the version the host assigned. The CLI's figure. */
const SEALED_WRITE_ATTEMPTS = 4;

function check(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RoomFileError("aborted", "stopped before it finished");
}

function randomId(bytes: number): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A `DigestMultibase` (sha2-256 multihash, base58btc) of `bytes`, for comparing with `sameDigest`. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const mh = new Uint8Array(2 + hash.length);
  mh.set([0x12, 0x20], 0);
  mh.set(hash, 2);
  return `u${base64url.encode(mh)}`;
}

async function present(ctx: RoomFileContext, action: RoomAction): Promise<Presentation> {
  const { presentation } = await roomsKeysPresent(ctx.vta.sender, {
    holder: ctx.holder,
    service: { did: ctx.vta.did },
    roomId: ctx.roomId,
    action,
  });
  return presentation;
}

// ── Put ─────────────────────────────────────────────────────────────────────

export interface RoomFileInput {
  /** The uploader's name for it. Sealed: only members see it. */
  name: string;
  mediaType?: string;
  bytes: Uint8Array;
  title?: string;
  description?: string;
  tags?: string[];
  /** Pad the ciphertext (Padmé) so its length says less about the file's. */
  padme?: boolean;
}

export interface RoomFilePut {
  /** The new record's key — opaque, as a sealed tier requires. */
  key: string;
  version: number;
  blobRef: string;
  size: number;
}

/**
 * Seal `file`, upload its ciphertext to the host, and write the record that
 * names it. Resolves once the record is stored at the version it was sealed for.
 */
export async function putRoomFile(ctx: RoomFileContext, file: RoomFileInput): Promise<RoomFilePut> {
  const progress = (p: RoomFileProgress) => ctx.onProgress?.(p);
  const hostCall = { holder: ctx.holder, service: { did: ctx.host.did }, roomId: ctx.roomId };
  if (file.bytes.length > ROOM_FILE_MAX_BYTES) {
    throw new RoomFileError(
      "tooLarge",
      `${file.bytes.length} bytes is more than the ${ROOM_FILE_MAX_BYTES} this wallet seals in one piece; ` +
        "`pnm rooms file put` takes larger files",
    );
  }

  progress({ stage: "presenting" });
  const read = await present(ctx, "read");
  check(ctx.signal);
  progress({ stage: "checking" });
  const info = await roomsInfo(ctx.host.sender, { ...hostCall, presentation: read });
  if (info.visibility === "open") {
    throw new RoomFileError(
      "openRoom",
      "this room is open: its records are cleartext, and a file's manifest belongs inside a sealed body. " +
        "Files go in attributed and private rooms.",
    );
  }
  if (!info.limits.filesEnabled) {
    throw new RoomFileError("filesDisabled", `${ctx.host.did} does not accept files in this room`);
  }
  const write = await present(ctx, "write");
  check(ctx.signal);

  // A fresh id for every file: the segment nonces are counters, so two files
  // under one key would reuse them.
  progress({ stage: "sealing" });
  const fileId = randomId(32);
  const fileKey = await roomsKeysFileKey(ctx.vta.sender, {
    holder: ctx.holder,
    service: { did: ctx.vta.did },
    roomId: ctx.roomId,
    fileId,
    purpose: "seal",
  });
  let ciphertext: Uint8Array;
  let chunkSize: number;
  let manifests: { blob: Parameters<typeof roomsBlobsUploadBegin>[1]["manifest"]; file: FileManifest };
  const sealer = ctx.cipher.FileSealer.withKey(
    ctx.roomId,
    fileId,
    BigInt(fileKey.epoch),
    fileKey.key,
    BigInt(file.bytes.length),
    file.padme ?? false,
    file.name,
    file.mediaType ?? null,
    null,
  );
  try {
    const head = sealer.push(file.bytes);
    const tail = sealer.finish();
    ciphertext = new Uint8Array(head.length + tail.length);
    ciphertext.set(head, 0);
    ciphertext.set(tail, head.length);
    chunkSize = sealer.chunkSize;
    manifests = JSON.parse(sealer.manifests());
  } finally {
    sealer.free();
  }
  const limit = Math.min(
    info.limits.room?.maxFileBytes ?? Infinity,
    info.usage.member?.limits.maxFileBytes ?? info.limits.member?.maxFileBytes ?? Infinity,
  );
  if (manifests.blob.size > limit) {
    throw new RoomFileError(
      "tooLarge",
      `sealed, this file is ${manifests.blob.size} bytes, and ${ctx.host.did} accepts at most ${limit} in this room`,
    );
  }
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < ciphertext.length; at += chunkSize) chunks.push(ciphertext.subarray(at, at + chunkSize));
  check(ctx.signal);

  progress({ stage: "uploading", done: 0, total: chunks.length });
  const begun = await roomsBlobsUploadBegin(ctx.host.sender, { ...hostCall, presentation: write, manifest: manifests.blob });
  let blobRef: string;
  if (begun.alreadyCommitted === true) {
    blobRef = manifests.file.blobRef;
  } else {
    const uploadId = begun.uploadId;
    const parties = { holder: ctx.holder, service: { did: ctx.host.did } };
    try {
      let done = 0;
      for (const index of begun.missing) {
        check(ctx.signal);
        const chunk = chunks[index];
        if (!Number.isSafeInteger(index) || chunk === undefined) {
          throw new RoomFileError("hostMisbehaved", `${ctx.host.did} asked for chunk ${index}, which does not exist`);
        }
        await roomsBlobsUploadChunk(ctx.host.sender, {
          ...parties,
          uploadId,
          index,
          digestMultibase: manifests.blob.chunks.chunkDigests[index]!,
          data: chunk,
        });
        progress({ stage: "uploading", done: ++done, total: begun.missing.length });
      }
    } catch (e) {
      // Release what `begin` reserved rather than leaving it to expire.
      await roomsBlobsUploadAbort(ctx.host.sender, { ...parties, uploadId }).catch(() => undefined);
      throw e;
    }
    blobRef = (await roomsBlobsUploadCommit(ctx.host.sender, { ...parties, uploadId })).blobRef;
  }
  if (!sameDigest(blobRef, manifests.file.blobRef)) {
    throw new RoomFileError(
      "hostMisbehaved",
      `${ctx.host.did} committed ${blobRef}, not the blob sealed here (${manifests.file.blobRef})`,
    );
  }

  progress({ stage: "writing" });
  const key = randomId(16);
  const body: SealedRecordBody = {
    roomId: ctx.roomId,
    key,
    version: 1,
    author: ctx.holder.did,
    ...(file.title !== undefined ? { title: file.title } : {}),
    ...(file.description !== undefined ? { description: file.description } : {}),
    ...(file.tags !== undefined ? { tags: file.tags } : {}),
    file: manifests.file,
  };
  const version = await writeSealed(ctx, read, write, body, blobRef);
  return { key, version, blobRef, size: file.bytes.length };
}

/**
 * Sign the body, seal it through the VTA and put it, re-sealing for the version
 * the host assigned whenever that is not the one sealed for.
 *
 * The version is bound into both the record's associated data and its signed
 * body, and the host assigns it from a room-wide counter, so it is predicted
 * from the room's head and a miss is corrected by a rewrite — over exactly the
 * version that landed, never blind.
 */
async function writeSealed(
  ctx: RoomFileContext,
  read: Presentation,
  write: Presentation,
  body: SealedRecordBody,
  blobRef: string,
): Promise<number> {
  const vta = { holder: ctx.holder, service: { did: ctx.vta.did } };
  const host = { holder: ctx.holder, service: { did: ctx.host.did } };
  const head = await roomsHeadVersion(ctx.host.sender, { ...host, roomId: ctx.roomId, presentation: read });
  let intended = head + 1;
  // Create-only: a record key this fresh exists nowhere, and if it somehow did
  // this must not overwrite it.
  let expected = 0;
  let landed = 0;
  for (let attempt = 0; attempt < SEALED_WRITE_ATTEMPTS; attempt++) {
    const signed = await signRecordBody({ ...body, version: intended }, ctx.signing);
    const sealed = await roomsKeysSeal(ctx.vta.sender, {
      ...vta,
      roomId: ctx.roomId,
      key: body.key,
      version: intended,
      plaintext: base64url.encode(signed),
    });
    landed = (
      await roomsRecordsPutV2(ctx.host.sender, {
        ...host,
        roomId: ctx.roomId,
        presentation: write,
        key: body.key,
        sealed,
        blobRef,
        expectedVersion: expected,
      })
    ).version;
    if (landed === intended) return landed;
    expected = landed;
    intended = landed + 1;
  }
  throw new RoomFileError(
    "versionRace",
    `${body.key} is stored at version ${landed} but sealed for another, so it does not open: the room kept ` +
      `moving under ${SEALED_WRITE_ATTEMPTS} attempts. Put the file again.`,
  );
}

// ── Get ─────────────────────────────────────────────────────────────────────

export interface RoomFileGot {
  /** The author's manifest: name, media type, size, digest. Untrusted text — render it inert. */
  file: FileManifest;
  /** Who signed the record body. */
  author: string;
  title?: string;
  description?: string;
  tags?: string[];
  version: number;
}

/**
 * Fetch a record's file and check it is the one its author signed.
 *
 * **What `sink` receives is provisional.** Each piece has opened under the
 * file's key, but the file is the one its author signed only once the whole of
 * it has hashed to the author's digest. A caller holds what `sink` was given
 * somewhere temporary and releases it — saves it, renders it, hands it on —
 * only once this resolves. If it rejects, the caller discards everything `sink`
 * received. (`FileManifest`'s *Reading* rules; `data-rooms-files.md` §4.1.)
 */
export async function getRoomFile(
  ctx: RoomFileContext,
  key: string,
  sink: (provisional: Uint8Array) => void,
): Promise<RoomFileGot> {
  const progress = (p: RoomFileProgress) => ctx.onProgress?.(p);
  const vta = { holder: ctx.holder, service: { did: ctx.vta.did } };
  const host = { holder: ctx.holder, service: { did: ctx.host.did } };

  progress({ stage: "presenting" });
  const read = await present(ctx, "read");
  check(ctx.signal);
  progress({ stage: "reading" });
  const record = await roomsRecordsGetV2(ctx.host.sender, { ...host, roomId: ctx.roomId, presentation: read, key });
  if (!record.sealed) {
    throw new RoomFileError(
      "noFile",
      "the record has no sealed body: it is on an open room, or it has been retracted",
    );
  }
  const plaintext = await roomsKeysOpen(ctx.vta.sender, {
    ...vta,
    roomId: ctx.roomId,
    key,
    version: record.version,
    sealed: record.sealed,
  });
  const verified = await verifyRecordBody(
    base64url.decode(plaintext),
    { roomId: ctx.roomId, key, version: record.version },
    record.author,
  );
  const file = verified.file;
  if (!file) throw new RoomFileError("noFile", "the record carries no file");
  // The manifest is the author's; whether the record still names its blob is
  // the host's. A record that no longer names it has had its file released.
  if (!(record.blobs ?? []).some((b) => sameDigest(b, file.blobRef))) {
    throw new RoomFileError(
      "blobNotNamed",
      "the host does not name the file's blob on this record; it may have been released",
    );
  }
  check(ctx.signal);

  const started = await roomsBlobsGet(ctx.host.sender, {
    ...host,
    roomId: ctx.roomId,
    presentation: read,
    blobRef: file.blobRef,
  });
  const blob = started.manifest;
  const fileKey = await roomsKeysFileKey(ctx.vta.sender, {
    ...vta,
    roomId: ctx.roomId,
    fileId: file.fileId,
    purpose: "open",
    epoch: file.epoch,
  });
  // `withKey` checks the host's blob manifest against the author's file
  // manifest — the blob the author named, and the shape their segment size and
  // length give — before any byte is opened under it.
  const opener = ctx.cipher.FileOpener.withKey(ctx.roomId, fileKey.key, JSON.stringify(file), JSON.stringify(blob));
  try {
    const total = blob.chunks.chunkCount;
    progress({ stage: "downloading", done: 0, total });
    for (let index = 0; index < total; index++) {
      check(ctx.signal);
      const chunk = await roomsBlobsChunk(ctx.host.sender, { ...host, downloadId: started.downloadId, index });
      // Against the manifest, not against the digest the host sent beside the
      // bytes: both are the host's word, and only one of them is committed.
      if (!sameDigest(await digestOf(chunk.data), blob.chunks.chunkDigests[index]!)) {
        throw new RoomFileError("hostMisbehaved", `chunk ${index} from ${ctx.host.did} does not match the manifest`);
      }
      sink(opener.push(chunk.data));
      progress({ stage: "downloading", done: index + 1, total });
    }
    progress({ stage: "verifying" });
    opener.finish();
    if (!opener.verified) {
      throw new RoomFileError("notVerified", "the file did not verify against the digest its author signed");
    }
  } finally {
    opener.free();
  }
  return {
    file,
    author: verified.author,
    version: record.version,
    ...(verified.title !== undefined ? { title: verified.title } : {}),
    ...(verified.description !== undefined ? { description: verified.description } : {}),
    ...(verified.tags !== undefined ? { tags: [...verified.tags] } : {}),
  };
}
