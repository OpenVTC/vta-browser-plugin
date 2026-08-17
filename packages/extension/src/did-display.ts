// Structural parsing of a DID for display.
//
// A DID is the thing this wallet asks people to *verify*, and today it renders
// as one long grey monospace run — so the host, the only part a human can
// actually check, carries the same weight as fifty characters nobody can. That
// makes the consent prompt's central security question harder than it needs to
// be.
//
// Splitting the string lets the renderer recede the parts that are always the
// same (`did:webvh:`), mute the machine material (the SCID), and lead with the
// host. Parsing lives here, apart from the rendering, so the boundary rules are
// testable without a DOM — see `tests/did-display.test.mts`.

/** A DID broken into display roles. Concatenating every `text` in order
 *  reproduces the input exactly; nothing is dropped or reordered, because a
 *  display that silently omits part of an identifier is worse than an ugly
 *  one. */
export interface DidPart {
  text: string;
  /**
   * - `method`  — `did:webvh:` and structural separators. Least informative.
   * - `opaque`  — SCID, key material, numalgo body. Machine-readable only.
   * - `host`    — the domain a human recognises. The verification target.
   * - `path`    — trailing path segments (`:contexts:acme`).
   *
   * Note there is deliberately no `name` role. An agent name is not a segment
   * of the DID — it is an independent `/@` URL that the document claims via
   * `alsoKnownAs`. See `agent-name.ts`.
   */
  role: "method" | "opaque" | "host" | "path";
}

/**
 * Split a DID into display parts.
 *
 * `did:webvh:<scid>:<host>[:<path>…]` is the only shape with a host to lift;
 * webvh percent-encodes `:` and `/` inside the host segment, and it is left
 * encoded because the host is compared by eye against a domain, which never
 * contains either.
 *
 * Anything else — `did:peer`, `did:key`, or a malformed string — comes back as
 * a single part rather than a guess. Unknown input renders plainly; it never
 * renders *wrongly*, which would mean emphasising a segment that is not the
 * host and inviting exactly the misread this exists to prevent.
 */
export function splitDid(did: string): DidPart[] {
  if (!did.startsWith("did:webvh:")) {
    return did ? [{ text: did, role: "opaque" }] : [];
  }

  const segments = did.split(":");
  // ["did", "webvh", "<scid>", "<host>", ...path]
  const scid = segments[2];
  const host = segments[3];
  if (!scid || !host) {
    return [{ text: did, role: "opaque" }];
  }

  const parts: DidPart[] = [
    { text: "did:webvh:", role: "method" },
    { text: scid, role: "opaque" },
    { text: ":", role: "method" },
    { text: host, role: "host" },
  ];

  const rest = segments.slice(4);
  if (rest.length > 0) {
    parts.push({ text: `:${rest.join(":")}`, role: "path" });
  }
  return parts;
}

/** The host a viewer should be checking, or undefined when there isn't one to
 *  lift. Callers use this for the accessible label so a screen reader gets the
 *  same emphasis the visual treatment provides. */
export function didHost(did: string): string | undefined {
  return splitDid(did).find((p) => p.role === "host")?.text;
}

/**
 * Shorten a DID for a collapsed view **without ever eliding the host**.
 *
 * The naive version of this — keep the first N and last M characters — is
 * actively dangerous on a consent prompt. For
 * `did:webvh:<scid>:<host>:contexts:acme` the tail is the *path*, so the host
 * disappears entirely and the user is asked to approve an identifier whose
 * only human-checkable part is not on screen.
 *
 * Here the SCID absorbs the elision, because it is the long segment and the
 * one nobody verifies by eye. Host and path survive intact. Non-webvh DIDs
 * have no host to protect, so they fall back to head-and-tail.
 */
export function collapseDid(did: string, maxOpaque = 10): DidPart[] {
  const parts = splitDid(did);
  const hasHost = parts.some((p) => p.role === "host");

  if (!hasHost) {
    // did:peer / did:key — nothing to protect, so keep both ends recognisable.
    const only = parts[0];
    if (!only || only.text.length <= 48) return parts;
    return [
      { text: `${only.text.slice(0, 22)}…${only.text.slice(-12)}`, role: only.role },
    ];
  }

  return parts.map((p) =>
    p.role === "opaque" && p.text.length > maxOpaque
      ? { text: `${p.text.slice(0, maxOpaque)}…`, role: p.role }
      : p,
  );
}
