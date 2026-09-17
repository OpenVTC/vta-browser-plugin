// @openvtc/vti-tsp-js — pure-TS TSP primitives, byte-compatible with
// affinidi-tsp (the crate the VTA links). Binary CESR framing + RFC 9180 HPKE
// on @noble. No WebCrypto dependency: runs identically in browser, Node, and
// React Native (only `crypto.getRandomValues` is required of the runtime).
//
// ── Revisions ──
//
// This package **packs spec Rev 3** (`YTSP-AAC`: HPKE-Base, `F` ciphertext,
// ESSR sender field, `--X` long counts, indexed signatures) and **reads Rev 3
// and Rev 2**. `unpack` dispatches on the version marker every message carries;
// `pack` has nothing to dispatch on and does not try. See `revision.ts` for why
// that asymmetry is the whole design, and `rev2/reader.ts` for what a Rev 2
// message costs us to read.
//
// Layers:
//   cesr/wire        — binary CESR frame primitives, shared by both revisions
//   revision         — the keyless version-marker discriminator
//   crypto/hpke      — HPKE Base + Auth seal/open via @noble
//   crypto/sign      — Ed25519 sign/verify via @noble
//   relationship     — the §7.2/§7.3 state machine, pure and storage-free
//   rev3/            — Rev 3 envelope, fields, payload frame, control, pack/unpack
//   rev2/            — Rev 2 reader; frozen, decode-only
//   message/         — the public API and the dispatcher

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
  isRevisionError,
  peekRevision,
  KNOWN_MINORS,
  SUPPORTED_MAJOR,
  TspRevisionError,
  type PeekedRevision,
  type Revision,
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
export { referralSignedData, type Referral } from "./rev3/control.js";
export { generateNonce } from "./rev3/fields.js";
export {
  packRouted,
  packNested,
  nextHop,
  MAX_HOPS,
  type RouteStep,
} from "./message/routed.js";
