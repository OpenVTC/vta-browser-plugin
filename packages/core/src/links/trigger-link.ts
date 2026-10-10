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
  // After the link (VTI-LNK-052, 053, 055, 105).
  | "did-document-unverified"
  | "no-common-transport"
  | "untyped"
  | "wrong-origin";

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

/** Contact identifier kinds this reader can classify. */
export type ContactKind = "did:webvh" | "did:web" | "did:key" | "did:peer";

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
   *  the reader supports but the flow does not is `from-not-allowed`. */
  allowsContact: (contact: TriggerLinkContact) => boolean;
}

/** The shared flow registry's root (VTI-LNK-046 table). */
export const FLOW_REGISTRY_BASE = "https://link.trustoverip.org/vti/flow/";

/**
 * `sign-in` 0.1, draft (VTI-LNK-100 to 105). The contact is the VTC, whose DID
 * document must list the portal's service, so a `did:key` (or a `did:peer`
 * with no services, numalgo 0) can never be one (VTI-LNK-102).
 */
export const SIGN_IN_FLOW: TriggerLinkFlowSpec = {
  name: "sign-in",
  base: `${FLOW_REGISTRY_BASE}sign-in`,
  major: 0,
  minors: [1],
  draft: true,
  requiresExp: true,
  allowsContact: (c) =>
    c.kind === "did:webvh" || c.kind === "did:web" || (c.kind === "did:peer" && !c.value.startsWith("did:peer:0")),
};

/** The flows this plugin implements, as a reader. `vta-claim` is deliberately
 *  absent: this wallet does not claim VTAs from a Farm, so such a link is
 *  `unknown-flow` (outcome `update`). */
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
  | { ok: false; reason: TriggerLinkReason; outcome: TriggerLinkOutcome };

export interface ParseTriggerLinkOptions {
  /** The reader's clock, in **epoch seconds**. Required: the parser has no
   *  clock of its own, so a test and the extension pass the same thing. */
  now: number;
  /** Flows this reader implements. Defaults to {@link READER_FLOWS}. */
  flows?: readonly TriggerLinkFlowSpec[];
  /** Custom schemes this reader registers for its own scanner (VTI-LNK-012).
   *  Lowercase. The browser plugin registers none. */
  aliasSchemes?: readonly string[];
}

/** The four reserved names (VTI-LNK-011). Everything else is ignored. */
const RESERVED = ["_from", "_id", "_exp", "_type"] as const;
type ReservedName = (typeof RESERVED)[number];

/** VTI-LNK-020 step 1. */
export const MAX_TRIGGER_LINK_CODE_POINTS = 1536;

/** VTI-LNK-020 step 10. */
export const EXPIRY_ALLOWANCE_SECONDS = 60;

function fail(reason: TriggerLinkReason): TriggerLinkResult {
  return { ok: false, reason, outcome: outcomeOf(reason) };
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
  const contact = classifyContact(fromField.value);
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
    const resolved = resolveFlowType(fields._type.raw, fields._type.value, host);
    if (resolved === undefined) return fail("bad-type");
    const placed = placeFlow(resolved, flows);
    if (!placed.ok) return fail(placed.reason);
    flow = placed.flow;
  }

  // 9. The flow's own rules.
  if (flow) {
    if (!flow.spec.allowsContact(contact)) return fail("from-not-allowed");
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

/** A generic URI scheme prefix: the shape of "some other identifier". */
const OTHER_IDENTIFIER = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

/**
 * VTI-LNK-030 to 032. A value containing `/@` is an agent name, reserved and
 * refused as `unsupported-vid` before anything else — `members.example.org/@`
 * must not read as merely malformed, because a newer reader may support it.
 * A DID of a method this reader cannot use, or a non-DID identifier with a
 * scheme, is likewise `unsupported-vid`. Anything else malformed is `bad-from`.
 */
function classifyContact(value: string): TriggerLinkContact | "bad-from" | "unsupported-vid" {
  if (value.includes("/@")) return "unsupported-vid";
  if (value.startsWith("did:")) {
    if (!DID_SYNTAX.test(value)) return "bad-from";
    const method = value.slice(4, value.indexOf(":", 4));
    switch (method) {
      case "webvh": {
        // did:webvh:<scid>:<host>[:<path>…]
        const parts = value.split(":");
        if (parts.length < 4 || !parts[2] || !parts[3]) return "bad-from";
        return { kind: "did:webvh", value };
      }
      case "web":
        return { kind: "did:web", value };
      case "key":
        if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return "bad-from";
        return { kind: "did:key", value };
      case "peer":
        return { kind: "did:peer", value };
      default:
        return "unsupported-vid";
    }
  }
  return OTHER_IDENTIFIER.test(value) ? "unsupported-vid" : "bad-from";
}

/**
 * What a reader shows for the contact before anything is resolved
 * (VTI-LNK-050): the domain, followed by the path where the identifier has
 * one — `dids.example.org/farm-auth` for
 * `did:webvh:<SCID>:dids.example.org:farm-auth`. `undefined` for a contact
 * with no domain; the caller then shows its own label or says there is none.
 */
export function contactDomainLabel(contact: TriggerLinkContact): string | undefined {
  const parts = contact.value.split(":");
  const segments =
    contact.kind === "did:webvh" ? parts.slice(3) : contact.kind === "did:web" ? parts.slice(2) : undefined;
  if (!segments || segments.length === 0) return undefined;
  const decoded = segments.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
  return decoded.join("/");
}

/**
 * VTI-LNK-040 / 041. The path form is checked on the value **as written**:
 * `sign%2Din` is refused rather than decoded into shape, because a reader
 * MUST NOT normalise a `_type` (VTI-LNK-040). The path form resolves against
 * `https://` and the link's host, lowercased, whatever the link's scheme.
 */
function resolveFlowType(raw: string, value: string, host: string): string | undefined {
  if (raw.startsWith("/")) {
    if (raw.startsWith("//")) return undefined;
    if (!/^[A-Za-z0-9\-._~/]+$/.test(raw)) return undefined;
    const segments = raw.slice(1).split("/");
    if (segments.some((seg) => seg === "." || seg === "..")) return undefined;
    if (!isVersionSegment(segments[segments.length - 1]!)) return undefined;
    return `https://${host.toLowerCase()}${raw}`;
  }
  // Absolute form: an https URI with no query or fragment.
  if (!/^https:\/\//i.test(value)) return undefined;
  if (value.includes("?") || value.includes("#")) return undefined;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  const path = value.slice(value.indexOf("/", "https://".length));
  if (!path.startsWith("/")) return undefined;
  const segments = path.slice(1).split("/");
  if (segments.some((seg) => seg === "." || seg === "..")) return undefined;
  if (!isVersionSegment(segments[segments.length - 1]!)) return undefined;
  return value;
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
