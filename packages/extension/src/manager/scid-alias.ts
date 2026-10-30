// Whether a did:webvh document lists its log's did:scid alias, read from the
// document itself.
//
// Every did:webvh log is also `did:scid:vh:1:<scid>`: the same log verifies
// both. They are one subject only while the did:webvh document lists the
// did:scid DID URL in `alsoKnownAs` (VTI-KEY-164), so the screen has to say
// which of three things is true — and "listed" is two of them, because the DID
// URL carries `?src=<where the log is served>` and a log that has moved can
// still list the old one.
//
// **This is for reading, never for writing.** `vta/webvh/dids/update/1.1`
// takes `scidAlsoKnownAs` as a flag and the agent derives the DID URL itself;
// nothing here builds a request. The derivation below exists only so the
// console can tell a current locator from a stale one.
//
// A plain module rather than part of the pane so a test can reach it.

/** What the latest document says about the alias. */
export type ScidAlias =
  /** Listed, for where the log is served now. */
  | { kind: "listed"; url: string }
  /** Listed only with a locator that is not the current one — the log's
   *  location before a move, or no locator at all. */
  | { kind: "elsewhere"; urls: string[] }
  | { kind: "absent" };

const WEBVH = /^did:webvh:([^:]+):(.+)$/;

/**
 * The `src` a did:scid DID URL carries for this did:webvh: the part after
 * `did:webvh:<scid>:`, with each `:` made `/`. Percent-encoding is kept as it
 * is — a port stays `%3A<port>` — which is why it is never decoded.
 */
export function scidSourceOf(webvhDid: string): { scid: string; src: string } | null {
  const m = WEBVH.exec(webvhDid);
  if (!m) return null;
  return { scid: m[1]!, src: m[2]!.split(":").join("/") };
}

/** The `src` parameter of a DID URL, undecoded, or `null` when it has none. */
function srcOf(url: string): string | null {
  const q = url.indexOf("?");
  if (q < 0) return null;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  for (const part of query.split("&")) {
    if (part.startsWith("src=")) return part.slice(4);
  }
  return null;
}

/**
 * Read the alias out of a document's `alsoKnownAs`.
 *
 * `null` when `webvhDid` is not a did:webvh, which leaves nothing to compare
 * against. A malformed `alsoKnownAs` reads as listing nothing: it lists no
 * alias, whatever else is wrong with it.
 */
export function scidAliasOf(webvhDid: string, alsoKnownAs: unknown): ScidAlias | null {
  const here = scidSourceOf(webvhDid);
  if (!here) return null;
  const base = `did:scid:vh:1:${here.scid}`;
  const entries = Array.isArray(alsoKnownAs)
    ? alsoKnownAs.filter((e): e is string => typeof e === "string")
    : [];
  // Exactly this SCID's DID, with or without a DID URL's path, query or
  // fragment — `did:scid:vh:1:<scid>` must not match a longer SCID it prefixes.
  const ours = entries.filter(
    (e) => e === base || ["?", "#", "/"].some((sep) => e.startsWith(base + sep)),
  );
  const current = ours.find((e) => srcOf(e) === here.src);
  if (current) return { kind: "listed", url: current };
  if (ours.length > 0) return { kind: "elsewhere", urls: ours };
  return { kind: "absent" };
}
