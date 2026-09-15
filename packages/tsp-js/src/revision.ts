// Which revision of the TSP specification framed this message.
//
// The whole dual-revision design rests on one property: **the revision is
// readable without any keys, at a fixed offset, before anything else is
// parsed.** A TSP message opens with the `-E` count code and then the version
// marker:
//
//   f8 40 13   -E count (short form, 3 bytes)   ← or `fb …` long form, 6 bytes
//   61 34 8f   YTSP genus marker
//   f8 00 01   version count code: MAJOR=0, MINOR=1  → Rev 2
//   f8 00 02   version count code: MAJOR=0, MINOR=2  → Rev 3
//
// So `peekRevision` reads at most nine bytes and never touches a key. That is
// what makes "receive both, pack one" honest rather than a guess: an inbound
// message *says* what it is, and we dispatch on what it says.
//
// ── Why the two MINOR values are not symmetric ──
//
// Rev 2 is the only MINOR we match exactly. Everything else at MAJOR 0 is read
// as Rev 3, because §9.1 makes MAJOR the field that gates processability and
// MINOR one that no implementation may refuse a message on — the ToIP reference
// discards MINOR entirely. Upstream Rev 3 ships `YTSP-ABA`, which is MINOR 64
// under this (MAJOR.MINOR) reading and MINOR 1 / PATCH 0 under the published
// three-component one; affinidi-tsp emits `AAC` = 2. Both must parse as Rev 3,
// and so must whatever the resolution of that argument turns out to be, so
// enumerating known-good MINORs would be the wrong shape. See
// `KNOWN_MINORS` for what the list is actually for.
//
// ── What this is not ──
//
// This is not negotiation. We pack Rev 3 unconditionally; a Rev 2 peer cannot
// read what we send, and nothing here pretends otherwise. `peekRevision` exists
// so that a Rev 2 message we are *given* is read correctly and reported as
// such, rather than dying at the ciphertext selector with "missing F
// ciphertext field" — a crypto-layer error for a problem that is nothing of the
// sort.

import * as wire from "./cesr/wire.js";

/** A revision of the TSP specification, as carried by a message's version
 *  marker. */
export type Revision = "rev2" | "rev3";

/** The MAJOR version this package implements. MAJOR is the only component that
 *  gates processability (§9.1). */
export const SUPPORTED_MAJOR = 0;

/** MINOR values we can name, for diagnostics only — never for admission.
 *
 *  A MINOR absent from here still parses (as Rev 3); what the list buys is the
 *  ability to say "this frame declared an unrecognised MINOR" when a parse then
 *  fails, instead of blaming the ciphertext. */
export const KNOWN_MINORS: Readonly<Record<number, string>> = Object.freeze({
  1: "Rev 2 (YTSP-AAB)",
  2: "Rev 3 (YTSP-AAC)",
  64: "Rev 3 as published upstream (YTSP-ABA)",
});

/** A frame whose revision could not be established, or is not one we speak.
 *
 *  Carries a machine-readable `code` because the caller's decision — drop,
 *  report, or ask the peer to upgrade — must not be made by matching on a
 *  message string (stack guide R3.7). */
export class TspRevisionError extends Error {
  /** Stable discriminator. */
  readonly code = "E_TSP_REVISION" as const;
  /** MAJOR the frame declared, when it was readable. */
  readonly major: number | undefined;
  /** MINOR the frame declared, when it was readable. */
  readonly minor: number | undefined;

  constructor(message: string, major?: number, minor?: number) {
    super(message);
    this.name = "TspRevisionError";
    this.major = major;
    this.minor = minor;
  }
}

/** Structural test for {@link TspRevisionError}, on the code rather than on
 *  `instanceof` — the class can arrive from a different copy of this package
 *  (a bundled build beside a linked one), and the code cannot. */
export function isRevisionError(err: unknown): err is TspRevisionError {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "E_TSP_REVISION";
}

/** What {@link peekRevision} found. */
export interface PeekedRevision {
  /** Which codec should parse this frame. */
  revision: Revision;
  /** MAJOR as carried. Always {@link SUPPORTED_MAJOR} — a mismatch throws. */
  major: number;
  /** MINOR as carried, unjudged. */
  minor: number;
  /** Whether {@link KNOWN_MINORS} names this MINOR. A `false` here is not an
   *  error; it is the note a later parse failure should cite. */
  recognised: boolean;
}

/**
 * Read a message's revision from its version marker, without keys.
 *
 * Throws {@link TspRevisionError} if the bytes are not a TSP frame at all, if
 * the version marker is malformed, or if MAJOR is one we do not implement.
 */
export function peekRevision(bytes: Uint8Array): PeekedRevision {
  if (!wire.isTsp(bytes)) {
    throw new TspRevisionError("tsp: not a TSP frame (no -E count code)");
  }

  // The version marker sits immediately after the `-E` count code, whose width
  // is the one thing the leading byte tells us: short is 3 bytes, long is 6.
  // Both revisions' long spellings lead with 0xFB, so this is revision-agnostic
  // — which it has to be, since it runs before the revision is known.
  const cur: wire.Cursor = { pos: bytes[0] === wire.TSP_MAGIC_BYTE_LONG ? 6 : 3 };

  const version = wire.readVersion(bytes, cur);
  if (version === undefined) {
    throw new TspRevisionError("tsp: missing or malformed YTSP version marker");
  }
  if (version.major !== SUPPORTED_MAJOR) {
    throw new TspRevisionError(
      `tsp: message declares MAJOR ${version.major}; this implementation speaks MAJOR ${SUPPORTED_MAJOR}`,
      version.major,
      version.minor,
    );
  }

  return {
    revision: version.minor === wire.REV2_MINOR ? "rev2" : "rev3",
    major: version.major,
    minor: version.minor,
    recognised: Object.hasOwn(KNOWN_MINORS, version.minor),
  };
}

/** Human-readable name for a peeked revision, for error text and diagnostics. */
export function describeRevision(peeked: PeekedRevision): string {
  return KNOWN_MINORS[peeked.minor] ?? `MAJOR ${peeked.major}, MINOR ${peeked.minor} (unrecognised)`;
}
