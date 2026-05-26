// Public surface for the wallet's sealed-bundle openers.
//
// The wallet calls `openAdminRotationBundle` on the armored response from a
// VTA's `provision-integration/1.0/provision-integration-result` reply,
// using the same Ed25519 seed it signed the request with. Returns the
// freshly-minted long-term admin DID + private keys the wallet adopts as
// its holder identity.

export { decodeArmor, buildChunkAad } from "./armor.js";
export { crc24, crc24ToBytes } from "./crc24.js";
export { hpkeOpen, type HpkeOpenInput } from "./hpke.js";
export { openSealedBundle, openBundle, openAdminRotationBundle, type OpenedBundle } from "./open.js";
export type {
  AdminRotationPayload,
  ArmoredChunk,
  AssertionProof,
  ChunkPlaintext,
  DidKeyMaterial,
  HpkeSealed,
  KeyPair,
  ProducerAssertion,
  SealedBundle,
  SealedPayloadV1,
  TemplateBootstrapPayload,
  VtaTrustBundle,
} from "./types.js";
