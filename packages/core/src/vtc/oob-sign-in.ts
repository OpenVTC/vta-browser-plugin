// Wallet sign-in to a community portal: the approver's side of `auth/oob/*`.
//
// A portal shows a trigger link (`links/`); the member's wallet reads it,
// checks the community against its own records, and — only after the member
// picks an identity and presses Continue — claims the request with a fresh
// throwaway key `K_a`, proves membership with an `identify` its VTA signs, and
// approves with a `grant` its VTA signs after user verification. Base design
// `vtc-qr-login-design.md` §7, §10 and §14; contract
// `sign-in-trigger-link-contract.md` C3 to C6.
//
// This module is the protocol and nothing else: document builders, the checks
// on the community's signed replies, and the selection of the community's
// services from its verified DID document. It holds no key but the `K_a` the
// caller hands it, signs nothing as the member (the caller passes a signer
// that goes through the VTA), and reads no wallet state. That keeps it
// testable against a fake community, and keeps the one place the wire shapes
// live small.
//
// TODO: replace with generated trust-tasks types. Every `Oob*` type below is a
// local copy of base design §10 plus contract C5, because the
// `dtgwg-trust-tasks-tf` bindings for `auth/oob/*` are not published yet.

import { resolve as vtiResolve } from "@openvtc/vti-didcomm-js";

import { assertResolvableWebvhHost } from "../did/egress-guard.js";
import { generateSigningIdentity, type SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import { jcsCanonicalize, sha256, base58btcEncode } from "../trust-tasks/canonical.js";
import { meetsHostRules, type TriggerLinkReason } from "../links/trigger-link.js";
import { isTrustTaskErrorType } from "../vta/protocol.js";
import { trustTaskUrl, TRUST_TASK_HTTPS_SERVICE_TYPE } from "../vta/endpoint.js";
import { withFetchTimeout, isFetchTimeout } from "../http/timeout-fetch.js";

// ── Type URIs (contract C5) ──────────────────────────────────────────────────

const OOB = "https://trusttasks.org/spec/auth/oob";

/** TODO: replace with generated trust-tasks types. */
export const OOB_TYPES = {
  claim: `${OOB}/claim/0.1`,
  prove: `${OOB}/prove/0.1`,
  identify: `${OOB}/identify/0.1`,
  respond: `${OOB}/respond/0.1`,
  grant: `${OOB}/grant/0.1`,
  cancel: `${OOB}/cancel/0.1`,
} as const;

const responseType = (type: string) => `${type}#response`;

// ── Payloads (base design §10, contract C5) ──────────────────────────────────
// TODO: replace with generated trust-tasks types

/** The community as it names itself in step 1. */
export interface OobService {
  did: string;
  name: string;
}

/** Step 1, the signed reply to `claim`. Nothing about the starter. */
export interface OobStep1 {
  requestId: string;
  service: OobService;
  origin: string;
  purpose: "login";
  decisionDeadline: string;
}

/**
 * Whether the browser that asked is on the network the approver is on.
 *
 * Base design §10 says `true | false | "unknown"`; the draft `_shared/0.1`
 * schema in `dtgwg-trust-tasks-tf` says `"same" | "different" | "unknown"`.
 * Both are read here until the binding is published — see {@link networkLine}.
 * TODO: replace with generated trust-tasks types, and drop the losing spelling.
 */
export type OobSameNetwork = boolean | "same" | "different" | "unknown";

export interface OobRequester {
  /** City and country, or `"unknown"`. */
  location: string;
  browser: string;
  os: string;
  createdAt: string;
  sameNetwork: OobSameNetwork;
}

/** Step 2, the signed reply to `prove`: step 1 plus the requester. */
export interface OobStep2 extends OobStep1 {
  sessionKey: string;
  requester: OobRequester;
  identifiedAs: string;
}

export interface OobIdentifyPayload {
  requestId: string;
  approverKey: string;
  /** The two digits the member typed. */
  enteredNumber: string;
}

export type OobDecision = "approve" | "decline";

export interface OobGrantPayload {
  requestId: string;
  decision: OobDecision;
  sessionKey: string;
  approverKey: string;
  origin: string;
  contextDigest: string;
  notAfter: string;
}

export interface OobRespondResult {
  status: string;
}

/** A Trust-Task document as this module builds and reads it. */
export interface OobDocument<P = unknown> {
  id: string;
  type: string;
  issuer: string;
  recipient: string;
  issuedAt: string;
  /** Carried on `claim` only: the handle (VTI-LNK-054, contract C5). */
  parentThreadId?: string;
  payload: P;
  proof?: unknown;
  [extra: string]: unknown;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The community refused, with a stable code (R3.7): `alreadyClaimed`,
 * `requestExpired`, `numberMismatch`, `notAuthorized`, `notClaimant`,
 * `alreadyDecided`, `contextMismatch`, `requestNotFound`, `rateLimited`.
 * Match on `code`, never on the message.
 */
export class OobRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OobRefusedError";
  }
}

/** Stable code: a reply did not check out (unsigned, wrong signer, wrong
 *  thread, or a field that differs from what the wallet knows). */
export const OOB_REPLY_INVALID = "auth/oob/reply-invalid";

export class OobReplyInvalidError extends Error {
  readonly code = OOB_REPLY_INVALID;
  constructor(message: string) {
    super(message);
    this.name = "OobReplyInvalidError";
  }
}

// ── The community's verified DID document (C4, VTI-LNK-052/053) ──────────────

/** The portal's service type (contract C4). */
export const SIGN_IN_PORTAL_SERVICE_TYPE = "SignInPortal";

export interface SignInServices {
  /** The origin of the `SignInPortal` service's endpoint. */
  portalOrigin: string;
  /** The Trust-Task base of the first usable `TrustTaskHTTPS` service. */
  trustTaskBase: string;
}

export type SignInServicesResult =
  | { ok: true; services: SignInServices }
  | { ok: false; reason: TriggerLinkReason };

interface DidService {
  type?: unknown;
  serviceEndpoint?: unknown;
}

function hasType(s: DidService, wanted: string): boolean {
  return typeof s.type === "string" ? s.type === wanted : Array.isArray(s.type) && s.type.includes(wanted);
}

function endpointString(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(endpointString).find((x) => x !== undefined);
  if (raw && typeof raw === "object" && typeof (raw as { uri?: unknown }).uri === "string") {
    return (raw as { uri: string }).uri;
  }
  return undefined;
}

/** An `https` URL whose host meets the host rules (VTI-LNK-053 / 060). */
function usableHttpsEndpoint(raw: unknown): URL | undefined {
  const s = endpointString(raw);
  if (s === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  return meetsHostRules(u.hostname) ? u : undefined;
}

/**
 * Pick the portal and the Trust-Task endpoint out of a **verified** document.
 *
 * Matched on `type`, never on `id`; among candidates of one type, the first in
 * document order wins (VTI-LNK-053). Nothing here comes from the link.
 *
 * - No usable `SignInPortal`: `no-portal-service` (outcome `invalid`). VTI-LNK-102
 *   requires one; the chapter names no reason for its absence, so this is a
 *   local reason that maps to `invalid`.
 * - No usable `TrustTaskHTTPS`: `no-common-transport` (outcome `unreachable`).
 */
export function selectSignInServices(doc: unknown): SignInServicesResult {
  const services = Array.isArray((doc as { service?: unknown })?.service)
    ? ((doc as { service: unknown[] }).service as DidService[])
    : [];
  let portal: URL | undefined;
  let base: string | undefined;
  for (const s of services) {
    if (!s || typeof s !== "object") continue;
    if (!portal && hasType(s, SIGN_IN_PORTAL_SERVICE_TYPE)) portal = usableHttpsEndpoint(s.serviceEndpoint);
    if (!base && hasType(s, TRUST_TASK_HTTPS_SERVICE_TYPE)) {
      const u = usableHttpsEndpoint(s.serviceEndpoint);
      if (u) base = u.href.replace(/\/+$/, "");
    }
  }
  if (!portal) return { ok: false, reason: "no-portal-service" };
  if (!base) return { ok: false, reason: "no-common-transport" };
  return { ok: true, services: { portalOrigin: portal.origin, trustTaskBase: base } };
}

/**
 * VTI-LNK-105: the origin of the page the link was activated from must be the
 * portal's origin, compared exactly (scheme, host and port).
 */
export function originMatchesPortal(activationOrigin: string, portalOrigin: string): boolean {
  return typeof activationOrigin === "string" && activationOrigin.length > 0 && activationOrigin === portalOrigin;
}

export interface ResolveCommunityOptions {
  /** Defaults to the shared resolver. The host guards run first either way. */
  resolveDid?: (did: string) => Promise<unknown>;
}

/**
 * Resolve and verify the community's DID document, afresh (VTI-LNK-052/053).
 * For `did:webvh` the resolver walks and verifies the log. The contact's host
 * must meet the host rules — which is where `did:web:example.com%3A8443` is
 * refused. Any failure is `did-document-unverified`, and nothing is sent.
 */
export async function resolveCommunityDocument(
  did: string,
  opts: ResolveCommunityOptions = {},
): Promise<{ ok: true; doc: Record<string, unknown> } | { ok: false; reason: TriggerLinkReason }> {
  const unverified = { ok: false as const, reason: "did-document-unverified" as const };
  const host = contactHost(did);
  if (host === undefined || !meetsHostRules(host)) return unverified;
  try {
    if (did.startsWith("did:webvh:")) assertResolvableWebvhHost(did);
    const res = (await (opts.resolveDid ?? ((d: string) => vtiResolve(d, {})))(did)) as {
      didDocument?: Record<string, unknown>;
      didResolutionMetadata?: { error?: string };
    };
    if (res?.didResolutionMetadata?.error) return unverified;
    const doc = res?.didDocument;
    if (!doc || doc.id !== did) return unverified;
    return { ok: true, doc };
  } catch {
    return unverified;
  }
}

/** The host a did:webvh / did:web names, percent-decoded, or `undefined`. */
function contactHost(did: string): string | undefined {
  const parts = did.split(":");
  const raw = did.startsWith("did:webvh:") ? parts[3] : did.startsWith("did:web:") ? parts[2] : undefined;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

// ── K_a, and the documents it signs ──────────────────────────────────────────

/** The throwaway key for one exchange (VTI-LNK-054). Fresh every time; never
 *  stored; discarded when the exchange ends. */
export function newApproverKey(): SigningIdentity {
  return generateSigningIdentity();
}

function envelope<P>(type: string, issuer: string, recipient: string, payload: P): OobDocument<P> {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    issuer,
    recipient,
    issuedAt: new Date().toISOString(),
    payload,
  };
}

/** `auth/oob/claim`: issuer `K_a`, recipient the community, a unique `id`, the
 *  handle as `parentThreadId` and as `payload.requestId` (contract C5). */
export function buildClaim(kA: SigningIdentity, vtcDid: string, requestId: string): OobDocument<{ requestId: string }> {
  return { ...envelope(OOB_TYPES.claim, kA.did, vtcDid, { requestId }), parentThreadId: requestId };
}

/** `auth/oob/identify`, unsigned: the member's DID as issuer. The VTA signs it
 *  (for `authentication`). */
export function buildIdentify(
  memberDid: string,
  vtcDid: string,
  payload: OobIdentifyPayload,
): OobDocument<OobIdentifyPayload> {
  if (!/^[0-9]{2}$/.test(payload.enteredNumber)) {
    throw new OobReplyInvalidError("the number must be the two digits shown on the screen");
  }
  return envelope(OOB_TYPES.identify, memberDid, vtcDid, payload);
}

export function buildProve(kA: SigningIdentity, vtcDid: string, identify: OobDocument): OobDocument<{ identify: OobDocument }> {
  return envelope(OOB_TYPES.prove, kA.did, vtcDid, { identify });
}

/** `auth/oob/grant`, unsigned. The VTA signs it (for `assertionMethod`) only
 *  with the device's user-verification decision over its digest (C6). */
export function buildGrant(
  memberDid: string,
  vtcDid: string,
  payload: OobGrantPayload,
): OobDocument<OobGrantPayload> {
  return envelope(OOB_TYPES.grant, memberDid, vtcDid, payload);
}

export function buildRespond(kA: SigningIdentity, vtcDid: string, grant: OobDocument): OobDocument<{ grant: OobDocument }> {
  return envelope(OOB_TYPES.respond, kA.did, vtcDid, { grant });
}

export function buildCancel(kA: SigningIdentity, vtcDid: string, requestId: string): OobDocument<{ requestId: string }> {
  return envelope(OOB_TYPES.cancel, kA.did, vtcDid, { requestId });
}

/**
 * A document the VTA signed must come back as sent, plus a `proof` (base
 * design §14 steps 9 and 12). A VTA that rewrote a field would have the member
 * attest to something the wallet never showed them.
 */
export function assertSignedAsSent(unsigned: OobDocument, signed: unknown, expectedPurpose: "authentication" | "assertionMethod"): OobDocument {
  if (!signed || typeof signed !== "object") throw new OobReplyInvalidError("the VTA returned no document");
  const { proof, ...rest } = signed as OobDocument;
  if (!proof || typeof proof !== "object") throw new OobReplyInvalidError("the VTA returned the document unsigned");
  const { proof: _ignored, ...sent } = unsigned;
  if (jcsCanonicalize(rest) !== jcsCanonicalize(sent)) {
    throw new OobReplyInvalidError("the VTA changed the document it was asked to sign");
  }
  const purpose = (proof as { proofPurpose?: unknown }).proofPurpose;
  if (purpose !== expectedPurpose) {
    throw new OobReplyInvalidError(`the VTA signed for ${String(purpose)}, not ${expectedPurpose}`);
  }
  return signed as OobDocument;
}

// ── Digests ──────────────────────────────────────────────────────────────────

/**
 * SHA-256 of the JCS form of a document, as a base58btc `digestMultibase`
 * (sha2-256 multihash, the encoding `task-consent`'s `payloadDigest` uses).
 *
 * TODO: replace with generated trust-tasks types — the encoding of
 * `contextDigest` and of the grant digest is not fixed by the base design or
 * the draft schemas yet; this is the family's existing digest form.
 */
export async function documentDigest(doc: unknown): Promise<string> {
  const hash = await sha256(jcsCanonicalize(doc));
  const mh = new Uint8Array(2 + hash.length);
  mh.set([0x12, 0x20], 0);
  mh.set(hash, 2);
  return `z${base58btcEncode(mh)}`;
}

/** `contextDigest`: over the **signed** step 2 response, proof included. */
export function contextDigest(signedStep2: OobDocument): Promise<string> {
  return documentDigest(signedStep2);
}

/** The digest the user-verification decision covers: the unsigned grant. */
export function grantDigest(unsignedGrant: OobDocument): Promise<string> {
  const { proof: _ignored, ...rest } = unsignedGrant;
  return documentDigest(rest);
}

// ── Sending to the community ─────────────────────────────────────────────────

export interface OobSenderOptions {
  vtcDid: string;
  /** The community's verified document: the reply's signing key is looked up
   *  here, never re-fetched on the strength of the reply. */
  vtcDocument: Record<string, unknown>;
  trustTaskBase: string;
  fetch?: typeof fetch;
}

export interface OobReply<P> {
  doc: OobDocument<P>;
  payload: P;
}

/**
 * Sign `doc` with `K_a` (an operational proof, `authentication`), post it to
 * the community's Trust-Task endpoint, and return its reply once it checks
 * out: signed by the community for `assertionMethod` with a key its verified
 * document lists under `assertionMethod`, threaded to this request, and
 * addressed back to `K_a`. A refusal throws {@link OobRefusedError}.
 */
export async function sendOob<P>(
  kA: SigningIdentity,
  doc: OobDocument,
  opts: OobSenderOptions,
  label: string,
): Promise<OobReply<P>> {
  if (doc.issuer !== kA.did || doc.recipient !== opts.vtcDid) {
    throw new OobReplyInvalidError(`${label}: the document is not from K_a to the community`);
  }
  await signTrustTask({
    envelope: doc as unknown as Record<string, unknown>,
    signing: kA,
    proofPurpose: "authentication",
  });
  const fetchFn = withFetchTimeout(opts.fetch);
  let res: Response;
  try {
    res = await fetchFn(trustTaskUrl(opts.trustTaskBase), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
      // Never follow a redirect off the endpoint the verified document named.
      redirect: "error",
      credentials: "omit",
    });
  } catch (err) {
    throw new OobRefusedError(isFetchTimeout(err) ? "timeout" : "network", `${label}: the community could not be reached`);
  }
  let reply: OobDocument<P> & { payload: P };
  try {
    reply = (await res.json()) as OobDocument<P> & { payload: P };
  } catch {
    throw new OobRefusedError(`http-${res.status}`, `${label}: the community answered ${res.status} with no document`);
  }
  if (isTrustTaskErrorType(reply?.type)) {
    const code = (reply.payload as { code?: unknown } | undefined)?.code;
    throw new OobRefusedError(typeof code === "string" ? code : "taskFailed", `${label}: refused (${String(code)})`);
  }
  if (!res.ok) throw new OobRefusedError(`http-${res.status}`, `${label}: the community answered ${res.status}`);
  if (reply?.type !== responseType(doc.type)) {
    throw new OobReplyInvalidError(`${label}: unexpected reply type ${String(reply?.type)}`);
  }
  if ((reply as { threadId?: unknown }).threadId !== doc.id) {
    throw new OobReplyInvalidError(`${label}: the reply is not threaded to this request`);
  }
  if (reply.recipient !== undefined && reply.recipient !== kA.did) {
    throw new OobReplyInvalidError(`${label}: the reply is addressed to someone else`);
  }
  await assertSignedByCommunity(reply, opts.vtcDid, opts.vtcDocument, label);
  return { doc: reply, payload: reply.payload };
}

/** The community's `assertionMethod` signature over a reply (contract C5). */
export async function assertSignedByCommunity(
  reply: OobDocument,
  vtcDid: string,
  vtcDocument: Record<string, unknown>,
  label: string,
): Promise<void> {
  const result = await verifyTrustTaskProof(reply as unknown as Record<string, unknown>, {
    expectedProofPurpose: "assertionMethod",
    resolveDid: async (did) => {
      if (did !== vtcDid) throw new Error(`reply signed by ${did}, not the community`);
      return vtcDocument;
    },
  });
  if (!result.verified || result.signer !== vtcDid) {
    throw new OobReplyInvalidError(`${label}: the reply is not signed by the community (${result.reason ?? "wrong signer"})`);
  }
  const vm = (reply.proof as { verificationMethod?: string }).verificationMethod!;
  const listed = Array.isArray(vtcDocument.assertionMethod) ? vtcDocument.assertionMethod : [];
  const fragment = vm.slice(vm.indexOf("#"));
  const ok = listed.some((m) => {
    const id = typeof m === "string" ? m : (m as { id?: unknown })?.id;
    return typeof id === "string" && (id === vm || id === fragment);
  });
  if (!ok) throw new OobReplyInvalidError(`${label}: the signing key is not one of the community's assertionMethod keys`);
}

// ── The checks on the community's replies (base design §14 steps 6 and 10) ───

export interface Step1Expectations {
  requestId: string;
  vtcDid: string;
  portalOrigin: string;
  /** Epoch milliseconds. */
  now: number;
}

/** Step 1 must name this request and this community, purpose `login`, the
 *  portal origin from the verified document, and a deadline still ahead. */
export function checkStep1(step1: OobStep1, want: Step1Expectations): OobStep1 {
  const bad = (what: string) => {
    throw new OobReplyInvalidError(`step 1: ${what}`);
  };
  if (!step1 || typeof step1 !== "object") bad("no payload");
  if (step1.requestId !== want.requestId) bad("a different request");
  if (step1.service?.did !== want.vtcDid) bad("a different community");
  if (typeof step1.service?.name !== "string") bad("no community name");
  if (step1.purpose !== "login") bad("a purpose other than login");
  if (step1.origin !== want.portalOrigin) bad("an origin the community's document does not list");
  const deadline = Date.parse(step1.decisionDeadline);
  if (!Number.isFinite(deadline) || deadline <= want.now) bad("the decision deadline has passed");
  return step1;
}

/** Step 2 must repeat step 1 unchanged, carry a `did:key` session key, and
 *  name the identity the member chose. */
export function checkStep2(step2: OobStep2, step1: OobStep1, memberDid: string): OobStep2 {
  const bad = (what: string) => {
    throw new OobReplyInvalidError(`step 2: ${what}`);
  };
  if (!step2 || typeof step2 !== "object") bad("no payload");
  const repeated = (s: OobStep1) => ({
    requestId: s.requestId,
    service: s.service,
    origin: s.origin,
    purpose: s.purpose,
    decisionDeadline: s.decisionDeadline,
  });
  if (jcsCanonicalize(repeated(step2)) !== jcsCanonicalize(repeated(step1))) bad("it does not repeat step 1");
  if (typeof step2.sessionKey !== "string" || !/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/.test(step2.sessionKey)) {
    bad("the session key is not an Ed25519 did:key");
  }
  if (step2.identifiedAs !== memberDid) bad("a different identity");
  const r = step2.requester;
  if (!r || typeof r.location !== "string" || typeof r.browser !== "string" || typeof r.os !== "string") {
    bad("no requester details");
  }
  return step2;
}

/** How the step 2 network line reads (base design §14 step 11). The browser
 *  plugin is on the same device as the browser, so a "different" answer is
 *  always worth a warning here. */
export function networkLine(sameNetwork: OobSameNetwork): "same" | "different" | "unknown" {
  if (sameNetwork === true || sameNetwork === "same") return "same";
  if (sameNetwork === false || sameNetwork === "different") return "different";
  return "unknown";
}
