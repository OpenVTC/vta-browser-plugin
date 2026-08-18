// Agent names — the `example.com/@alice` shortcuts that resolve to DIDs.
//
// Ported from the Rust reference implementation
// (`affinidi-tdk-rs/crates/identity/shortcuts/agent-names`) and the Agent Names
// Design & Implementation Guide. Canonicalisation is copied verbatim rather
// than reinvented: verification compares a string a user typed against a string
// in somebody else's DID Document, so two implementations that normalise
// differently disagree about whether a name verifies — a security-relevant
// disagreement, not a cosmetic one.
//
// The one rule that governs everything here:
//
//   **DID → name is authoritative only via `alsoKnownAs`.**
//
// Name → DID is an HTTP redirect served by the name's own web server, so on its
// own it proves nothing — anyone who controls a domain can redirect to somebody
// else's DID. Only the DID's controller can add an `alsoKnownAs` entry. That is
// why this module offers `extractAgentNames(doc)` and deliberately offers *no*
// helper that guesses a name from a DID's host or path. Such a helper would
// manufacture unverified guesses behind an authoritative-looking API, which is
// precisely the spoofing the check exists to prevent.
//
// (An earlier version of this wallet did exactly that — derived a handle from
// the DID's trailing path segment. It was wrong: a name is not a segment of the
// DID and is not derivable from its structure.)

/** The two-character marker. `alice@example.com` has an `@` but no `/@` and is
 *  deliberately not an agent name — the marker is the sequence, never the `@`. */
export const AGENT_NAME_MARKER = "/@";

export interface AgentName {
  /** Canonical form, always a full URL: `https://example.com/@alice`. This is
   *  what gets compared against `alsoKnownAs`. */
  canonical: string;
  /** Host, plus port when it is not the scheme default. */
  authority: string;
  /** The part after `/@`. Empty for the community name. Case preserved. */
  localName: string;
  /** Trailing segments. These add context and are part of the identity —
   *  `…/@drummond/h2hsummit` is a different name from `…/@drummond`. */
  pathSegments: string[];
}

/** Cheap syntactic test, no network. Lets one input field accept either form
 *  so callers never have to ask the user "is this a DID or a name?". */
export function looksLikeAgentName(input: string): boolean {
  return input.includes(AGENT_NAME_MARKER);
}

/**
 * Parse and canonicalise an agent name.
 *
 * Canonicalisation, per the guide's table:
 *   - missing scheme ⇒ `https`
 *   - host lowercased, default port dropped, non-default port preserved
 *   - trailing slash dropped, surrounding whitespace trimmed
 *   - **local part case preserved** — nothing says names are case-insensitive,
 *     and folding could silently merge two distinct identities, which is a
 *     strictly worse failure than one that occasionally fails to match.
 *     `@Alice` and `@alice` are different names.
 *
 * Returns null rather than throwing: callers routinely feed it `alsoKnownAs`
 * entries that are legitimately other identifier types (`did:` URIs), where
 * "not an agent name" is an ordinary outcome and not an error.
 */
export function parseAgentName(input: string): AgentName | null {
  const trimmed = input.trim();
  if (!trimmed || !trimmed.includes(AGENT_NAME_MARKER)) return null;

  // A bare `example.com/@alice` is not a URL until it has a scheme.
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // `URL` lowercases the host and drops a default port for us.
  if (!url.hostname) return null;

  const scheme = url.protocol.replace(":", "");
  const authority = url.port ? `${url.hostname}:${url.port}` : url.hostname;

  // Split the path, discarding the empty segment a trailing slash leaves.
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const first = segments.shift() as string;
  if (!first.startsWith("@")) return null;
  const localName = first.slice(1);

  // An empty local part is the community name (`example.com/@`) — the
  // verifiable trust community that owns the domain. It is the one case where
  // "no local name" is meaningful rather than a truncated name, and the spec
  // allows it only without a path: `example.com/@/anything` is malformed, not
  // a context-qualified community name.
  if (localName === "" && segments.length > 0) return null;

  // Only the first segment may carry the marker; `a/@b/@c` is ambiguous.
  if (segments.some((s) => s.startsWith("@"))) return null;

  const canonical = [`${scheme}://${authority}/@${localName}`, ...segments].join("/");

  return { canonical, authority, localName, pathSegments: segments };
}

/** The canonical form without its scheme — `example.com/@alice`. The compact
 *  spelling for display, where the `https://` is noise. */
export function withoutScheme(name: AgentName): string {
  return name.canonical.replace(/^https?:\/\//, "");
}

/**
 * Display spelling.
 *
 * The community name has an empty local part, so `withoutScheme` yields a
 * dangling `example.com/@` that reads like a truncation bug. It is not one —
 * it means "the verifiable trust community that owns this domain" — so it is
 * spelled out rather than shown as a trailing marker.
 */
export function displayAgentName(name: AgentName): string {
  return name.localName === ""
    ? `${name.authority} (community)`
    : withoutScheme(name);
}

/**
 * Every `alsoKnownAs` entry that is a well-formed agent name.
 *
 * The authoritative DID → name direction. Entries that don't parse are skipped
 * rather than treated as errors, since `alsoKnownAs` legitimately holds other
 * identifier types.
 */
export function extractAgentNames(alsoKnownAs: readonly string[] | undefined): AgentName[] {
  if (!alsoKnownAs) return [];
  return alsoKnownAs
    .map(parseAgentName)
    .filter((n): n is AgentName => n !== null);
}

/**
 * Does this document claim this name back?
 *
 * The mandatory Layer-1 anti-spoofing check. Both sides are canonicalised
 * first, so cosmetic spelling differences don't cause a false negative.
 *
 * Matching is exact after canonicalisation. There is deliberately no prefix or
 * wildcard matching: `example.com/@alice` must not be satisfied by an entry for
 * `example.com/@alicia`, nor a path-qualified name by its bare parent.
 */
export function alsoKnownAsContains(
  alsoKnownAs: readonly string[] | undefined,
  name: AgentName,
): boolean {
  if (!alsoKnownAs) return false;
  return alsoKnownAs.some((entry) => {
    const parsed = parseAgentName(entry);
    if (parsed) return parsed.canonical === name.canonical;
    // Not parseable as an agent name: fall back to an exact match against both
    // canonical spellings, then give up.
    return entry === name.canonical || entry === withoutScheme(name);
  });
}

// ── Resolution ───────────────────────────────────────────────────────────
//
// Kept in this module rather than a sibling so there is no runtime import
// between them: these files run directly under Node's type-stripping in the
// tests, and the repo's `.js` import convention does not resolve there. The
// pairing is natural anyway — parsing, canonicalisation, verification and
// resolution are one subject.
//
// The three stages, from the Agent Names Design & Implementation Guide:
//
//   1. name → DID       an HTTPS request that must answer with a DID
//   2. DID → document   ordinary DID resolution
//   3. document → name  the document must claim the name back via alsoKnownAs
//
// **Stage 3 is mandatory and there is no permissive mode.** Stage 1 is served
// by the name's own web server, so on its own it proves nothing: anyone who
// controls a domain can redirect to somebody else's DID. Only the DID's
// controller can add an `alsoKnownAs` entry, which is what makes the binding
// two-sided. A "just this once" fallback to the redirect target would give the
// whole property away, so failure here is a hard failure.
//
// That is also why stage 1 may take the DID from wherever it finds it — a
// `Location` header, the URL a redirect landed on, or the body read there.
// None of those is trusted: whatever comes back is a *candidate* DID that
// stages 2 and 3 then have to earn. The guide says as much — the redirect
// contract is deliberately permissive and quarantined in one place, because
// parsing, canonicalisation and verification do not depend on how the DID was
// obtained.
//
// ## Why a browser cannot simply read `Location`
//
// The reference implementation is Rust, where `Location` is an ordinary header
// on a response you chose not to follow. **In a browser it is unreadable,
// twice over:**
//
//   - `fetch(url, { redirect: "manual" })` does not hand back the redirect. It
//     returns an *opaque-redirect* response — status 0, no headers at all — so
//     `headers.get("location")` is null for every redirect, on every host.
//   - Worse, the contract's own answer is a `did:` URI, and Chrome rejects a
//     redirect to a non-web-safe scheme down in the network stack
//     (`net::ERR_UNSAFE_REDIRECT`) before any redirect mode is consulted. The
//     `fetch` rejects outright with `TypeError: Failed to fetch`, and no
//     extension API — `webRequest` included — sees the header either, because
//     the callback that would carry it never fires.
//
// So a browser client has to ask for an answer it *can* read. A server that
// content-negotiates (the webvh hosting service does) answers a browser-shaped
// `Accept` with an ordinary same-origin redirect to the DID's log, which fetch
// follows normally; the DID then comes out of the landing URL or the body.
// `didFromNameResponse` accepts every one of those shapes, so one code path
// serves a browser, Node and curl alike.
//
// Not defended against: DNS poisoning, or a breach of the name's own web
// server — an attacker with either can serve a redirect to a DID they control
// whose document legitimately claims the name. That is Layer 2 (the agent name
// credential), which neither the Rust reference nor this port implements.
//
// Network and DID resolution are injected, so the rules are testable without
// either.

/** Stable codes. Callers branch on these, never on the message (R3.7). */
export const AGENT_NAME_INVALID = "agent-name/invalid";
export const AGENT_NAME_INSECURE = "agent-name/insecure";
export const AGENT_NAME_NO_REDIRECT = "agent-name/no-redirect";
/** The request could not be completed or read at all — the transport refused
 *  it, or the answer arrived in a form this host cannot see (a browser handed
 *  a `did:` redirect). Distinct from `no-redirect`, which means the server was
 *  read and simply did not name a DID. */
export const AGENT_NAME_UNREADABLE = "agent-name/unreadable";
export const AGENT_NAME_UNRESOLVABLE = "agent-name/unresolvable-did";
export const AGENT_NAME_NOT_AUTHORIZED = "agent-name/not-authorized";

export class AgentNameError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's
  // type-stripping (which runs these modules directly under `node --test`)
  // rejects parameter properties outright.
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AgentNameError";
  }
}

export interface ResolvedAgentName {
  /** The DID the name resolves to, and the value to store. Names are
   *  re-claimable, so the DID is the stable thing — never persist the name as
   *  a primary key. */
  did: string;
  /** The canonical name, verified against the document. */
  name: AgentName;
}

/** What a DID resolution must tell us. Mirrors the fields of `VerifyRpDidResult`
 *  that matter here, so the caller can pass its existing bridge response. */
export interface DidLookup {
  resolved: boolean;
  alsoKnownAs?: string[] | undefined;
  error?: string | undefined;
}

/**
 * What stage 1 saw. Everything but the status is optional, because which field
 * carries the DID depends on the transport:
 *
 *   - Rust, Node or curl, not following the redirect: a 3xx `status` and a
 *     `location`.
 *   - A browser, which has no choice but to follow: a 200 `status`, `url` set
 *     to where it landed, and `body` whatever was served there.
 */
export interface NameResponse {
  /** Status of the response finally read. */
  status: number;
  /** The `Location` header, when the transport can see one. A browser never
   *  can — see the note above. */
  location?: string | null | undefined;
  /** The URL the response was read from, after any redirects followed. */
  url?: string | undefined;
  /** The body read, when one was read. */
  body?: string | undefined;
}

export interface ResolveDeps {
  /** Performs stage 1: GET the name and report what came back. An ordinary
   *  HTTP failure is a `NameResponse`, not an exception — a 404 still has a
   *  status. Throw `AgentNameError(AGENT_NAME_UNREADABLE, …)` when the request
   *  could not be completed or read at all. */
  fetchName: (url: string) => Promise<NameResponse>;
  resolveDid: (did: string) => Promise<DidLookup>;
}

/** Percent-decoding that answers null rather than throwing on malformed input.
 *  `:` is reserved in a path segment, so an encoded DID is the normal case. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A DID carried by a URL: `?did=…`, or the last path segment. */
function didFromUrl(candidate: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate, base);
  } catch {
    return null;
  }
  const queried = url.searchParams.get("did")?.trim();
  if (queried?.startsWith("did:")) return queried;
  const last = url.pathname.split("/").filter((s) => s.length > 0).pop();
  const decoded = last ? decodeSegment(last) : null;
  return decoded?.startsWith("did:") ? decoded : null;
}

/** A DID carried by a JSON value: `{ did }`, a DID document's `id`, a
 *  resolution result's `didDocument.id`, or a did:webvh log entry's
 *  `state.id`. */
function didFromJson(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Record<string, unknown>;
  const nestedId = (key: string): unknown => {
    const inner = doc[key];
    return typeof inner === "object" && inner !== null
      ? (inner as Record<string, unknown>)["id"]
      : undefined;
  };
  for (const found of [doc["did"], doc["id"], nestedId("didDocument"), nestedId("state")]) {
    if (typeof found === "string" && found.trim().startsWith("did:")) return found.trim();
  }
  return null;
}

/** A DID carried by a response body: a bare DID, one JSON document, or the
 *  first entry of a did:webvh log — which is JSON *lines*, so the body as a
 *  whole does not parse and the first line has to be tried on its own. */
function didFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("did:") && !/\s/.test(trimmed)) return trimmed;
  for (const candidate of [trimmed, trimmed.split("\n", 1)[0] ?? ""]) {
    try {
      const did = didFromJson(JSON.parse(candidate));
      if (did) return did;
    } catch {
      // Not JSON, or not this shape — try the next candidate.
    }
  }
  return null;
}

/**
 * The DID a stage-1 response names, or null.
 *
 * Deliberately permissive, per the guide: the DID may arrive as a bare `did:…`
 * in `Location`, as a `?did=` parameter, as the final path segment, or in the
 * body served where a redirect landed. Nothing downstream depends on which —
 * the candidate still has to resolve (stage 2) and claim the name back
 * (stage 3), so a wrong guess here fails closed rather than granting anything.
 */
export function didFromNameResponse(res: NameResponse, base: string): string | null {
  const location = res.location?.trim();
  if (location) {
    if (location.startsWith("did:")) return location;
    const fromLocation = didFromUrl(location, base);
    if (fromLocation) return fromLocation;
  }
  // Only where a redirect actually landed. The URL we *asked* for is the name
  // itself, and reading a DID out of that would be deriving one from the name's
  // own spelling — the guess this module exists to refuse.
  if (res.url && res.url !== base) {
    const fromUrl = didFromUrl(res.url, base);
    if (fromUrl) return fromUrl;
  }
  return res.body ? didFromBody(res.body) : null;
}

/**
 * Resolve and verify an agent name.
 *
 * Every failure names both sides of the binding, because "verification failed"
 * is unactionable and "this DID's document doesn't list this name" tells the
 * user which half to go and fix.
 */
export async function resolveAgentName(
  input: string,
  deps: ResolveDeps,
): Promise<ResolvedAgentName> {
  const name = parseAgentName(input);
  if (!name) {
    throw new AgentNameError(
      AGENT_NAME_INVALID,
      `'${input}' is not an agent name. Expected something like example.com/@alice.`,
    );
  }

  // The guide refuses plain HTTP outright: a name fetched over HTTP can be
  // redirected to any DID by anyone on the network path, which defeats stage 1
  // before stage 3 gets a chance to matter.
  if (name.canonical.startsWith("http://")) {
    throw new AgentNameError(
      AGENT_NAME_INSECURE,
      `Refusing to resolve ${withoutScheme(name)} over plain HTTP; agent names must use HTTPS.`,
    );
  }

  const res = await deps.fetchName(name.canonical);
  const did = didFromNameResponse(res, name.canonical);
  if (!did) {
    const target = res.location?.trim();
    throw new AgentNameError(
      AGENT_NAME_NO_REDIRECT,
      target
        ? `${withoutScheme(name)} redirected to '${target}', which is not a DID.`
        : `${withoutScheme(name)} did not answer with a DID (HTTP ${res.status}); expected a ` +
          `redirect to a did: URI, or a response naming one.`,
    );
  }

  const doc = await deps.resolveDid(did);
  if (!doc.resolved) {
    throw new AgentNameError(
      AGENT_NAME_UNRESOLVABLE,
      `${withoutScheme(name)} points at ${did}, which does not resolve${
        doc.error ? `: ${doc.error}` : ""
      }.`,
    );
  }

  if (!alsoKnownAsContains(doc.alsoKnownAs, name)) {
    throw new AgentNameError(
      AGENT_NAME_NOT_AUTHORIZED,
      `Agent name ${withoutScheme(name)} is not authorized by DID ${did}: its DID Document's ` +
        `alsoKnownAs does not contain the name.`,
    );
  }

  return { did, name };
}
