// A DID document as it stood at an instant.
//
// did:webvh and did:scid:vh:1 keep their history: `@openvtc/vti-didcomm-js`
// (0.14) resolves either with `versionTime`, verifying the whole log first and
// returning the `state` of the last entry in force at that instant. A reader
// checking a signature made in the past — a room record's body, against the
// host's `bodyStoredAt` — needs that document, not today's: a key rotated
// away since still signed honestly then, and a key added since did not sign
// anything before it existed.
//
// This lives in `did` rather than beside `resolveDidDocument` in `didcomm`
// because it runs the did:webvh / did:scid host guard first, and the two
// modules are one layer: neither may import the other.

import { DID_VERSION_NOT_FOUND, resolve as vtiResolve, scidSrc } from "@openvtc/vti-didcomm-js";

import { assertResolvableScidHost, assertResolvableWebvhHost } from "./egress-guard.js";

/**
 * Resolve `did` as it stood at `at` (an RFC 3339 date-time).
 *
 * - a `DID document` — the one in force at `at`;
 * - `null` — the DID's history says no document existed then: `at` precedes
 *   its first entry (`E_DID_VERSION_NOT_FOUND`). The log verified, so this is
 *   an answer about the DID, not a failure to resolve it;
 * - `undefined` — the method keeps no history (`did:key`, `did:peer`, whose
 *   document never changes, and any other method), so there is nothing to
 *   resolve as of a time.
 *
 * Throws where the DID does not resolve at all, including a host the guard
 * refuses (`E_BLOCKED_ENDPOINT`), which is checked before anything is fetched.
 */
export type DidDocumentAt = Record<string, unknown> | null | undefined;

/** What {@link resolveDidDocumentAt} may be given. A test seam. */
export interface ResolveDidDocumentAtOptions {
  /** Resolve with `{ versionTime }`. Defaults to `@openvtc/vti-didcomm-js`'s `resolve`. The host guard runs first either way. */
  resolve?: (did: string, options: { versionTime: string }) => Promise<{ didDocument?: unknown }>;
}

/** Resolve `did` as it stood at `at`. See {@link DidDocumentAt} for the three answers. */
export async function resolveDidDocumentAt(
  did: string,
  at: string,
  opts: ResolveDidDocumentAtOptions = {},
): Promise<DidDocumentAt> {
  if (did.startsWith("did:webvh:")) {
    assertResolvableWebvhHost(did);
  } else if (did.startsWith("did:scid:vh:")) {
    // A bare did:scid fetches from a source the resolver vetted when it
    // learned it; a DID URL names its host here.
    if (scidSrc(did)) assertResolvableScidHost(did);
  } else {
    return undefined;
  }
  const resolve = opts.resolve ?? ((d: string, o: { versionTime: string }) => vtiResolve(d, o));
  let resolution: { didDocument?: unknown };
  try {
    resolution = await resolve(did, { versionTime: at });
  } catch (e) {
    if (isDidVersionNotFound(e)) return null;
    throw e;
  }
  const doc = resolution.didDocument;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error(`could not resolve the DID document of ${did} as of ${at}`);
  }
  return doc as Record<string, unknown>;
}

/**
 * True when `err` says the DID had no version in force at the instant asked
 * for. Structural on `code` (R3.7), never on the message or the class.
 */
export function isDidVersionNotFound(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === DID_VERSION_NOT_FOUND
  );
}

/**
 * A {@link resolveDidDocumentAt} that answers each DID and instant once.
 *
 * A historical resolution bypasses the resolver's cache and re-fetches and
 * re-verifies the whole log, so a list of records by a handful of authors
 * would otherwise cost one log per record. Make one per render or batch and
 * drop it after: the memo has no expiry, and a failure is remembered for its
 * lifetime as well as a success.
 */
export function memoResolveDidDocumentAt(
  opts: ResolveDidDocumentAtOptions = {},
): (did: string, at: string) => Promise<DidDocumentAt> {
  const seen = new Map<string, Promise<DidDocumentAt>>();
  return (did, at) => {
    const key = `${did}\u0000${at}`;
    let answer = seen.get(key);
    if (answer === undefined) {
      answer = resolveDidDocumentAt(did, at, opts);
      seen.set(key, answer);
    }
    return answer;
  };
}
