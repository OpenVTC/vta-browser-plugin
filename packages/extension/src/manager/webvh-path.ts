// The name a did:webvh is served under, when the operator chooses one.
//
// A hosting server allocates a path when none is given (`autoAssign`, the
// default). Choosing one instead puts a word the operator picked into the DID
// itself: `rooms/northwind` publishes at `<domain>/rooms/northwind/did.jsonl`
// and resolves as `did:webvh:<scid>:<domain>:rooms:northwind`.
//
// **The rule is the hosting server's, not this console's.** It is
// `validate_custom_path` in affinidi-webvh-service
// (`did-hosting-common/src/server/mnemonic.rs`), and the VTA passes an explicit
// path through to it untouched. It is mirrored here for one reason: a mint the
// server refuses is not free, because the agent derives the DID's keys before
// it hands the log over — so asking first and being refused second can leave
// keys behind. Where this and the server disagree the server is right, and this
// is what should be brought back into line.
//
// A plain module rather than part of the form, so a test can reach it — the
// form is `.tsx`.

/** First segments the hosting server keeps for its own routes. */
export const RESERVED_FIRST_SEGMENTS: readonly string[] = [
  ".well-known",
  "api",
  "auth",
  "dids",
  "stats",
  "acl",
  "health",
];

/**
 * Why the hosting server would refuse `path`, in words an operator can act on,
 * or `null` when it would accept it.
 *
 * Checked in the server's order, so the reason given is the one its own refusal
 * would give. The one addition is `:`: it is refused either way, but a person
 * copying the shape of a DID types it, and "use `/`" is the useful answer.
 */
export function pathProblem(path: string): string | null {
  if (path === "") return "Give the path a name, or let the hosting server choose one.";
  if (path.length > 255) return "A path is at most 255 characters.";
  if (path.includes(":")) {
    return "Separate path segments with “/” — each one shows as “:” in the DID.";
  }
  if (path.startsWith("/") || path.endsWith("/")) return "A path does not start or end with “/”.";

  const segments = path.split("/");
  for (const [i, segment] of segments.entries()) {
    if (segment === "") return "A path has no empty segments (“//”).";
    if (segment.length < 2 || segment.length > 63) {
      return `“${segment}”: each segment is 2 to 63 characters.`;
    }
    if (!/^[a-z0-9-]+$/.test(segment)) {
      return `“${segment}”: segments use lowercase letters, digits and hyphens only.`;
    }
    if (!/^[a-z0-9]/.test(segment) || !/[a-z0-9]$/.test(segment)) {
      return `“${segment}”: each segment starts and ends with a letter or digit.`;
    }
    if (i === 0 && RESERVED_FIRST_SEGMENTS.includes(segment)) {
      return `“${segment}” is reserved by the hosting server and cannot be the first segment.`;
    }
  }
  return null;
}

/** `rooms/northwind` as it appears inside the DID: `rooms:northwind`. */
export function didPath(path: string): string {
  return path.split("/").join(":");
}
