// OpenPGP-style ASCII armor decoder for VTA sealed bundles.
//
// Port of `vta-sdk/src/sealed_transfer/armor.rs`. The wire shape is one or
// more BEGIN/END blocks; blocks sharing a `Bundle-Id:` header belong to the
// same bundle. The armor headers themselves are not signed — they reach the
// AEAD layer as AAD (built by the per-chunk caller), so a tampered header
// makes HPKE open fail rather than the armor parser.
//
// Frame:
//   -----BEGIN VTA SEALED BUNDLE-----
//   Version: 1
//   Bundle-Id: <32 hex chars>
//   Chunk: 1/N
//   Digest-Algo: sha256
//                                            <-- blank line
//   <STANDARD base64, 64 chars/line>
//   =<base64 of 3-byte CRC24 (big-endian)>
//   -----END VTA SEALED BUNDLE-----
//
// STANDARD base64 (not URL-safe) — the armor format predates anything
// URL-aware and matches PGP precedent.

import { base64 } from "@scure/base";
import type { ArmoredChunk, SealedBundle } from "./types.js";
import { crc24 } from "./crc24.js";

const BEGIN = "-----BEGIN VTA SEALED BUNDLE-----";
const END = "-----END VTA SEALED BUNDLE-----";
const SUPPORTED_VERSION = 1;

/** Recognised armor headers. Unknown headers are rejected at parse time so a
 *  future header that would participate in AAD cannot be silently dropped by
 *  this parser — bumping the `Version:` line is the path for adding new ones. */
const KNOWN_HEADERS = new Set(["Version", "Bundle-Id", "Chunk", "Digest-Algo"]);

interface ParsedBlock {
  bundleId: Uint8Array;
  digestAlgo: string;
  chunkIndex: number;
  totalChunks: number;
  sealedBytes: Uint8Array;
}

/** Decode armored input into one or more SealedBundles, grouped by Bundle-Id. */
export function decodeArmor(input: string): SealedBundle[] {
  const lines = input.split(/\r?\n/);
  const bundles: SealedBundle[] = [];

  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? "").trim() !== BEGIN) {
      i++;
      continue;
    }
    const bodyStart = i + 1;
    let j = bodyStart;
    while (j < lines.length && (lines[j] ?? "").trim() !== END) j++;
    if (j >= lines.length) {
      throw new Error("armor: unterminated BEGIN block");
    }
    const block = parseBlock(lines.slice(bodyStart, j));
    const existing = bundles.find((b) => bytesEqual(b.bundleId, block.bundleId));
    if (existing) {
      if (existing.digestAlgo !== block.digestAlgo) {
        throw new Error("armor: digest_algo differs across chunks of the same bundle");
      }
      existing.chunks.push({
        chunkIndex: block.chunkIndex,
        totalChunks: block.totalChunks,
        sealedBytes: block.sealedBytes,
      });
    } else {
      bundles.push({
        bundleId: block.bundleId,
        digestAlgo: block.digestAlgo,
        chunks: [
          {
            chunkIndex: block.chunkIndex,
            totalChunks: block.totalChunks,
            sealedBytes: block.sealedBytes,
          },
        ],
      });
    }
    i = j + 1;
  }

  if (bundles.length === 0) {
    throw new Error("armor: no BEGIN blocks found");
  }
  return bundles;
}

function parseBlock(lines: string[]): ParsedBlock {
  let idx = 0;

  let version: number | undefined;
  let bundleId: Uint8Array | undefined;
  let chunk: { index: number; total: number } | undefined;
  let digestAlgo: string | undefined;

  // Header lines, terminated by a blank line.
  while (idx < lines.length) {
    const raw = lines[idx] ?? "";
    const trimmed = raw.replace(/\s+$/, "");
    idx++;
    if (trimmed.length === 0) break;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      throw new Error(`armor: bad header: '${trimmed}'`);
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!KNOWN_HEADERS.has(key)) {
      throw new Error(`armor: unknown header '${key}' (rejecting forward-compat hazard)`);
    }
    switch (key) {
      case "Version": {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n)) throw new Error(`armor: bad Version: ${value}`);
        version = n;
        break;
      }
      case "Bundle-Id": {
        bundleId = hexDecode(value);
        if (bundleId.length !== 16) {
          throw new Error(`armor: Bundle-Id must be 16 bytes (got ${bundleId.length})`);
        }
        break;
      }
      case "Chunk": {
        const slash = value.indexOf("/");
        if (slash < 0) throw new Error(`armor: bad Chunk header: ${value}`);
        const oneBased = Number.parseInt(value.slice(0, slash), 10);
        const total = Number.parseInt(value.slice(slash + 1), 10);
        if (
          !Number.isFinite(oneBased) ||
          !Number.isFinite(total) ||
          oneBased === 0 ||
          oneBased > total
        ) {
          throw new Error(`armor: chunk ${oneBased}/${total} out of range`);
        }
        chunk = { index: oneBased - 1, total };
        break;
      }
      case "Digest-Algo": {
        digestAlgo = value;
        break;
      }
    }
  }

  if (version === undefined) throw new Error("armor: missing Version");
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`armor: unsupported version ${version}`);
  }
  if (!bundleId) throw new Error("armor: missing Bundle-Id");
  if (!chunk) throw new Error("armor: missing Chunk header");
  if (!digestAlgo) throw new Error("armor: missing Digest-Algo");

  // Body: base64 lines until the `=<base64>` CRC line.
  let b64 = "";
  let crcB64: string | undefined;
  while (idx < lines.length) {
    const raw = lines[idx] ?? "";
    const trimmed = raw.replace(/\s+$/, "");
    idx++;
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("=")) {
      crcB64 = trimmed.slice(1);
      break;
    }
    b64 += trimmed;
  }
  if (crcB64 === undefined) throw new Error("armor: missing CRC line");

  const sealedBytes = base64.decode(b64);
  const crcBytes = base64.decode(crcB64);
  if (crcBytes.length !== 3) {
    throw new Error(`armor: CRC payload must be 3 bytes (got ${crcBytes.length})`);
  }
  const expected =
    ((crcBytes[0] as number) << 16) | ((crcBytes[1] as number) << 8) | (crcBytes[2] as number);
  const got = crc24(sealedBytes);
  if (got !== expected) {
    throw new Error(
      `armor: CRC24 mismatch (expected 0x${expected.toString(16)}, got 0x${got.toString(16)})`,
    );
  }

  return {
    bundleId,
    digestAlgo,
    chunkIndex: chunk.index,
    totalChunks: chunk.total,
    sealedBytes,
  };
}

/** Build the AAD bytes for one chunk's HPKE seal. Mirrors
 *  `ChunkPlaintext::aad` in `chunk.rs`:
 *
 *      version || bundle_id || chunk_index_be || total_chunks_be ||
 *        digest_algo_len(u8) || digest_algo
 *
 *  `digest_algo_len` is capped at 255 (the Rust side uses `u8::MAX`); for
 *  `sha256`/`sha512`/`blake3` this never trips. */
export function buildChunkAad(args: {
  version: number;
  bundleId: Uint8Array;
  chunkIndex: number;
  totalChunks: number;
  digestAlgo: string;
}): Uint8Array {
  if (args.bundleId.length !== 16) {
    throw new Error(`buildChunkAad: bundleId must be 16 bytes (got ${args.bundleId.length})`);
  }
  const algoBytes = new TextEncoder().encode(args.digestAlgo);
  const algoLen = Math.min(algoBytes.length, 255);
  const buf = new Uint8Array(1 + 16 + 2 + 2 + 1 + algoLen);
  let p = 0;
  buf[p++] = args.version;
  buf.set(args.bundleId, p);
  p += 16;
  buf[p++] = (args.chunkIndex >> 8) & 0xff;
  buf[p++] = args.chunkIndex & 0xff;
  buf[p++] = (args.totalChunks >> 8) & 0xff;
  buf[p++] = args.totalChunks & 0xff;
  buf[p++] = algoLen;
  buf.set(algoBytes.subarray(0, algoLen), p);
  return buf;
}

/** Decode a (lowercase or mixed-case) hex string into bytes. The armor format
 *  emits lowercase only, but accepting both costs nothing and matches the
 *  Rust parser's behaviour. */
function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex: odd length: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    const hi = hexNibble(s.charCodeAt(i));
    const lo = hexNibble(s.charCodeAt(i + 1));
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  throw new Error(`hex: non-hex byte 0x${c.toString(16)}`);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
