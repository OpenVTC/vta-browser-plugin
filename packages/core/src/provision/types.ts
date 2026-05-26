// Wire + decoded shapes for the VTA's sealed-bundle pipeline.
//
// Mirrors the on-the-wire structs in
// `verifiable-trust-infrastructure/vta-sdk/src/sealed_transfer/`:
//   - `bundle.rs`: SealedBundle, ArmoredChunk
//   - `hpke.rs`:   HpkeSealed
//   - `chunk.rs`:  ChunkPlaintext
//   - `bundle.rs`: SealedPayloadV1 (externally-tagged enum, snake_case)
//   - `template_bootstrap.rs`: AdminRotationPayload, DidKeyMaterial, KeyPair
//
// Field-name discipline: the sealed envelope is CBOR + camelCase-on-wire was
// never agreed for the bundle interior — Rust's serde defaults to snake_case
// field names and the ports across languages depend on those names. This file
// keeps snake_case verbatim for any type that crosses the CBOR boundary, and
// converts to a typed camelCase summary at the orchestrator (`open.ts`).

/** One armored block parsed from the BEGIN/END framing. */
export interface ArmoredChunk {
  chunkIndex: number;
  totalChunks: number;
  /** CBOR-encoded HpkeSealed bytes. */
  sealedBytes: Uint8Array;
}

/** A bundle of armored chunks sharing a Bundle-Id. */
export interface SealedBundle {
  /** 16 raw bytes. Decoded from the lowercase-hex `Bundle-Id:` header. */
  bundleId: Uint8Array;
  /** Verbatim from the armor header (`sha256` for VTA bundles today). */
  digestAlgo: string;
  chunks: ArmoredChunk[];
}

/** Wire layout for one HPKE-sealed chunk (CBOR-encoded inside ArmoredChunk.sealedBytes). */
export interface HpkeSealed {
  /** X25519 ephemeral public key from the KEM encapsulation (32 bytes). */
  kem_encap: Uint8Array;
  /** AEAD-sealed bytes (ciphertext || tag). */
  aead_ciphertext: Uint8Array;
}

/** Wire shape for one chunk's plaintext (CBOR-encoded inside the HPKE seal). */
export interface ChunkPlaintext {
  version: number;
  bundle_id: Uint8Array;
  chunk_index: number;
  total_chunks: number;
  /** Producer's `did:key` — present only on chunk 0. */
  producer_did?: string;
  /** Producer assertion — present only on chunk 0. */
  producer_assertion?: ProducerAssertion;
  /** CBOR-encoded fragment of the full SealedPayloadV1. */
  payload_fragment: Uint8Array;
}

export interface ProducerAssertion {
  producer_did: string;
  proof: AssertionProof;
}

/** Tagged enum on `type` — `did_signed`, `attested`, or `pinned_only`. */
export type AssertionProof =
  | { type: "did_signed"; did: string; signature_b64: string; verification_method: string }
  | { type: "attested"; format: string; quote_b64: string }
  | { type: "pinned_only" };

/** Top-level sealed payload, externally-tagged enum.
 *
 *  Wire shape is a CBOR map with exactly one key — the variant tag in
 *  snake_case — whose value is the variant's body. Only the variants the
 *  wallet might encounter are typed here; opening any other variant is a
 *  programmer error and `parseSealedPayloadV1` returns the raw tag for the
 *  call site to handle. */
export type SealedPayloadV1 =
  | { kind: "admin_rotation"; body: AdminRotationPayload }
  | { kind: "template_bootstrap"; body: TemplateBootstrapPayload }
  | { kind: "other"; tag: string; body: unknown };

/** Payload carried by `SealedPayloadV1::AdminRotation`.
 *
 *  Per the canonical Trust Task spec, the wallet pulls `admin.did` +
 *  `admin.signing_key.private_key_multibase` (+ ka_key.private_key_multibase
 *  for DIDComm) and discards the rest. */
export interface AdminRotationPayload {
  /** VTA-issued VC (opaque JSON to the wallet — verified once at bundle open
   *  by callers that care; the wallet does not). */
  authorization: unknown;
  /** Key material for the freshly-minted admin DID. */
  admin: DidKeyMaterial;
  /** URL the wallet can reach the VTA's REST API at, if any. */
  vta_url?: string;
  /** VTA identity material — DID, DID document, optional log. */
  vta_trust: VtaTrustBundle;
}

/** Payload carried by `SealedPayloadV1::TemplateBootstrap`. The wallet does
 *  not currently consume this variant; typed for completeness so a
 *  template-driven bootstrap doesn't silently fall into the `other` slot. */
export interface TemplateBootstrapPayload {
  authorization: unknown;
  secrets: Record<string, DidKeyMaterial>;
  config: unknown;
}

export interface DidKeyMaterial {
  did: string;
  signing_key: KeyPair;
  ka_key: KeyPair;
}

export interface KeyPair {
  key_id: string;
  public_key_multibase: string;
  private_key_multibase: string;
}

export interface VtaTrustBundle {
  vta_did: string;
  vta_did_document: unknown;
  vta_did_log?: string;
}
