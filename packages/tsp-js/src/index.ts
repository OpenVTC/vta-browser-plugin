// @openvtc/vti-tsp-js — WebCrypto/hpke-js TSP primitives, byte-compatible with
// affinidi-tsp (the crate the VTA links). v1 = HPKE-Auth only (RFC 9180,
// DHKEM-X25519 + HKDF-SHA256 + ChaCha20Poly1305) + binary CESR framing.
//
// Layers (built incrementally):
//   cesr/wire  — binary CESR frame primitives          [done]
//   envelope   — the -E envelope (HPKE info)            [todo]
//   hpke       — HPKE-Auth seal/open via hpke-js        [todo]
//   sign       — Ed25519 sign/verify via @noble         [todo]
//   direct     — pack/unpack (seal+sign / verify+open)  [todo]
//   vid        — VID → keys resolution                  [todo]

export * as cesr from "./cesr/wire.js";
