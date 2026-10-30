// Putting a file in a room, and getting one out — end to end.
//
// The same flow as `pnm rooms file put` / `get` (`vta-cli-common::commands::rooms`),
// step for step, so a file either writes opens in the other. **Every request
// the host receives is the member's** — completed by their VTA as the persona
// (`rooms/keys/act`, see `./act.ts`) — except a proxied upload's chunks, commit
// and abort, which are signed by a key minted here for that one upload:
//
//   put  rooms/info (tier, files enabled; who the member is)
//        → the file key: file-key(seal) on a sealed room; on an open room,
//          32 random bytes minted here → seal locally → upload begin/0.2
//          (proxied, naming the upload key) → chunks / commit under the upload key
//        → sealed: the VTA signs the record body as the member and seals it
//          (rooms/keys/seal/0.2) → records/put/0.3 naming the blob, re-sealing
//          for the version the host actually assigned.
//          open: records/put/0.4 (through rooms/keys/act/0.9), the manifest and
//          its key in `cleartext.file`, naming exactly that blob.
//   get  records/get/0.2 → sealed: rooms/keys/open → verify the body; open:
//        the manifest in `cleartext.file`, its key held to the tier
//        → the record names the file's blob → blobs/get/0.2 (proxied)
//        → the file key: file-key(open), or the open manifest's own
//        → each chunk (blobs/chunk, as the member) checked against the
//          manifest, then opened → finish.
//
// The wallet's own DID reaches no host: it is only the caller of the VTA tasks.
//
// ## Proxied, for now
//
// A browser asks for proxied transfer: it omits `directParts` on begin and
// asks `direct: false` on get. A direct transfer reaches the storage
// provider's origin, which the extension holds no permission for
// (`data-rooms-files.md` §8.5). The CLI keeps direct mode.
//
// The cipher is `@openvtc/vti-rooms-wasm`, passed in rather than imported, so
// this module carries no wasm and runs under test with the real one or a fake.
//
// ## A file key never leaves this module's caller
//
// It is fetched (or, on an open room, minted or read from the record), handed
// to the sealer or opener, and dropped. On an open room the key is in the
// record by design — the host and every member may open the file — but this
// module still neither logs nor returns it. JavaScript cannot
// zero a string; what it can do is not keep one, not log one and not return
// one, and nothing here does. The upload key is the same: minted, used for one
// upload's documents, and dropped.

import { base64url } from "@openvtc/vti-didcomm-js";

import { generateSigningIdentity, type SigningIdentity } from "../siop/self-issued.js";
import type { TrustTaskSender } from "../vta/channel.js";
import { roomsKeysOpenAt, roomsKeysRead, sealedAt } from "./index.js";
import {
  actAndSend,
  roomInfoAsMember,
  VersionRaceError,
  writeSealedAsMember,
  opaqueRecordKey,
  putCleartextAsMember,
  type PersonaRoom,
} from "./act.js";
import {
  readChunkReply,
  roomsBlobsUploadAbort,
  roomsBlobsUploadChunk,
  roomsBlobsUploadCommit,
  roomsKeysFileKey,
  sameDigest,
  verifyRecordBody,
  type FileManifest,
} from "./files.js";

import {
  TYPE_URI as UPLOAD_BEGIN,
  RESPONSE_TYPE_URI as UPLOAD_BEGIN_RESPONSE,
  type RoomsBlobsUploadBeginPayload,
  type RoomsBlobsUploadBeginResponsePayload,
} from "../specs/rooms/blobs/upload/begin/0.2/payload.js";
import {
  TYPE_URI as BLOBS_GET,
  RESPONSE_TYPE_URI as BLOBS_GET_RESPONSE,
  type RoomsBlobsGetResponsePayload,
} from "../specs/rooms/blobs/get/0.2/payload.js";
import {
  TYPE_URI as BLOBS_CHUNK,
  RESPONSE_TYPE_URI as BLOBS_CHUNK_RESPONSE,
  type RoomsBlobsChunkResponsePayload,
} from "../specs/rooms/blobs/chunk/0.1/payload.js";
import {
  TYPE_URI as RECORDS_GET,
  RESPONSE_TYPE_URI as RECORDS_GET_RESPONSE,
  type RoomsRecordsGetResponsePayload,
} from "../specs/rooms/records/get/0.2/payload.js";

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

export interface RoomFileContext extends PersonaRoom {
  /**
   * A channel to the host that signs with `key`: the upload's single-use key,
   * for a proxied upload's chunk, commit and abort documents.
   */
  uploadChannel(key: SigningIdentity): TrustTaskSender;
  cipher: RoomFileCipher;
  /** Stage changes and chunk counts, for a progress bar. Never carries data. */
  onProgress?: (p: RoomFileProgress) => void;
  /** Checked between steps; an abort mid-upload releases what `begin` reserved. */
  signal?: AbortSignal;
}

export type RoomFileStage =
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

/**
 * Whether `rooms/keys/{open,file-key}` refused for an epoch the member's agent
 * can repair from the host: `notDelivered` (it missed a commit) or
 * `beyondChain` (the record predates the member). Read from the declared code
 * and `details.reason` (0.2), never the message; `removed` is never repairable.
 */
function repairableEpoch(e: unknown): boolean {
  const payload = (e as { details?: unknown } | null)?.details as
    | { code?: unknown; details?: { reason?: unknown } }
    | undefined;
  const code = payload?.code;
  const reason = payload?.details?.reason;
  return (
    typeof code === "string" &&
    code.endsWith(":unknownEpoch") &&
    (reason === "notDelivered" || reason === "beyondChain")
  );
}

/**
 * Run `attempt`; if the agent refused it for an epoch it can repair, have the
 * agent repair it and try once more.
 *
 * `open` and `file-key` carry no host, so the agent cannot fetch what it is
 * missing for them. `rooms/keys/read` names the host and does exactly that
 * before it answers (rooms/keys/read/0.1, *Opening, and when it cannot*): it
 * applies the commits the host relays, or fetches the epoch links. So the repair
 * is one read of the same record; its answer is not needed, only what it did to
 * the agent's state. The agent stays the one party that repairs. Once only: what
 * a repair could not fix, the retry reports.
 */
async function withEpochRepair<T>(ctx: RoomFileContext, key: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!repairableEpoch(e)) throw e;
    await roomsKeysRead(ctx.vta.sender, {
      holder: ctx.holder,
      service: { did: ctx.vta.did },
      roomId: ctx.roomId,
      host: ctx.host.did,
      key,
      ...(ctx.member !== undefined ? { member: ctx.member } : {}),
    }).catch(() => undefined);
    return attempt();
  }
}

/** Why a file could not be put or got, in words that name the party at fault. */
export class RoomFileError extends Error {
  constructor(
    readonly code:
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

function check(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RoomFileError("aborted", "stopped before it finished");
}

function randomId(bytes: number): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A `DigestMultibase` (sha2-256 multihash, base64url) of `bytes`, for comparing with `sameDigest`. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const mh = new Uint8Array(2 + hash.length);
  mh.set([0x12, 0x20], 0);
  mh.set(hash, 2);
  return `u${base64url.encode(mh)}`;
}

// ── Put ─────────────────────────────────────────────────────────────────────

export interface RoomFileInput {
  /** The uploader's name for it. Sealed: only members see it — on an open room, the host too. */
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
  /** The new record's key — opaque, as a sealed tier requires (and on an open room too). */
  key: string;
  version: number;
  blobRef: string;
  size: number;
  /** The member the record was written as: the persona their VTA acted as. */
  author: string;
}

/**
 * Seal `file`, upload its ciphertext to the host, and write the record that
 * names it. Resolves once the record is stored at the version it was sealed for.
 */
export async function putRoomFile(ctx: RoomFileContext, file: RoomFileInput): Promise<RoomFilePut> {
  const progress = (p: RoomFileProgress) => ctx.onProgress?.(p);
  if (file.bytes.length > ROOM_FILE_MAX_BYTES) {
    throw new RoomFileError(
      "tooLarge",
      `${file.bytes.length} bytes is more than the ${ROOM_FILE_MAX_BYTES} this wallet seals in one piece; ` +
        "`pnm rooms file put` takes larger files",
    );
  }

  progress({ stage: "checking" });
  const { principal, info } = await roomInfoAsMember(ctx);
  const open = info.visibility === "open";
  if (!info.limits.filesEnabled) {
    throw new RoomFileError("filesDisabled", `${ctx.host.did} does not accept files in this room`);
  }
  check(ctx.signal);

  // A fresh id for every file: the segment nonces are counters, so two files
  // under one key would reuse them.
  progress({ stage: "sealing" });
  const fileId = randomId(32);
  // A sealed room's file key is derived from its storage key, by the VTA. An
  // open room has none: the key is minted here for this file alone, at the
  // room's current epoch, and the record carries it (`rooms/records/put/0.4`
  // Producer item 7).
  const fileKey = open
    ? { key: randomId(32), epoch: info.epoch }
    : await roomsKeysFileKey(ctx.vta.sender, {
        holder: ctx.holder,
        service: { did: ctx.vta.did },
        roomId: ctx.roomId,
        fileId,
        purpose: "seal",
        ...(ctx.member !== undefined ? { member: ctx.member } : {}),
      });
  let ciphertext: Uint8Array;
  let chunkSize: number;
  let manifests: { blob: RoomsBlobsUploadBeginPayload["manifest"]; file: FileManifest };
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
  // The upload key: minted here for this upload alone, from no key held for
  // anything else, and dropped when the upload ends.
  const uploadKey = generateSigningIdentity();
  // No presentation: the VTA inserts the member's `write`, as `act` requires.
  // No `directParts`: this client accepts proxied transfer only.
  const begin: Omit<RoomsBlobsUploadBeginPayload, "presentation"> = {
    roomId: ctx.roomId,
    uploadKey: uploadKey.did,
    manifest: manifests.blob,
  };
  const { reply: begun } = await actAndSend<RoomsBlobsUploadBeginResponsePayload>(
    ctx,
    UPLOAD_BEGIN,
    UPLOAD_BEGIN_RESPONSE,
    begin as unknown as Record<string, unknown>,
  );
  let blobRef: string;
  if (begun.alreadyCommitted === true) {
    blobRef = manifests.file.blobRef;
  } else {
    if (begun.mode !== "proxied") {
      throw new RoomFileError(
        "hostMisbehaved",
        `${ctx.host.did} answered a proxied-only upload in ${String(begun.mode)} mode`,
      );
    }
    const uploadId = begun.uploadId;
    const channel = ctx.uploadChannel(uploadKey);
    const parties = { holder: { did: uploadKey.did }, service: { did: ctx.host.did } };
    try {
      let done = 0;
      for (const index of begun.missing) {
        check(ctx.signal);
        const chunk = chunks[index];
        if (!Number.isSafeInteger(index) || chunk === undefined) {
          throw new RoomFileError("hostMisbehaved", `${ctx.host.did} asked for chunk ${index}, which does not exist`);
        }
        await roomsBlobsUploadChunk(channel, {
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
      await roomsBlobsUploadAbort(channel, { ...parties, uploadId }).catch(() => undefined);
      throw e;
    }
    blobRef = (await roomsBlobsUploadCommit(channel, { ...parties, uploadId })).blobRef;
  }
  if (!sameDigest(blobRef, manifests.file.blobRef)) {
    throw new RoomFileError(
      "hostMisbehaved",
      `${ctx.host.did} committed ${blobRef}, not the blob sealed here (${manifests.file.blobRef})`,
    );
  }

  progress({ stage: "writing" });
  const key = opaqueRecordKey();
  let version: number;
  if (open) {
    version = await putCleartextAsMember(ctx, {
      key,
      ...(file.title !== undefined ? { title: file.title } : {}),
      ...(file.description !== undefined ? { description: file.description } : {}),
      ...(file.tags !== undefined ? { tags: file.tags } : {}),
      file: { manifest: { ...manifests.file, fileKey: fileKey.key }, blobRef },
    });
    return { key, version, blobRef, size: file.bytes.length, author: principal };
  }
  try {
    version = await writeSealedAsMember(
      ctx,
      {
        roomId: ctx.roomId,
        key,
        author: principal,
        ...(file.title !== undefined ? { title: file.title } : {}),
        ...(file.description !== undefined ? { description: file.description } : {}),
        ...(file.tags !== undefined ? { tags: file.tags } : {}),
        file: manifests.file as unknown as Record<string, unknown>,
      },
      blobRef,
    );
  } catch (e) {
    if (e instanceof VersionRaceError) {
      throw new RoomFileError(
        "versionRace",
        `${e.key} is stored at version ${e.landed} but sealed for another, so it does not open: the room kept ` +
          `moving. Put the file again.`,
      );
    }
    throw e;
  }
  return { key, version, blobRef, size: file.bytes.length, author: principal };
}

// ── Get ─────────────────────────────────────────────────────────────────────

export interface RoomFileGot {
  /**
   * The author's manifest: name, media type, size, digest. Untrusted text —
   * render it inert. Never carries `fileKey`, which this module does not return.
   */
  file: FileManifest;
  /** Who signed the record body; on an open room, the author the host recorded. */
  author: string;
  /**
   * Whether `author` signed what is shown. An open room's record is not signed
   * by its author: there the manifest and the author are the host's word, and
   * the file matches the digest the record states, not one its author signed.
   */
  signed: boolean;
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

  progress({ stage: "reading" });
  const { principal, reply: record } = await actAndSend<RoomsRecordsGetResponsePayload>(
    ctx,
    RECORDS_GET,
    RECORDS_GET_RESPONSE,
    { roomId: ctx.roomId, key },
  );
  // An open room's record describes its file in the clear, key included
  // (`rooms/records/put/0.4`); a sealed room's, inside the body its author signed.
  const described = openFile(record) ?? (await sealedFile(ctx, key, record));
  const { file, carriedKey } = described;
  // The manifest is the author's; whether the record still names its blob is
  // the host's. A record that no longer names it has had its file released.
  if (!(record.blobs ?? []).some((b) => sameDigest(b, file.blobRef))) {
    throw new RoomFileError(
      "blobNotNamed",
      "the host does not name the file's blob on this record; it may have been released",
    );
  }
  check(ctx.signal);

  const { reply: started } = await actAndSend<RoomsBlobsGetResponsePayload>(ctx, BLOBS_GET, BLOBS_GET_RESPONSE, {
    roomId: ctx.roomId,
    blobRef: file.blobRef,
    direct: false,
  });
  const downloadId = started.downloadId;
  if (started.mode !== "proxied" || typeof downloadId !== "string") {
    throw new RoomFileError("hostMisbehaved", `${ctx.host.did} answered a proxied download with no download handle`);
  }
  const blob = started.manifest;
  const fileKey =
    carriedKey ??
    (
      await withEpochRepair(ctx, key, () =>
        roomsKeysFileKey(ctx.vta.sender, {
          ...vta,
          roomId: ctx.roomId,
          fileId: file.fileId,
          purpose: "open",
          epoch: file.epoch,
          ...(ctx.member !== undefined ? { member: ctx.member } : {}),
        }),
      )
    ).key;
  // `withKey` checks the host's blob manifest against the author's file
  // manifest — the blob the author named, and the shape their segment size and
  // length give — before any byte is opened under it. The manifest goes without
  // `fileKey`: the key is its own argument.
  const opener = ctx.cipher.FileOpener.withKey(ctx.roomId, fileKey, JSON.stringify(file), JSON.stringify(blob));
  try {
    const total = blob.chunks.chunkCount;
    progress({ stage: "downloading", done: 0, total });
    for (let index = 0; index < total; index++) {
      check(ctx.signal);
      // A chunk request names no room, so it names the member: the download is
      // theirs, opened by their own get.
      const { reply } = await actAndSend<RoomsBlobsChunkResponsePayload>(
        ctx,
        BLOBS_CHUNK,
        BLOBS_CHUNK_RESPONSE,
        { downloadId, index },
        principal,
      );
      const chunk = readChunkReply(ctx.host.did, index, reply);
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
      throw new RoomFileError(
        "notVerified",
        described.signed
          ? "the file did not verify against the digest its author signed"
          : "the file did not verify against the digest its record states",
      );
    }
  } finally {
    opener.free();
  }
  return {
    file,
    author: described.author,
    signed: described.signed,
    version: record.version,
    ...(described.title !== undefined ? { title: described.title } : {}),
    ...(described.description !== undefined ? { description: described.description } : {}),
    ...(described.tags !== undefined ? { tags: [...described.tags] } : {}),
  };
}

/** A record's file as its reader takes it: the manifest without `fileKey`, the key an open room carries, and who says so. */
interface DescribedFile {
  file: FileManifest;
  carriedKey?: string;
  author: string;
  signed: boolean;
  title?: string;
  description?: string;
  tags?: readonly string[];
}

/** A 32-byte key, base64url without padding — `FileManifest.fileKey`. */
const FILE_KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * An open room's file, from the record's `cleartext.file` — or `undefined` for
 * a record that has a sealed body or no cleartext file. Its `fileKey` is
 * required here (`FileManifest`, *Open room file key*): a manifest without one
 * is refused, never opened under a key from anywhere else.
 */
function openFile(record: RoomsRecordsGetResponsePayload): DescribedFile | undefined {
  if (record.sealed) return undefined;
  const cleartext = record.cleartext as Record<string, unknown> | undefined;
  const raw = cleartext?.file;
  if (raw === undefined || raw === null) {
    throw new RoomFileError("noFile", "the record carries no file, or it has been retracted");
  }
  if (typeof raw !== "object") throw new RoomFileError("hostMisbehaved", "the record's file manifest is not an object");
  const { fileKey, ...file } = raw as FileManifest & { fileKey?: unknown };
  if (typeof fileKey !== "string" || !FILE_KEY.test(fileKey)) {
    throw new RoomFileError("hostMisbehaved", "an open room's file manifest carries no usable `fileKey`");
  }
  const title = cleartext?.title;
  const description = cleartext?.description;
  const tags = Array.isArray(cleartext?.tags)
    ? (cleartext.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    file: file as FileManifest,
    carriedKey: fileKey,
    author: record.author ?? "an unnamed member",
    signed: false,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

/**
 * A sealed room's file, from the body its author signed — opened, and its
 * signed location checked, at the version the body was sealed at: a curation
 * moves a record past it (`SealedRecord.version`), and a record curated before
 * hosts kept that is found by the VTA, which says where it opened. A sealed
 * manifest carrying a `fileKey` is refused: its key is derived.
 */
async function sealedFile(
  ctx: RoomFileContext,
  key: string,
  record: RoomsRecordsGetResponsePayload,
): Promise<DescribedFile> {
  if (!record.sealed) throw new RoomFileError("noFile", "the record has no sealed body: it has been retracted");
  const sealed = record.sealed as typeof record.sealed & { version?: number };
  const { plaintext, sealedAt: openedAt } = await withEpochRepair(ctx, key, () =>
    roomsKeysOpenAt(ctx.vta.sender, {
      holder: ctx.holder,
      service: { did: ctx.vta.did },
      roomId: ctx.roomId,
      key,
      version: sealedAt(sealed, record.version),
      sealed,
      ...(ctx.member !== undefined ? { member: ctx.member } : {}),
    }),
  );
  const verified = await verifyRecordBody(
    base64url.decode(plaintext),
    { roomId: ctx.roomId, key, version: openedAt },
    record.author,
  );
  const file = verified.file;
  if (!file) throw new RoomFileError("noFile", "the record carries no file");
  if ((file as { fileKey?: unknown }).fileKey !== undefined) {
    throw new RoomFileError("hostMisbehaved", "a sealed room's file manifest carries a `fileKey`; its key is derived");
  }
  return {
    file,
    author: verified.author,
    signed: true,
    ...(verified.title !== undefined ? { title: verified.title } : {}),
    ...(verified.description !== undefined ? { description: verified.description } : {}),
    ...(verified.tags !== undefined ? { tags: verified.tags } : {}),
  };
}
