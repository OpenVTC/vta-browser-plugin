// The version gate: which TSP version framed this message, and do we speak it.
//
// The version is readable without any keys, at a fixed offset, before anything
// else is parsed. A TSP message opens with the `-E` count code and then the
// version marker:
//
//   f8 40 13   -E count (short form, 3 bytes)   ← or `fb …` long form, 6 bytes
//   61 34 8f   YTSP genus marker
//   f8 10 00   version count code: MAJOR=1, MINOR=0  → 1.0 (`YTSP-BAA`)
//
// So `peekRevision` reads at most nine bytes and never touches a key.
//
// ── One version ──
//
// This package speaks TSP 1.0 and refuses everything at another MAJOR, which
// is what §9.1 makes MAJOR for. That includes both drafts it used to read:
// Rev 2 (`YTSP-AAB`, 0.1) and Rev 3 (`YTSP-AAC`, 0.2). Rev 3 is the same wire
// as 1.0 bar one payload rule — 1.0 requires the sender VID in every
// confidential payload, where Rev 3 let HPKE-Base write the NULL VID — but a
// draft frame is refused here rather than read under rules it was not written
// to, in step with affinidi-tsp 0.3 and the ToIP reference `tsp_sdk` 0.16.
//
// A different MINOR at MAJOR 1 is carried, not refused: no implementation may
// refuse a message on MINOR. `KNOWN_VERSIONS` exists so that a refusal, or a
// later parse failure, can name what the frame declared.

import * as wire from "./cesr/wire.js";

/** The MAJOR version this package implements. MAJOR is the only component that
 *  gates processability (§9.1). */
export const SUPPORTED_MAJOR = wire.TSP_VERSION.major;

/** Versions we can name, keyed `"MAJOR.MINOR"`, for diagnostics only — never
 *  for admission. */
export const KNOWN_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  "0.1": "Rev 2 (YTSP-AAB)",
  "0.2": "Rev 3 (YTSP-AAC)",
  "0.64": "Rev 3 pre-merge draft (YTSP-ABA)",
  "1.0": "TSP 1.0 (YTSP-BAA)",
});

/** A frame whose version could not be established, or is not one we speak.
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
  /** MAJOR as carried. Always {@link SUPPORTED_MAJOR} — a mismatch throws. */
  major: number;
  /** MINOR as carried, unjudged. */
  minor: number;
  /** Whether {@link KNOWN_VERSIONS} names this version. A `false` here is not
   *  an error; it is the note a later parse failure should cite. */
  recognised: boolean;
}

/** Human-readable name for a version, for error text and diagnostics. */
export function describeVersion(major: number, minor: number): string {
  return KNOWN_VERSIONS[`${major}.${minor}`] ?? `MAJOR ${major}, MINOR ${minor} (unrecognised)`;
}

/** Human-readable name for a peeked version. */
export function describeRevision(peeked: PeekedRevision): string {
  return describeVersion(peeked.major, peeked.minor);
}

/**
 * Read a message's version from its marker, without keys.
 *
 * Throws {@link TspRevisionError} if the bytes are not a TSP frame at all, if
 * the version marker is malformed, or if MAJOR is one we do not implement —
 * which includes every pre-1.0 draft.
 */
export function peekRevision(bytes: Uint8Array): PeekedRevision {
  if (!wire.isTsp(bytes)) {
    throw new TspRevisionError("tsp: not a TSP frame (no -E count code)");
  }

  // The version marker sits immediately after the `-E` count code, whose width
  // is the one thing the leading byte tells us: short is 3 bytes, long is 6.
  const cur: wire.Cursor = { pos: bytes[0] === wire.TSP_MAGIC_BYTE_LONG ? 6 : 3 };

  const version = wire.readVersion(bytes, cur);
  if (version === undefined) {
    throw new TspRevisionError("tsp: missing or malformed YTSP version marker");
  }
  if (version.major !== SUPPORTED_MAJOR) {
    throw new TspRevisionError(
      `tsp: message is ${describeVersion(version.major, version.minor)}; this implementation speaks ${describeVersion(wire.TSP_VERSION.major, wire.TSP_VERSION.minor)}`,
      version.major,
      version.minor,
    );
  }

  return {
    major: version.major,
    minor: version.minor,
    recognised: Object.hasOwn(KNOWN_VERSIONS, `${version.major}.${version.minor}`),
  };
}
