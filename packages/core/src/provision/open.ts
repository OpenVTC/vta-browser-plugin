// Orchestrate the sealed-bundle open pipeline.
//
// armored text → SealedBundle → (per chunk) CBOR(HpkeSealed) → HPKE open →
// CBOR(ChunkPlaintext) → reassemble fragments → CBOR(SealedPayloadV1) →
// AdminRotationPayload | TemplateBootstrapPayload | other variant.
//
// Mirrors `open_bundle` in `vta-sdk/src/sealed_transfer/mod.rs`. The wallet
// only needs the `AdminRotation` variant for M2C; the `TemplateBootstrap`
// case is typed-through for future integration use (mobile companion, etc.)
// and any unknown variant lands in the `other` slot for the caller to
// reject with a clear error.

import { ed25519 } from "@noble/curves/ed25519.js";
import { Decoder } from "cbor-x";

import { buildChunkAad, decodeArmor } from "./armor.js";
import { hpkeOpen } from "./hpke.js";
import type {
  AdminRotationPayload,
  ChunkPlaintext,
  HpkeSealed,
  SealedBundle,
  SealedPayloadV1,
  TemplateBootstrapPayload,
} from "./types.js";

const CHUNK_VERSION = 1;

// One shared decoder. `copyBuffers: true` so the returned Uint8Arrays own
// independent storage — we slice into byte fields and don't want surprise
// aliasing into the original bundle bytes.
const cbor = new Decoder({ mapsAsObjects: true, copyBuffers: true });

export interface OpenedBundle {
  bundleId: Uint8Array;
  digestAlgo: string;
  payload: SealedPayloadV1;
}

/** Open the first bundle in `armored` using the recipient's Ed25519 seed.
 *
 *  The seed is converted to its X25519 secret via Montgomery clamping
 *  (same derivation the Rust side uses; see
 *  `affinidi_crypto::ed25519::ed25519_private_to_x25519`). The wallet's
 *  ephemeral Ed25519 seed produced at onboarding is what gets passed here.
 *
 *  If the armored input contains multiple bundles (different Bundle-Ids),
 *  this opens only the first. The provision-integration reply has exactly
 *  one bundle today; multi-bundle armored payloads are reserved for future
 *  flows.
 */
export async function openSealedBundle(
  armored: string,
  edSeed: Uint8Array,
): Promise<OpenedBundle> {
  if (edSeed.length !== 32) {
    throw new Error(`openSealedBundle: edSeed must be 32 bytes (got ${edSeed.length})`);
  }
  const x25519Secret = ed25519.utils.toMontgomerySecret(edSeed);
  const bundles = decodeArmor(armored);
  const first = bundles[0]!;
  return openBundle(first, x25519Secret);
}

/** Lower-level: open a pre-parsed SealedBundle with an X25519 secret. */
export async function openBundle(
  bundle: SealedBundle,
  x25519Secret: Uint8Array,
): Promise<OpenedBundle> {
  if (bundle.chunks.length === 0) {
    throw new Error("openBundle: no chunks");
  }

  // 1. Per chunk: CBOR(HpkeSealed) → HPKE open → CBOR(ChunkPlaintext).
  const plaintexts: ChunkPlaintext[] = [];
  for (const chunk of bundle.chunks) {
    const sealed = decodeHpkeSealed(chunk.sealedBytes);
    const aad = buildChunkAad({
      version: CHUNK_VERSION,
      bundleId: bundle.bundleId,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      digestAlgo: bundle.digestAlgo,
    });
    const ptBytes = await hpkeOpen({
      recipientSecret: x25519Secret,
      kemEncap: sealed.kem_encap,
      ciphertext: sealed.aead_ciphertext,
      aad,
    });
    const pt = decodeChunkPlaintext(ptBytes);
    if (
      !bytesEqual(pt.bundle_id, bundle.bundleId) ||
      pt.chunk_index !== chunk.chunkIndex ||
      pt.total_chunks !== chunk.totalChunks ||
      pt.version !== CHUNK_VERSION
    ) {
      throw new Error("openBundle: inner ChunkPlaintext header disagrees with armor header");
    }
    plaintexts.push(pt);
  }

  // 2. Reassemble in chunk-index order. Duplicate/missing detection:
  //    after sorting, chunk_index[i] must equal i.
  plaintexts.sort((a, b) => a.chunk_index - b.chunk_index);
  const total = plaintexts[0]!.total_chunks;
  if (plaintexts.length !== total) {
    throw new Error(
      `openBundle: have ${plaintexts.length} chunks, expected ${total}`,
    );
  }
  for (let i = 0; i < plaintexts.length; i++) {
    if (plaintexts[i]!.chunk_index !== i) {
      throw new Error(`openBundle: chunk index gap or duplicate at position ${i}`);
    }
  }
  const totalLen = plaintexts.reduce((sum, p) => sum + p.payload_fragment.length, 0);
  const payloadBytes = new Uint8Array(totalLen);
  let off = 0;
  for (const p of plaintexts) {
    payloadBytes.set(p.payload_fragment, off);
    off += p.payload_fragment.length;
  }

  // 3. CBOR(SealedPayloadV1). External tagging: a 1-key map whose key is
  //    the variant tag in snake_case.
  const raw = cbor.decode(payloadBytes) as Record<string, unknown>;
  const payload = parseSealedPayload(raw);

  return {
    bundleId: bundle.bundleId,
    digestAlgo: bundle.digestAlgo,
    payload,
  };
}

/** Convenience: open the bundle and assert it carries an `AdminRotation`
 *  variant, returning the typed payload. Throws if any other variant. */
export async function openAdminRotationBundle(
  armored: string,
  edSeed: Uint8Array,
): Promise<{ bundleId: Uint8Array; payload: AdminRotationPayload }> {
  const opened = await openSealedBundle(armored, edSeed);
  if (opened.payload.kind !== "admin_rotation") {
    const tag =
      opened.payload.kind === "other" ? opened.payload.tag : opened.payload.kind;
    throw new Error(
      `openAdminRotationBundle: expected admin_rotation variant, got '${tag}'`,
    );
  }
  return { bundleId: opened.bundleId, payload: opened.payload.body };
}

// ─── CBOR parsing of inner structs ───
//
// `cbor-x` returns plain JS objects with the field names from the CBOR map.
// We assert the field shapes by hand here rather than blanket-cast — a
// malformed bundle should fail with a clear error, not crash later on a
// missing field.

function decodeHpkeSealed(bytes: Uint8Array): HpkeSealed {
  const v = cbor.decode(bytes) as Record<string, unknown>;
  const kemEncap = v["kem_encap"];
  const aeadCiphertext = v["aead_ciphertext"];
  if (!(kemEncap instanceof Uint8Array)) {
    throw new Error("HpkeSealed: kem_encap missing or not bytes");
  }
  if (!(aeadCiphertext instanceof Uint8Array)) {
    throw new Error("HpkeSealed: aead_ciphertext missing or not bytes");
  }
  return { kem_encap: kemEncap, aead_ciphertext: aeadCiphertext };
}

function decodeChunkPlaintext(bytes: Uint8Array): ChunkPlaintext {
  const v = cbor.decode(bytes) as Record<string, unknown>;
  const version = v["version"];
  const bundleId = v["bundle_id"];
  const chunkIndex = v["chunk_index"];
  const totalChunks = v["total_chunks"];
  const payloadFragment = v["payload_fragment"];
  if (typeof version !== "number") throw new Error("ChunkPlaintext: version missing/wrong");
  if (!(bundleId instanceof Uint8Array) || bundleId.length !== 16) {
    throw new Error("ChunkPlaintext: bundle_id must be 16-byte bytes");
  }
  if (typeof chunkIndex !== "number") throw new Error("ChunkPlaintext: chunk_index missing");
  if (typeof totalChunks !== "number") throw new Error("ChunkPlaintext: total_chunks missing");
  if (!(payloadFragment instanceof Uint8Array)) {
    throw new Error("ChunkPlaintext: payload_fragment missing");
  }
  const out: ChunkPlaintext = {
    version,
    bundle_id: bundleId,
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
    payload_fragment: payloadFragment,
  };
  if (typeof v["producer_did"] === "string") {
    out.producer_did = v["producer_did"];
  }
  const pa = v["producer_assertion"];
  if (pa !== undefined) {
    out.producer_assertion = pa as NonNullable<ChunkPlaintext["producer_assertion"]>;
  }
  return out;
}

function parseSealedPayload(raw: Record<string, unknown>): SealedPayloadV1 {
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    throw new Error(
      `SealedPayloadV1: expected externally-tagged map with one key, got ${keys.length}`,
    );
  }
  const tag = keys[0] as string;
  const body = raw[tag] as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    throw new Error(`SealedPayloadV1: body for tag '${tag}' is not an object`);
  }
  switch (tag) {
    case "admin_rotation":
      return { kind: "admin_rotation", body: body as unknown as AdminRotationPayload };
    case "template_bootstrap":
      return {
        kind: "template_bootstrap",
        body: body as unknown as TemplateBootstrapPayload,
      };
    default:
      return { kind: "other", tag, body };
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
