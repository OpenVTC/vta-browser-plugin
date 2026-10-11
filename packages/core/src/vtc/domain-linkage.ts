// Route B of the contact rule: is the portal origin linked to the contact's
// DID? (dtgwg-vti-spec #58, DIF Well-Known DID Configuration v1.0.)
//
// A host-named contact (`did:webvh`, `did:web`) names the host that serves its
// document, so a portal on that host is the DID's by construction. Any other
// method names no host, and its document's `SignInPortal` is only the DID's
// claim about a website. The website has to agree: it publishes, at
// `<origin>/.well-known/did-configuration.json`, a Domain Linkage Credential
// the DID signed for exactly that origin.
//
// The flow asks this only AFTER the person continues and BEFORE the claim, and
// on failure sends nothing to the contact's services (`domain-not-linked`,
// outcome `invalid`). The request itself goes to the portal origin, the page
// the person is on, with no credentials and no redirect followed.
//
// Formats accepted, both verified with crypto this package already carries:
//   - JWT, `alg` EdDSA (Ed25519) or ES256 (P-256);
//   - JSON-LD with a Data Integrity `eddsa-jcs-2022` proof.
// The signing key must be listed under `assertionMethod` in the contact's
// verified document — the one the flow already resolved, never re-fetched.

import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { multibase } from "@openvtc/vti-didcomm-js";

import { base64urlToBytes } from "../util/base64url.js";
import { withFetchTimeout, isFetchTimeout } from "../http/timeout-fetch.js";
import { listsMethodUnder, verifyTrustTaskProof } from "../trust-tasks/verify.js";

/** The DID Configuration resource's `@context` (DIF v1.0). */
export const DID_CONFIGURATION_CONTEXT = "https://identity.foundation/.well-known/did-configuration/v1";

/** Where the resource lives on an origin. */
export const DID_CONFIGURATION_PATH = "/.well-known/did-configuration.json";

/** The most the reader reads of the resource. */
export const DID_CONFIGURATION_MAX_BYTES = 64 * 1024;

/** How long the reader waits for it. */
export const DOMAIN_LINKAGE_TIMEOUT_MS = 10_000;

/** The clock allowance on a credential's validity window, as for `_exp`. */
export const DOMAIN_LINKAGE_CLOCK_ALLOWANCE_SECONDS = 60;

/** At most this many `linked_dids` entries are looked at. */
const MAX_LINKED_DIDS = 32;

const DOMAIN_LINKAGE_CREDENTIAL = "DomainLinkageCredential";

export type DomainLinkageFormat = "jwt" | "jsonld";

export type DomainLinkageResult =
  | { ok: true; format: DomainLinkageFormat }
  /** `detail` is for tests and a log line; it names no URL, key or DID. */
  | { ok: false; reason: "domain-not-linked"; detail: string };

export interface VerifyDomainLinkageOptions {
  /** The contact's DID. */
  did: string;
  /** Its verified DID document (VTI-LNK-052). */
  didDocument: Record<string, unknown>;
  /** The portal origin, `https://host[:port]`, from the verified document. */
  origin: string;
  /** Epoch milliseconds. */
  now: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

class LinkageError extends Error {}

function fail(detail: string): never {
  throw new LinkageError(detail);
}

/**
 * Fetch the portal origin's DID Configuration and accept it only if one of its
 * `linked_dids` is a Domain Linkage Credential, valid now, for exactly this
 * DID and this origin, signed with one of the DID's `assertionMethod` keys.
 * Never throws.
 */
export async function verifyDomainLinkage(opts: VerifyDomainLinkageOptions): Promise<DomainLinkageResult> {
  try {
    const origin = httpsOrigin(opts.origin);
    const config = await fetchDidConfiguration(origin, opts);
    let last = "no linked DID";
    for (const entry of config.linked_dids.slice(0, MAX_LINKED_DIDS)) {
      try {
        const format = await checkDomainLinkageCredential(entry, {
          did: opts.did,
          didDocument: opts.didDocument,
          origin,
          now: opts.now,
        });
        return { ok: true, format };
      } catch (err) {
        if (!(err instanceof LinkageError)) throw err;
        last = err.message;
      }
    }
    return { ok: false, reason: "domain-not-linked", detail: last };
  } catch (err) {
    const detail = err instanceof LinkageError ? err.message : "unexpected error";
    return { ok: false, reason: "domain-not-linked", detail };
  }
}

function httpsOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail("the portal origin is not a URL");
  }
  if (url.protocol !== "https:" || url.origin !== origin) fail("the portal origin is not an https origin");
  return origin;
}

interface DidConfiguration {
  "@context": string;
  linked_dids: unknown[];
}

async function fetchDidConfiguration(origin: string, opts: VerifyDomainLinkageOptions): Promise<DidConfiguration> {
  const url = `${origin}${DID_CONFIGURATION_PATH}`;
  const fetchFn = withFetchTimeout(opts.fetch, opts.timeoutMs ?? DOMAIN_LINKAGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      // The resource must be served by the portal origin itself.
      redirect: "error",
    });
  } catch (err) {
    return fail(isFetchTimeout(err) ? "timeout" : "unreachable");
  }
  // Belt and braces for a fetch that followed anyway.
  if (res.redirected || res.type === "opaqueredirect") fail("redirected");
  if (res.url) {
    let landed: string | undefined;
    try {
      landed = new URL(res.url).origin;
    } catch {
      landed = undefined;
    }
    if (landed !== origin) fail("redirected");
  }
  if (res.status !== 200) fail(`status ${res.status}`);
  const text = await readCapped(res, DID_CONFIGURATION_MAX_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  const doc = body as Partial<DidConfiguration> | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("not a DID Configuration");
  if (doc!["@context"] !== DID_CONFIGURATION_CONTEXT) fail("wrong @context");
  if (!Array.isArray(doc!.linked_dids)) fail("no linked_dids");
  return doc as DidConfiguration;
}

/** The body as UTF-8, refusing it once it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) fail("too large");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) fail("too large");
    return decodeUtf8(decoder, buf);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      fail("too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return decodeUtf8(decoder, all);
}

function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return fail("not UTF-8");
  }
}

// ── The credential ───────────────────────────────────────────────────────────

export interface DomainLinkageExpectations {
  did: string;
  didDocument: Record<string, unknown>;
  origin: string;
  /** Epoch milliseconds. */
  now: number;
}

/**
 * Check one `linked_dids` entry: a JWT string or a JSON-LD credential object.
 * Returns its format, or throws with the reason it is not accepted.
 */
export async function checkDomainLinkageCredential(
  entry: unknown,
  want: DomainLinkageExpectations,
): Promise<DomainLinkageFormat> {
  if (typeof entry === "string") {
    await checkJwt(entry, want);
    return "jwt";
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    await checkJsonLd(entry as Record<string, unknown>, want);
    return "jsonld";
  }
  return fail("an entry that is neither a JWT nor a credential");
}

function issuerId(issuer: unknown): unknown {
  return issuer && typeof issuer === "object" ? (issuer as { id?: unknown }).id : issuer;
}

/** The parts of a Domain Linkage Credential both formats share. */
function checkCredentialBody(
  vc: Record<string, unknown>,
  want: DomainLinkageExpectations,
  issuerRequired: boolean,
): { from?: number; until?: number } {
  const type = vc.type;
  if (!Array.isArray(type) || !type.includes(DOMAIN_LINKAGE_CREDENTIAL)) fail("not a DomainLinkageCredential");
  if (issuerRequired || vc.issuer !== undefined) {
    if (issuerId(vc.issuer) !== want.did) fail("wrong issuer");
  }
  const subject = vc.credentialSubject as { id?: unknown; origin?: unknown } | undefined;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) fail("no credentialSubject");
  if (subject!.id !== want.did) fail("wrong subject DID");
  if (subject!.origin !== want.origin) fail("wrong origin");
  const from = dateMs(vc.validFrom ?? vc.issuanceDate);
  const until = dateMs(vc.validUntil ?? vc.expirationDate);
  return { ...(from !== undefined ? { from } : {}), ...(until !== undefined ? { until } : {}) };
}

function dateMs(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return fail("a date that is not a string");
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) fail("a date that does not parse");
  return ms;
}

/** Valid now, with the allowance either side. An expiry is required. */
function checkWindow(from: number | undefined, until: number | undefined, now: number): void {
  const allowance = DOMAIN_LINKAGE_CLOCK_ALLOWANCE_SECONDS * 1000;
  if (until === undefined) fail("no expiry");
  if (from !== undefined && from - allowance > now) fail("not yet valid");
  if (until! + allowance <= now) fail("expired");
}

// ── JWT ──────────────────────────────────────────────────────────────────────

function jsonPart(part: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlToBytes(part)));
  } catch {
    return fail("a malformed JWT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("a malformed JWT");
  return parsed as Record<string, unknown>;
}

function numericDateMs(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return fail(`a malformed ${name}`);
  return v * 1000;
}

async function checkJwt(jwt: string, want: DomainLinkageExpectations): Promise<void> {
  const parts = jwt.split(".");
  if (parts.length !== 3) fail("a malformed JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = jsonPart(h);
  const payload = jsonPart(p);
  const alg = header.alg;
  if (alg !== "EdDSA" && alg !== "ES256") fail("an unsupported JWT alg");
  if (header.crit !== undefined) fail("a JWT with crit");
  if (payload.iss !== want.did) fail("wrong issuer");
  if (payload.sub !== want.did) fail("wrong subject DID");
  const vc = payload.vc;
  if (!vc || typeof vc !== "object" || Array.isArray(vc)) fail("no vc claim");
  const body = checkCredentialBody(vc as Record<string, unknown>, want, false);
  const nbf = numericDateMs(payload.nbf, "nbf");
  const exp = numericDateMs(payload.exp, "exp");
  // Where both the JWT and the credential give a bound, the narrower holds.
  const from = [nbf, body.from].filter((x): x is number => x !== undefined);
  const until = [exp, body.until].filter((x): x is number => x !== undefined);
  checkWindow(from.length ? Math.max(...from) : undefined, until.length ? Math.min(...until) : undefined, want.now);

  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) fail("a JWT with no kid");
  const vm = (kid as string).startsWith("#") ? `${want.did}${kid as string}` : (kid as string);
  if (!vm.startsWith(`${want.did}#`)) fail("a key of another DID");
  const key = assertionKey(want.didDocument, vm);
  if ((alg === "EdDSA") !== (key.curve === "Ed25519")) fail("the alg does not match the key");
  let sig: Uint8Array;
  try {
    sig = base64urlToBytes(s);
  } catch {
    return fail("a malformed JWT signature");
  }
  if (sig.length !== 64) fail("bad signature");
  const input = new TextEncoder().encode(`${h}.${p}`);
  let ok = false;
  try {
    ok =
      key.curve === "Ed25519"
        ? ed25519.verify(sig, input, key.bytes)
        : p256.verify(sig, input, key.bytes, { prehash: true, lowS: false });
  } catch {
    ok = false;
  }
  if (!ok) fail("bad signature");
}

interface PublicKey {
  curve: "Ed25519" | "P-256";
  bytes: Uint8Array;
}

/** The public key of `vm`, which must be listed under `assertionMethod`. */
function assertionKey(doc: Record<string, unknown>, vm: string): PublicKey {
  if (!listsMethodUnder(doc, vm, "assertionMethod")) fail("a key not under assertionMethod");
  const fragment = vm.slice(vm.indexOf("#"));
  const names = (m: unknown) => {
    const id = (m as { id?: unknown } | null)?.id;
    return id === vm || id === fragment;
  };
  const embedded = Array.isArray(doc.assertionMethod)
    ? doc.assertionMethod.find((m) => m && typeof m === "object" && names(m))
    : undefined;
  const listed = Array.isArray(doc.verificationMethod) ? doc.verificationMethod.find(names) : undefined;
  const method = (embedded ?? listed) as
    | { publicKeyMultibase?: unknown; publicKeyJwk?: { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown } }
    | undefined;
  if (!method) return fail("a key the document does not have");
  try {
    if (typeof method.publicKeyMultibase === "string") {
      const { codec, key } = multibase.decodeMultikey(method.publicKeyMultibase);
      const is = (c: Uint8Array) => codec.length === c.length && codec.every((b, i) => b === c[i]);
      if (is(multibase.MULTICODEC.ED25519_PUB) && key.length === 32) return { curve: "Ed25519", bytes: key };
      if (is(multibase.MULTICODEC.P256_PUB)) return { curve: "P-256", bytes: key };
      return fail("an unsupported key type");
    }
    const jwk = method.publicKeyJwk;
    if (jwk && typeof jwk === "object") {
      if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") {
        const x = base64urlToBytes(jwk.x);
        if (x.length === 32) return { curve: "Ed25519", bytes: x };
      }
      if (jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string") {
        const x = base64urlToBytes(jwk.x);
        const y = base64urlToBytes(jwk.y);
        if (x.length === 32 && y.length === 32) {
          const bytes = new Uint8Array(65);
          bytes[0] = 0x04;
          bytes.set(x, 1);
          bytes.set(y, 33);
          return { curve: "P-256", bytes };
        }
      }
    }
  } catch (err) {
    if (err instanceof LinkageError) throw err;
    return fail("a malformed key");
  }
  return fail("an unsupported key type");
}

// ── JSON-LD, eddsa-jcs-2022 ──────────────────────────────────────────────────

async function checkJsonLd(cred: Record<string, unknown>, want: DomainLinkageExpectations): Promise<void> {
  const body = checkCredentialBody(cred, want, true);
  checkWindow(body.from, body.until, want.now);
  const proof = cred.proof as Record<string, unknown> | undefined;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) fail("no single proof");
  if (proof!.type !== "DataIntegrityProof" || proof!.cryptosuite !== "eddsa-jcs-2022") fail("an unsupported proof");
  if (proof!.proofPurpose !== "assertionMethod") fail("a proof not for assertionMethod");
  const vm = proof!.verificationMethod;
  if (typeof vm !== "string" || !vm.startsWith(`${want.did}#`)) fail("a key of another DID");
  // eddsa-jcs-2022 verification: a proof `@context` must be a prefix of the
  // credential's.
  const proofContext = proof!["@context"];
  if (proofContext !== undefined) {
    const docCtx = ([] as unknown[]).concat(cred["@context"] ?? []);
    const pCtx = ([] as unknown[]).concat(proofContext);
    if (pCtx.some((c, i) => JSON.stringify(c) !== JSON.stringify(docCtx[i]))) fail("a proof @context that does not match");
  }
  if (!listsMethodUnder(want.didDocument, vm as string, "assertionMethod")) fail("a key not under assertionMethod");
  const result = await verifyTrustTaskProof(cred, {
    expectedProofPurpose: "assertionMethod",
    resolveDid: async (d) => {
      if (d !== want.did) throw new Error("another DID");
      return want.didDocument;
    },
  });
  if (!result.verified || result.signer !== want.did) fail("bad signature");
}
