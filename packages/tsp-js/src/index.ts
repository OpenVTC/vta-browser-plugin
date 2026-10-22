// @openvtc/vti-tsp-js — pure-TS TSP primitives, byte-compatible with
// affinidi-tsp (the crate the VTA links). Binary CESR framing + RFC 9180 HPKE
// on @noble. No WebCrypto dependency: runs identically in browser, Node, and
// React Native (only `crypto.getRandomValues` is required of the runtime).
//
// ── Version ──
//
// This package speaks **TSP 1.0** (`YTSP-BAA`: HPKE-Base, `F` ciphertext, the
// ESSR sender field carrying the sender in every confidential payload, `--X`
// long counts, indexed signatures), and refuses every other MAJOR, the Rev 2
// and Rev 3 drafts included. See `revision.ts`.
//
// Layers:
//   cesr/wire        — binary CESR frame primitives
//   revision         — the keyless version gate
//   crypto/hpke      — HPKE Base + Auth seal/open via @noble
//   crypto/sign      — Ed25519 sign/verify via @noble
//   relationship     — the §7.2/§7.3 state machine, pure and storage-free
//   v1/              — envelope, fields, payload frame, control, pack/unpack
//   message/         — the public API

export * as cesr from "./cesr/wire.js";
export * as hpke from "./crypto/hpke.js";
export * as sign from "./crypto/sign.js";
export {
  isTsp,
  TSP_MAGIC_BYTE,
  TSP_MAGIC_BYTE_LONG,
} from "./cesr/wire.js";
export {
  describeRevision,
  describeVersion,
  isRevisionError,
  peekRevision,
  KNOWN_VERSIONS,
  SUPPORTED_MAJOR,
  TspRevisionError,
  type PeekedRevision,
} from "./revision.js";
export {
  decodeEnvelope,
  type Envelope,
  type DecodedEnvelope,
} from "./message/envelope.js";
export {
  pack,
  packWithHops,
  packInvite,
  packAccept,
  packCancel,
  unpack,
  sha256,
  type ApplicationKind,
  type ControlMessage,
  type ControlType,
  type MessageType,
  type PackKeys,
  type UnpackKeys,
  type PackedMessage,
  type UnpackedMessage,
} from "./message/direct.js";
export {
  admitsApplicationMessage,
  canSend,
  compareBytes,
  InvalidTransitionError,
  resolveAccept,
  resolveCancel,
  resolveInviteRace,
  transition,
  type AcceptOutcome,
  type CancelOutcome,
  type InviteRaceOutcome,
  type RelationshipEvent,
  type RelationshipState,
} from "./relationship.js";
export { referralSignedData, type Referral } from "./v1/control.js";
export { generateNonce } from "./v1/fields.js";
export {
  packRouted,
  packNested,
  nextHop,
  MAX_HOPS,
  type RouteStep,
} from "./message/routed.js";
