// Trigger links: the reader side of VTI spec chapter 7a ("Trigger Links").
//
// A trigger link is the text a community shows as a QR code (and wraps in an
// `<a href>`) to start an exchange with a wallet it cannot otherwise reach:
//
//   https://link.trustoverip.org/t#_from=<VID>&_id=<handle>&_exp=<n>&_type=/vti/flow/sign-in/0.1
//
// This module is the reader's parser and validator, and nothing else. It is a
// **pure function from text to a verdict**: no network, no clock of its own
// (the caller passes `now`), no storage, no imports. That is what lets the
// content script, the service worker and the tests all run the identical rule —
// a reader that answered differently in two places would be two readers.
//
// The order of checks is VTI-LNK-020's, and the order matters: the spec fixes
// the *reason* a given text fails for, so two conformant readers report the same
// thing. Each step below names the rule it implements. The person is never shown
// the reason, only the outcome's message (VTI-LNK-021); the reason exists for
// tests and for a log line that records the outcome and nothing of the link
// (VTI-LNK-073).
//
// What this module deliberately does not do:
//   - resolve the contact, or apply the host rules to the contact's host — that
//     happens at resolution (the spec's `did:web:example.com%253A8443` example);
//   - decide whether the contact is a known community (VTI-LNK-101);
//   - check the activation origin (VTI-LNK-056 / 105).
// Those need the wallet's records and the network, and live with the flow.

/** Every reason a reader can stop for (VTI-LNK-020, 052, 053, 105). */
export type TriggerLinkReason =
  // Parse-time (VTI-LNK-020), in evaluation order.
  | "too-long"
  | "not-ours"
  | "query-form"
  | "insecure-scheme"
  | "bad-grammar"
  | "bad-authority"
  | "repeated-param"
  | "missing-from"
  | "bad-from"
  | "unsupported-vid"
  | "bad-id"
  | "bad-exp"
  | "bad-type"
  | "wrong-host"
  | "unknown-flow"
  | "unsupported-version"
  | "from-not-allowed"
  | "missing-exp"
  | "expired"
  // After the link (VTI-LNK-052, 053, 055, 105). `untyped` is a link with no
  // `_type`, which this reader cannot place (VTI-LNK-055, outcome `invalid`).
  | "did-document-unverified"
  | "no-common-transport"
  | "untyped"
  | "wrong-origin"
  // Route B (dtgwg-vti-spec #58), outcome `invalid`: the portal origin is not
  // linked to a domain-linked contact's DID by a DIF DID Configuration.
  | "domain-not-linked"
  // Local to this reader, outcome `invalid`: the community's verified document
  // lists no usable `SignInPortal` service (VTI-LNK-102 names no reason).
  | "no-portal-service";

/** What the person can do about it (VTI-LNK-021). */
export type TriggerLinkOutcome = "update" | "expired" | "unreachable" | "pass-on" | "invalid";

/** The reason → outcome table of VTI-LNK-021. Every reason not listed for
 *  another outcome is `invalid`. */
export function outcomeOf(reason: TriggerLinkReason): TriggerLinkOutcome {
  switch (reason) {
    case "unsupported-vid":
    case "unknown-flow":
    case "unsupported-version":
      return "update";
    case "expired":
      return "expired";
    case "no-common-transport":
      return "unreachable";
    case "not-ours":
      return "pass-on";
    default:
      return "invalid";
  }
}

/**
 * The only words a reader may show for a refused link (VTI-LNK-021). They name
 * no field and say nothing about whether a contact was on a list — a message
 * that names the failing field teaches an attacker which field to adjust.
 * `pass-on` has none: the text goes to the reader's other handlers unchanged.
 */
export const TRIGGER_LINK_MESSAGES: Readonly<Record<Exclude<TriggerLinkOutcome, "pass-on">, string>> = {
  update: "This code needs a newer version of the app.",
  expired: "This code has expired. Get a new one.",
  unreachable: "This service can't be reached from your wallet.",
  invalid: "This code can't be used.",
};

/** The message for an outcome, or `undefined` for `pass-on`. */
export function triggerLinkMessage(outcome: TriggerLinkOutcome): string | undefined {
  return outcome === "pass-on" ? undefined : TRIGGER_LINK_MESSAGES[outcome];
}

// ── Flows ────────────────────────────────────────────────────────────────────

/** A contact's DID method as `did:<method>` (`did:webvh`, `did:web`, …). The
 *  kinds this reader can classify are the methods in its contact-method
 *  table ({@link ContactMethodTable}); anything else is `unsupported-vid`. */
export type ContactKind = `did:${string}`;

/** A flow this reader implements (VTI-LNK-040 to 046). */
export interface TriggerLinkFlowSpec {
  /** Short name, for code that switches on the flow (`sign-in`). */
  name: string;
  /** The flow identifier **without** its version segment, as an absolute
   *  `https` URI: `https://link.trustoverip.org/vti/flow/sign-in`. */
  base: string;
  /** The MAJOR version this reader implements. */
  major: number;
  /** MINOR versions this reader implements. For a draft flow these are the
   *  only ones accepted (VTI-LNK-044); for a published flow any MINOR at or
   *  above the lowest is. */
  minors: readonly number[];
  draft: boolean;
  /** `_exp` is required (VTI-LNK-100 / 110). */
  requiresExp: boolean;
  /** Which contact kinds the flow accepts (VTI-LNK-031). A contact of a kind
   *  the reader supports but the flow does not is `from-not-allowed`. The
   *  table is the reader's contact methods ({@link DEFAULT_CONTACT_METHODS}
   *  when the caller passes none). */
  allowsContact: (contact: TriggerLinkContact, methods?: ContactMethodTable) => boolean;
}

/** The shared flow registry's root (VTI-LNK-046 table). */
export const FLOW_REGISTRY_BASE = "https://link.trustoverip.org/vti/flow/";

// ── Contact methods (VTI-LNK-102 / 112) ──────────────────────────────────────
//
// A contact qualifies for `sign-in` (and `vta-claim`) by one of two routes
// (dtgwg-vti-spec #58). Both need a method this reader resolves and whose
// document it verifies (VTI-LNK-052), and a document that lists a
// `SignInPortal`:
//
//   - **host-named** (route A): the DID names the host that serves its
//     document (`did:webvh`, `did:web`, and a `did:scid:vh:1` DID URL whose
//     `src` names it). Nothing more is checked. A contact of a host-named
//     method that names no host — a bare `did:scid` — has no route and is
//     `from-not-allowed`.
//   - **domain-linked** (route B): any other method. After the person
//     continues and before the claim, the reader confirms the portal origin is
//     linked to the DID by the DIF Well-Known DID Configuration
//     (`vtc/domain-linkage.ts`); if it is not, `domain-not-linked`.
//
// This module only knows the *policy* of each method — its route, whether its
// documents list services, its syntax and the host it names. It stays pure:
// the resolvers live one layer up, in `did/methods.ts`, whose registry is a
// {@link ContactMethodTable} and is what the flow passes in. Adding a method
// is a registration there; no flow needs editing.

/** How a contact of a method qualifies as a service contact. */
export type ContactRoute = "host-named" | "domain-linked";

/** What the reader knows of a DID method, for the contact rule. */
export interface ContactMethodPolicy {
  /** `did:<method>`. */
  kind: ContactKind;
  /** The route a contact of this method qualifies by. Absent: no route can
   *  ever qualify one (`did:key` lists no services; `did:peer` is
   *  self-certifying and published by no one), so a link naming one is
   *  `from-not-allowed`. */
  route?: ContactRoute;
  /** The document can list services (a `SignInPortal`, a Farm's claim
   *  service). */
  listsServices: boolean;
  /** This reader resolves the method and verifies its documents under
   *  VTI-LNK-052. A method with a route but no resolver is `unsupported-vid`. */
  verified: boolean;
  /** Method-specific syntax, beyond DID syntax. `false` is `bad-from`. */
  wellFormed?: (did: string) => boolean;
  /** Whether this reader can use this particular DID of the method (a
   *  `did:scid` format it resolves). `false` is `unsupported-vid`. */
  supports?: (did: string) => boolean;
  /** For a host-named method: the host serving the document, then the path,
   *  each percent-decoded once (VTI-LNK-050). `undefined` for a contact that
   *  names no host, which no route can then qualify. */
  hostPath?: (did: string) => string[] | undefined;
}

/** The reader's contact methods, by kind. */
export interface ContactMethodTable {
  policyFor(kind: string): ContactMethodPolicy | undefined;
}

function decodeSegments(segments: string[]): string[] | undefined {
  if (segments.length === 0) return undefined;
  return segments.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
}

/** `did:webvh:<scid>:<host>[:<path>…]`. Route A. */
export const WEBVH_CONTACT_POLICY: ContactMethodPolicy = {
  kind: "did:webvh",
  route: "host-named",
  listsServices: true,
  verified: true,
  wellFormed: (did) => {
    const parts = did.split(":");
    return parts.length >= 4 && !!parts[2] && !!parts[3];
  },
  hostPath: (did) => decodeSegments(did.split(":").slice(3)),
};

/** `did:web:<host>[:<path>…]`. Route A. */
export const WEB_CONTACT_POLICY: ContactMethodPolicy = {
  kind: "did:web",
  route: "host-named",
  listsServices: true,
  verified: true,
  hostPath: (did) => decodeSegments(did.split(":").slice(2)),
};

/**
 * The `src` of a `did:scid` DID URL whose only query parameter is `src`
 * (`did:scid:vh:1:<scid>?src=dids.example.org/farm-auth`), or `undefined`.
 * Mirrors `scidSrc` in `@openvtc/vti-didcomm-js`, inlined because this module
 * imports nothing.
 */
function scidSrcOf(did: string): string | undefined {
  if (!did.startsWith("did:scid:")) return undefined;
  const q = did.indexOf("?");
  if (q < 0) return undefined;
  const query = did.slice(q + 1).split("#")[0]!;
  if (!query.startsWith("src=")) return undefined;
  const src = query.slice(4);
  return src && !src.includes("&") ? src : undefined;
}

/**
 * The identity a contact names: for a `did:scid` DID URL, the bare
 * `did:scid:vh:1:<scid>` without its `src` locator (VTI-KEY-160); anything
 * else as written. The flow records and addresses the contact by this, and
 * resolves it through {@link TriggerLinkContact.value}.
 */
export function contactIdentity(contact: TriggerLinkContact): string {
  return scidSrcOf(contact.value) === undefined ? contact.value : contact.value.slice(0, contact.value.indexOf("?"));
}

/**
 * `did:scid:vh:1:<scid>?src=<host>[/<path>]`. Route A: the `src` names the host
 * the did:webvh log is fetched from (VTI-LNK-119). A bare `did:scid`, or one
 * with no `src`, names no host, so no route qualifies it: `from-not-allowed`.
 * Only the `vh:1` format is supported; another is `unsupported-vid`.
 */
export const SCID_CONTACT_POLICY: ContactMethodPolicy = {
  kind: "did:scid",
  route: "host-named",
  listsServices: true,
  verified: true,
  wellFormed: (did) => /^did:scid:[a-z0-9]+:[0-9]+:[A-Za-z0-9._-]+(?:\?src=[^?#&]+)?$/.test(did),
  supports: (did) => did.startsWith("did:scid:vh:1:"),
  hostPath: (did) => {
    const src = scidSrcOf(did);
    if (src === undefined) return undefined;
    const stripped = src.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const segments = stripped.split("/");
    return segments.some((seg) => seg === "") ? undefined : decodeSegments(segments);
  },
};

/** Self-certifying, and named after no host: no domain to show, and its
 *  document lists no services. No route. */
export const KEY_CONTACT_POLICY: ContactMethodPolicy = {
  kind: "did:key",
  listsServices: false,
  verified: true,
  wellFormed: (did) => /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(did),
};

/** Self-certifying; its document lists services, but no one publishes it, so
 *  nothing ties a portal in it to anyone the person recognises. No route. */
export const PEER_CONTACT_POLICY: ContactMethodPolicy = {
  kind: "did:peer",
  listsServices: true,
  verified: true,
};

/** The contact methods this reader classifies before any registry is
 *  consulted: route A for `did:webvh`, `did:web` and `did:scid` (with `src`),
 *  and the two methods it knows can never qualify. */
export const BUILTIN_CONTACT_POLICIES: readonly ContactMethodPolicy[] = [
  WEBVH_CONTACT_POLICY,
  WEB_CONTACT_POLICY,
  SCID_CONTACT_POLICY,
  KEY_CONTACT_POLICY,
  PEER_CONTACT_POLICY,
];

/** A {@link ContactMethodTable} over a list of policies. */
export function contactMethodTable(policies: Iterable<ContactMethodPolicy>): ContactMethodTable {
  const byKind = new Map<string, ContactMethodPolicy>();
  for (const p of policies) byKind.set(p.kind, p);
  return { policyFor: (kind) => byKind.get(kind) };
}

/** The table a caller that passes none gets: {@link BUILTIN_CONTACT_POLICIES}.
 *  The flow passes the registry in `did/methods.ts`, which starts from the
 *  same policies and adds each method's resolver. */
export const DEFAULT_CONTACT_METHODS: ContactMethodTable = contactMethodTable(BUILTIN_CONTACT_POLICIES);

/** The three properties the original VTI-LNK-102 contact rule asked of a DID
 *  method. Derived from the contact-method policies; kept for callers. */
export interface ContactMethodCapabilities {
  /** The identifier names the host that serves its document (route A). */
  namesHost: boolean;
  /** The document can list services. */
  listsServices: boolean;
  /** This reader verifies the document under VTI-LNK-052. */
  verified: boolean;
}

/** {@link BUILTIN_CONTACT_POLICIES} as capabilities, by kind. */
export const CONTACT_METHOD_CAPABILITIES: Readonly<Record<string, ContactMethodCapabilities>> = Object.freeze(
  Object.fromEntries(
    BUILTIN_CONTACT_POLICIES.map((p) => [
      p.kind,
      { namesHost: p.route === "host-named", listsServices: p.listsServices, verified: p.verified },
    ]),
  ),
);

/** The route a contact qualifies by, or `undefined` when none can qualify it:
 *  a method with a route, documents that list services, and a resolver. */
export function contactRoute(
  contact: TriggerLinkContact,
  methods: ContactMethodTable = DEFAULT_CONTACT_METHODS,
): ContactRoute | undefined {
  const p = methods.policyFor(contact.kind);
  if (p?.route === undefined || !p.listsServices || !p.verified) return undefined;
  // A host-named contact that names no host (a bare did:scid) has no route.
  if (p.route === "host-named" && p.hostPath && p.hostPath(contact.value) === undefined) return undefined;
  return p.route;
}

/**
 * Route A of the contact rule (VTI-LNK-102 / 112): a DID of a method whose
 * identifier names the host serving its document, whose document can list
 * services, and whose document this reader verifies. `did:webvh`, `did:web`.
 */
export function isHostNamedServiceContact(
  contact: TriggerLinkContact,
  methods: ContactMethodTable = DEFAULT_CONTACT_METHODS,
): boolean {
  return contactRoute(contact, methods) === "host-named";
}

/**
 * The contact rule of VTI-LNK-102 / 112, both routes: a contact some route can
 * qualify. A domain-linked contact is only *provisionally* accepted here —
 * the flow still confirms the linkage after the person continues.
 */
export function isServiceContact(
  contact: TriggerLinkContact,
  methods: ContactMethodTable = DEFAULT_CONTACT_METHODS,
): boolean {
  return contactRoute(contact, methods) !== undefined;
}

/**
 * `sign-in` 0.1, draft (VTI-LNK-100 to 105). The contact is the service, and
 * only a contact the rule of VTI-LNK-102 accepts by either route — `did:key`,
 * `did:peer` and any method no route can qualify are `from-not-allowed`.
 */
export const SIGN_IN_FLOW: TriggerLinkFlowSpec = {
  name: "sign-in",
  base: `${FLOW_REGISTRY_BASE}sign-in`,
  major: 0,
  minors: [1],
  draft: true,
  requiresExp: true,
  allowsContact: isServiceContact,
};

/** The flows this plugin implements, as a reader. `vta-claim` is deliberately
 *  absent: this wallet does not claim VTAs from a Farm, so such a link is
 *  `unknown-flow` (outcome `update`). A reader that adds it uses
 *  {@link isServiceContact} as its `allowsContact` (VTI-LNK-112). */
export const READER_FLOWS: readonly TriggerLinkFlowSpec[] = [SIGN_IN_FLOW];

// ── Results ──────────────────────────────────────────────────────────────────

/** The contact, classified (VTI-LNK-030). `value` is percent-decoded once. */
export interface TriggerLinkContact {
  kind: ContactKind;
  value: string;
}

export interface ParsedTriggerLink {
  /** The scheme the text arrived under, lowercased. */
  scheme: string;
  /** The link host, after WHATWG host parsing (lowercased, ASCII). */
  host: string;
  from: TriggerLinkContact;
  /** The handle, exactly as written. Compare as a string (VTI-LNK-035). */
  id: string;
  /** Epoch seconds, when present. */
  exp?: number;
  /** The resolved flow, when `_type` was present. Absent means the link did
   *  not name one (VTI-LNK-055) — the caller decides whether it can place it. */
  flow?: {
    spec: TriggerLinkFlowSpec;
    /** The resolved flow URI, compared as a whole string (VTI-LNK-041). */
    uri: string;
    major: number;
    minor: number;
  };
}

export type TriggerLinkResult =
  | { ok: true; link: ParsedTriggerLink }
  | {
      ok: false;
      reason: TriggerLinkReason;
      outcome: TriggerLinkOutcome;
      /** With `from-not-allowed` only: the contact's DID method, which the
       *  flow does not accept (VTI-LNK-031). Not the link field and not the
       *  contact — for an operator's "Details", never for the message. */
      method?: ContactKind;
    };

export interface ParseTriggerLinkOptions {
  /** The reader's clock, in **epoch seconds**. Required: the parser has no
   *  clock of its own, so a test and the extension pass the same thing. */
  now: number;
  /** Flows this reader implements. Defaults to {@link READER_FLOWS}. */
  flows?: readonly TriggerLinkFlowSpec[];
  /** Custom schemes this reader registers for its own scanner (VTI-LNK-012).
   *  Lowercase. The browser plugin registers none. */
  aliasSchemes?: readonly string[];
  /** The reader's contact methods. Defaults to {@link DEFAULT_CONTACT_METHODS};
   *  the flow passes the registry in `did/methods.ts`. */
  contactMethods?: ContactMethodTable;
}

/** The four reserved names (VTI-LNK-011). Everything else is ignored. */
const RESERVED = ["_from", "_id", "_exp", "_type"] as const;
type ReservedName = (typeof RESERVED)[number];

/** VTI-LNK-020 step 1. */
export const MAX_TRIGGER_LINK_CODE_POINTS = 1536;

/** VTI-LNK-020 step 10. */
export const EXPIRY_ALLOWANCE_SECONDS = 60;

function fail(reason: TriggerLinkReason, method?: ContactKind): TriggerLinkResult {
  return { ok: false, reason, outcome: outcomeOf(reason), ...(method ? { method } : {}) };
}

/**
 * Parse and validate a trigger link, in the order VTI-LNK-020 fixes.
 *
 * Returns the parsed link, or the reason and outcome. Never throws.
 */
export function parseTriggerLink(text: string, opts: ParseTriggerLinkOptions): TriggerLinkResult {
  const flows = opts.flows ?? READER_FLOWS;
  const aliases = (opts.aliasSchemes ?? []).map((s) => s.toLowerCase());

  // 1. Trim ASCII whitespace; length in code points.
  const s = trimAsciiWhitespace(typeof text === "string" ? text : "");
  if (countCodePoints(s) > MAX_TRIGGER_LINK_CODE_POINTS) return fail("too-long");

  // 2. `<scheme>://`, case-insensitively, for https, http or an alias.
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(s);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (!scheme || !(scheme === "https" || scheme === "http" || aliases.includes(scheme))) {
    return fail("not-ours");
  }
  const hashAt = s.indexOf("#");
  const beforeHash = hashAt === -1 ? s : s.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : s.slice(hashAt + 1);
  const fragmentPairs = parseFormPairs(fragment);
  if (!fragmentPairs.some((p) => isReserved(p.name))) {
    // A link that carries the fields in the query is a producer error
    // (VTI-LNK-010) worth telling apart from text that is simply not ours.
    const queryAt = beforeHash.indexOf("?");
    const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
    return fail(parseFormPairs(query).some((p) => isReserved(p.name)) ? "query-form" : "not-ours");
  }
  if (scheme === "http") return fail("insecure-scheme");

  // 3. Control characters and space anywhere, or a second `#`.
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x20 || cp === 0x7f) return fail("bad-grammar");
  }
  if (fragment.includes("#")) return fail("bad-grammar");

  // 4. The authority: no userinfo, no port, and a host that meets the host
  //    rules after WHATWG host parsing as for an `https` URL.
  const afterScheme = beforeHash.slice(schemeMatch![0].length);
  const authorityEnd = afterScheme.search(/[/?\\]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.includes("@") || authority.includes(":")) return fail("bad-authority");
  const host = whatwgHost(authority);
  if (host === undefined || !meetsHostRules(host)) return fail("bad-authority");

  // 5. A reserved name more than once.
  const fields: Partial<Record<ReservedName, { raw: string; value: string }>> = {};
  for (const p of fragmentPairs) {
    if (!isReserved(p.name)) continue; // VTI-LNK-011: ignore every other name
    if (fields[p.name] !== undefined) return fail("repeated-param");
    fields[p.name] = { raw: p.rawValue, value: p.value };
  }

  // 6. The contact.
  const fromField = fields._from;
  if (fromField === undefined) return fail("missing-from");
  const methods = opts.contactMethods ?? DEFAULT_CONTACT_METHODS;
  const contact = classifyContact(fromField.value, methods);
  if (contact === "bad-from" || contact === "unsupported-vid") return fail(contact);

  // 7. The handle and the expiry.
  const idField = fields._id;
  if (idField === undefined || !isValidHandle(idField.value)) return fail("bad-id");
  let exp: number | undefined;
  if (fields._exp !== undefined) {
    const parsed = parseEpochSeconds(fields._exp.value);
    if (parsed === undefined) return fail("bad-exp");
    exp = parsed;
  }

  // 8. The flow.
  let flow: ParsedTriggerLink["flow"];
  if (fields._type !== undefined) {
    const resolved = resolveFlowType(fields._type.raw, host);
    if (resolved === undefined) return fail("bad-type");
    const placed = placeFlow(resolved, flows);
    if (!placed.ok) return fail(placed.reason);
    flow = placed.flow;
  }

  // 9. The flow's own rules.
  if (flow) {
    if (!flow.spec.allowsContact(contact, methods)) return fail("from-not-allowed", contact.kind);
    if (flow.spec.requiresExp && exp === undefined) return fail("missing-exp");
  }

  // 10. Expiry, with the 60 s allowance for a phone's clock.
  if (exp !== undefined && exp + EXPIRY_ALLOWANCE_SECONDS <= opts.now) return fail("expired");

  // 11. Accept.
  return {
    ok: true,
    link: {
      scheme,
      host,
      from: contact,
      id: idField.value,
      ...(exp !== undefined ? { exp } : {}),
      ...(flow ? { flow } : {}),
    },
  };
}

/**
 * Whether a piece of text is a trigger link at all, as opposed to text for the
 * reader's other handlers: anything whose outcome is not `pass-on`.
 */
export function isTriggerLinkText(text: string, opts: ParseTriggerLinkOptions): boolean {
  const r = parseTriggerLink(text, opts);
  return r.ok || r.outcome !== "pass-on";
}

// ── Host rules (VTI-LNK-060) ─────────────────────────────────────────────────

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host rules of VTI-LNK-060, applied to an already-parsed host (lowercase
 * ASCII, as WHATWG host parsing produces). Used for the link host here, and by
 * the flow for the contact's host and every endpoint host it contacts.
 *
 * A DNS name of at least two labels and at most 253 characters, no trailing
 * dot, each label 1 to 63 of `a-z0-9-` not starting or ending with `-`, the
 * last label not all digits (which also refuses every IPv4 form WHATWG turns
 * into dotted decimal), no IPv6 literal (refused by the label grammar), and
 * not `localhost`, `*.localhost`, `*.local` or `home.arpa` and below.
 */
export function meetsHostRules(host: string): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (host.endsWith(".")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!LABEL.test(label)) return false;
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local")) return false;
  if (host === "home.arpa" || host.endsWith(".home.arpa")) return false;
  return true;
}

/** WHATWG host parsing as for an `https` URL, or `undefined` on failure. */
function whatwgHost(authority: string): string | undefined {
  if (authority.length === 0) return undefined;
  try {
    const u = new URL(`https://${authority}/`);
    // The parser may have moved something we refused into another component
    // (it never should, given the checks above), so insist nothing else came
    // out of it.
    if (u.username || u.password || u.port) return undefined;
    return u.hostname;
  } catch {
    return undefined;
  }
}

// ── Fields ───────────────────────────────────────────────────────────────────

/**
 * VTI-LNK-033: 16 to 32 bytes as unpadded base64url, 22 to 43 characters, never
 * a length of 1 mod 4 (no whole number of bytes produces one), and the unused
 * low bits of the last character zero, so a handle has exactly one spelling.
 */
export function isValidHandle(id: string): boolean {
  if (!/^[A-Za-z0-9_-]{22,43}$/.test(id)) return false;
  const rem = id.length % 4;
  if (rem === 1) return false;
  if (rem === 0) return true;
  const last = B64URL.indexOf(id[id.length - 1]!);
  // 2 chars carry 12 bits for 1 byte: 4 unused. 3 chars carry 18 for 2: 2 unused.
  const unusedMask = rem === 2 ? 0b1111 : 0b11;
  return (last & unusedMask) === 0;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** VTI-LNK-036: `0`, or decimal with no leading zero, at most 2^53−1. */
function parseEpochSeconds(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  if (value.length > 16) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** DID syntax (DID Core §3.1), DID only — no path, query or fragment. */
const DID_SYNTAX = /^did:[a-z0-9]+:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/;

/** A `did:scid` contact may be a DID URL whose only query is `src`
 *  (VTI-KEY-163): the DID before it must be a DID, and `src` a host and path. */
const SCID_SRC_SYNTAX = /^[A-Za-z0-9._~:%/-]+$/;

function isContactDidSyntax(value: string): boolean {
  const src = scidSrcOf(value);
  if (src === undefined) return DID_SYNTAX.test(value);
  return DID_SYNTAX.test(value.slice(0, value.indexOf("?"))) && !value.includes("#") && SCID_SRC_SYNTAX.test(src);
}

/**
 * VTI-LNK-020 step 6, VTI-LNK-030 to 032. Empty is `bad-from`. A value
 * containing `/@` is an agent name, reserved and refused as `unsupported-vid`
 * before any DID syntax check — `members.example.org/@` must not read as merely
 * malformed, because a newer reader may support it. A value beginning `did:`
 * that is not a DID is `bad-from`; a DID of a method this reader cannot use is
 * `unsupported-vid`. Anything that is neither a DID nor an agent name (a bare
 * KERI identifier, a URN, plain text) is an identifier type this reader does
 * not implement, and a reader cannot tell a type it does not know from one
 * that does not exist (VTI-LNK-031): `unsupported-vid`.
 */
function classifyContact(
  value: string,
  methods: ContactMethodTable,
): TriggerLinkContact | "bad-from" | "unsupported-vid" {
  if (value.length === 0) return "bad-from";
  if (value.includes("/@")) return "unsupported-vid";
  if (value.startsWith("did:")) {
    if (!isContactDidSyntax(value)) return "bad-from";
    const kind: ContactKind = `did:${value.slice(4, value.indexOf(":", 4))}`;
    const policy = methods.policyFor(kind);
    // A method the reader has no policy for, or one with a route but no
    // resolver, is one it cannot use (VTI-LNK-031).
    if (!policy || (policy.route !== undefined && !policy.verified)) return "unsupported-vid";
    if (policy.wellFormed && !policy.wellFormed(value)) return "bad-from";
    if (policy.supports && !policy.supports(value)) return "unsupported-vid";
    return { kind, value };
  }
  return "unsupported-vid";
}

/**
 * What a reader shows for the contact before anything is resolved
 * (VTI-LNK-050): the domain, followed by the path where the identifier has
 * one — `dids.example.org/farm-auth` for
 * `did:webvh:<SCID>:dids.example.org:farm-auth`. `undefined` for a contact
 * with no domain (every domain-linked method); the caller then shows its own
 * label or says there is none.
 */
export function contactDomainLabel(
  contact: TriggerLinkContact,
  methods: ContactMethodTable = DEFAULT_CONTACT_METHODS,
): string | undefined {
  const segments = methods.policyFor(contact.kind)?.hostPath?.(contact.value);
  return segments && segments.length > 0 ? segments.join("/") : undefined;
}

/**
 * VTI-LNK-040 / 041. Both forms are checked on the value **as written**,
 * before percent-decoding: `sign%2Din` is refused rather than decoded into
 * shape, because a reader MUST NOT normalise a `_type` (VTI-LNK-040). The path
 * form resolves against `https://` and the link's host, lowercased, whatever
 * the link's scheme; the absolute form gets no such repair — it is written out
 * in full, so `https://LINK.…` or a `:443` is refused, not fixed.
 */
function resolveFlowType(raw: string, host: string): string | undefined {
  if (raw.startsWith("/")) {
    return isFlowPath(raw) ? `https://${host.toLowerCase()}${raw}` : undefined;
  }
  // Absolute form: `https://` in lower case, a lowercase host meeting the host
  // rules (no userinfo, no port — `@` and `:` are not host characters, so the
  // host rules refuse both), then a path meeting every path-form constraint.
  // No query or fragment: `?`, `#` and `%` are outside the path's characters.
  const SCHEME = "https://";
  if (!raw.startsWith(SCHEME)) return undefined;
  const rest = raw.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return undefined;
  const flowHost = rest.slice(0, slash);
  if (!meetsHostRules(flowHost)) return undefined;
  return isFlowPath(rest.slice(slash)) ? raw : undefined;
}

/**
 * The path-form constraints of VTI-LNK-040, on text as written: exactly one
 * leading `/`, only `A-Za-z0-9-._~/`, no empty, `.` or `..` segment, no
 * percent-encoding, and a last segment `<MAJOR>.<MINOR>` with no leading
 * zeros.
 */
function isFlowPath(path: string): boolean {
  if (!/^\/[A-Za-z0-9\-._~/]+$/.test(path)) return false;
  const segments = path.slice(1).split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return isVersionSegment(segments[segments.length - 1]!);
}

function isVersionSegment(seg: string): boolean {
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(seg);
}

/**
 * VTI-LNK-043 / 044. A path that names an implemented flow on another host is
 * `wrong-host`, not `unknown-flow` — telling the person to update would be
 * wrong. Compared as whole strings, never by final name alone.
 */
function placeFlow(
  uri: string,
  flows: readonly TriggerLinkFlowSpec[],
):
  | { ok: true; flow: NonNullable<ParsedTriggerLink["flow"]> }
  | { ok: false; reason: "wrong-host" | "unknown-flow" | "unsupported-version" } {
  const lastSlash = uri.lastIndexOf("/");
  const base = uri.slice(0, lastSlash);
  const [majorStr, minorStr] = uri.slice(lastSlash + 1).split(".") as [string, string];
  const major = Number(majorStr);
  const minor = Number(minorStr);

  const spec = flows.find((f) => f.base === base);
  if (!spec) {
    const path = pathOf(base);
    if (flows.some((f) => pathOf(f.base) === path)) return { ok: false, reason: "wrong-host" };
    return { ok: false, reason: "unknown-flow" };
  }
  if (major !== spec.major) return { ok: false, reason: "unsupported-version" };
  const accepted = spec.draft ? spec.minors.includes(minor) : minor >= Math.min(...spec.minors);
  if (!accepted) return { ok: false, reason: "unsupported-version" };
  return { ok: true, flow: { spec, uri, major, minor } };
}

/** The path of an absolute `https://host/path` string. */
function pathOf(absolute: string): string {
  const afterScheme = absolute.replace(/^https:\/\//i, "");
  const slash = afterScheme.indexOf("/");
  return slash === -1 ? "" : afterScheme.slice(slash);
}

// ── application/x-www-form-urlencoded, per WHATWG ────────────────────────────

interface FormPair {
  name: string;
  value: string;
  /** The value as written, before `+` and percent decoding. */
  rawValue: string;
}

/**
 * Split on `&`, skip empty sequences, split each at its **first** `=`, replace
 * `+` with a space, percent-decode once (a malformed `%` stays as written), and
 * decode as UTF-8. A raw `=` inside a value therefore reads the same as `%3D`.
 */
function parseFormPairs(input: string): FormPair[] {
  const out: FormPair[] = [];
  for (const seq of input.split("&")) {
    if (seq.length === 0) continue;
    const eq = seq.indexOf("=");
    const rawName = eq === -1 ? seq : seq.slice(0, eq);
    const rawValue = eq === -1 ? "" : seq.slice(eq + 1);
    out.push({ name: formDecode(rawName), value: formDecode(rawValue), rawValue });
  }
  return out;
}

function formDecode(s: string): string {
  return percentDecode(s.replace(/\+/g, " "));
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function percentDecode(s: string): string {
  const bytes = utf8Encoder.encode(s);
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x25 && i + 2 < bytes.length && isHex(bytes[i + 1]!) && isHex(bytes[i + 2]!)) {
      out[n++] = (hexVal(bytes[i + 1]!) << 4) | hexVal(bytes[i + 2]!);
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  return utf8Decoder.decode(out.subarray(0, n));
}

function isHex(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

function hexVal(b: number): number {
  if (b <= 0x39) return b - 0x30;
  if (b <= 0x46) return b - 0x41 + 10;
  return b - 0x61 + 10;
}

function isReserved(name: string): name is ReservedName {
  return (RESERVED as readonly string[]).includes(name);
}

/** ASCII whitespace per WHATWG Infra: TAB, LF, FF, CR, SPACE. */
function trimAsciiWhitespace(s: string): string {
  return s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
