// @openvtc/vti-tsp-js — WebCrypto/hpke-js TSP primitives, byte-compatible with
// affinidi-tsp (the crate the VTA links). v1 = HPKE-Auth only (RFC 9180,
// DHKEM-X25519 + HKDF-SHA256 + ChaCha20Poly1305) + binary CESR framing.
//
// Layers (built incrementally):
//   cesr/wire       — binary CESR frame primitives          [done]
//   message/envelope — the -E envelope (HPKE info)          [done]
//   crypto/hpke     — HPKE-Auth seal/open via hpke-js       [done]
//   crypto/sign     — Ed25519 sign/verify via @noble        [done]
//   message/direct  — pack/unpack (seal+sign / verify+open) [done]
//   vid             — VID → keys resolution                 [todo]

export * as cesr from "./cesr/wire.js";
export * as hpke from "./crypto/hpke.js";
export * as sign from "./crypto/sign.js";
export {
  encodeEnvelope,
  decodeEnvelope,
  type Envelope,
  type DecodedEnvelope,
} from "./message/envelope.js";
export {
  pack,
  packWithHops,
  unpack,
  sha256,
  type MessageType,
  type PackKeys,
  type UnpackKeys,
  type PackedMessage,
  type UnpackedMessage,
} from "./message/direct.js";
export {
  packRouted,
  packNested,
  nextHop,
  MAX_HOPS,
  type RouteStep,
} from "./message/routed.js";
