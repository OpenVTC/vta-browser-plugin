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

import { resolveContactDocument, type ContactMethodRegistry } from "../did/methods.js";
import { generateSigningIdentity, type SigningIdentity } from "../siop/self-issued.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import { jcsCanonicalize, sha256, base58btcEncode } from "../trust-tasks/canonical.js";
import { meetsHostRules, type ContactRoute, type TriggerLinkReason } from "../links/trigger-link.js";
import { isTrustTaskErrorType } from "../vta/protocol.js";
import { TRUST_TASK_HTTPS_SERVICE_TYPE, trustTaskUrl } from "../vta/endpoint.js";
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
  // 0.2: step 2 may offer `signingScope`, which the grant copies to let the
  // website's browser key sign those task families as the member for the
  // session (auth/oob/grant/0.2). Everything else is 0.1's.
  prove02: `${OOB}/prove/0.2`,
  respond02: `${OOB}/respond/0.2`,
  grant02: `${OOB}/grant/0.2`,
} as const;

/** Which `prove` / `grant` / `respond` this exchange uses. 0.2 is tried first;
 *  a community that predates it refuses `prove/0.2` as an unsupported type and
 *  the wallet proves at 0.1, which delegates nothing. */
export type OobVersion = "0.1" | "0.2";

/** Families a wallet never delegates signing for, whatever a service offers
 *  (auth/oob/grant/0.2, wallet item 5): signing in, access control, consent. */
export const UNDELEGABLE_FAMILIES = ["auth", "acl", "consent", "task-consent", "confirm"] as const;

/** A task-family slug prefix, as `SigningScope` admits one. */
const FAMILY = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;

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
  /** Integer epoch seconds (contract C9). */
  decisionDeadline: number;
  /** Framework extension member. A VTC puts the session audience here
   *  ([`OOB_SESSION_EXT`]); anything else is carried unread. */
  ext?: Record<string, unknown>;
}

/** The `ext` namespace in which a VTC says which session a sign-in asks for.
 *  `auth/oob/0.1`'s `purpose` is a closed enum (`login`), so the operator
 *  console's sign-in is told apart here instead. The VTC signs it into step 1
 *  and repeats it in step 2, so the grant's `contextDigest` covers it. */
export const OOB_SESSION_EXT = "org.openvtc.session";

/** Which session the website asked for: the community's member portal, or
 *  its operator console. */
export type OobSessionAudience = "member" | "admin";

/** The audience a step 1 or step 2 names. No extension is `member` — what
 *  every VTC that predates it sends. `undefined` when the extension is there
 *  but names something this wallet does not know. */
export function sessionAudienceOf(step: { ext?: unknown }): OobSessionAudience | undefined {
  const ext = step.ext;
  if (ext === undefined || ext === null) return "member";
  if (typeof ext !== "object") return undefined;
  const ns = (ext as Record<string, unknown>)[OOB_SESSION_EXT];
  if (ns === undefined) return "member";
  const audience = (ns as { audience?: unknown } | null)?.audience;
  return audience === "member" || audience === "admin" ? audience : undefined;
}

/** Whether the browser that asked is on the network the approver is on
 *  (base design §10, contract C9). TODO: replace with generated trust-tasks
 *  types. */
export type OobSameNetwork = boolean | "unknown";

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
  /** 0.2: the task families the service would let the browser key sign as
   *  the member, for this session. Absent: no signing is delegated. */
  signingScope?: string[];
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
  /** Integer epoch seconds (contract C9). */
  notAfter: number;
  /** 0.2: step 2's `signingScope`, copied unchanged. */
  signingScope?: string[];
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
  /** The URL documents are POSTed to: the first usable `TrustTaskHTTPS`
   *  service's endpoint is a Trust-Task **base**, and this is
   *  `<base>/trust-tasks` (HTTPS binding 0.2 §6), composed by `trustTaskUrl`
   *  exactly as the VTA calls compose theirs. */
  trustTaskEndpoint: string;
}

export type SignInServicesResult =
  | { ok: true; services: SignInServices }
  | {
      ok: false;
      reason: TriggerLinkReason;
      /** The service type that was missing or unusable: `SignInPortal` with
       *  `no-portal-service`, `TrustTaskHTTPS` with `no-common-transport`. */
      service: typeof SIGN_IN_PORTAL_SERVICE_TYPE | typeof TRUST_TASK_HTTPS_SERVICE_TYPE;
      /** The document lists a service of that type, but none with a usable
       *  endpoint (an `https` URL with no port or credentials, whose host
       *  meets the host rules). Absent: it lists none at all. */
      unusable?: true;
    };

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

/** An `https` URL whose host meets the host rules (VTI-LNK-053 / 060), with
 *  the string as published. */
function usableHttpsEndpoint(raw: unknown): { url: URL; text: string } | undefined {
  const text = endpointString(raw);
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  return meetsHostRules(url.hostname) ? { url, text } : undefined;
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
 *
 * A refusal names the service type, and whether one was listed with an
 * unusable endpoint, so the window's "Details" can tell an operator what to
 * fix. Neither comes from the link.
 */
export function selectSignInServices(doc: unknown): SignInServicesResult {
  const services = Array.isArray((doc as { service?: unknown })?.service)
    ? ((doc as { service: unknown[] }).service as DidService[])
    : [];
  let portal: URL | undefined;
  let endpoint: string | undefined;
  let portalListed = false;
  let endpointListed = false;
  for (const s of services) {
    if (!s || typeof s !== "object") continue;
    if (hasType(s, SIGN_IN_PORTAL_SERVICE_TYPE)) portalListed = true;
    if (hasType(s, TRUST_TASK_HTTPS_SERVICE_TYPE)) endpointListed = true;
    if (!portal && hasType(s, SIGN_IN_PORTAL_SERVICE_TYPE)) portal = usableHttpsEndpoint(s.serviceEndpoint)?.url;
    // The published endpoint is the Trust-Task base; the POST URL is
    // `<base>/trust-tasks` (binding 0.2 §6), composed the one way the rest of
    // this library composes it (a trailing `/` on the base is dropped).
    if (!endpoint && hasType(s, TRUST_TASK_HTTPS_SERVICE_TYPE)) {
      const base = usableHttpsEndpoint(s.serviceEndpoint)?.text;
      if (base !== undefined) endpoint = trustTaskUrl(base);
    }
  }
  if (!portal) {
    return {
      ok: false,
      reason: "no-portal-service",
      service: SIGN_IN_PORTAL_SERVICE_TYPE,
      ...(portalListed ? { unusable: true as const } : {}),
    };
  }
  if (!endpoint) {
    return {
      ok: false,
      reason: "no-common-transport",
      service: TRUST_TASK_HTTPS_SERVICE_TYPE,
      ...(endpointListed ? { unusable: true as const } : {}),
    };
  }
  return { ok: true, services: { portalOrigin: portal.origin, trustTaskEndpoint: endpoint } };
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
  /** The reader's contact methods. Defaults to {@link CONTACT_METHODS}. */
  contactMethods?: ContactMethodRegistry;
}

/**
 * Resolve and verify the community's DID document, afresh (VTI-LNK-052/053),
 * through its registered contact method. For `did:webvh` the resolver walks
 * and verifies the log. A host-named contact's host must meet the host rules —
 * which is where `did:web:example.com%3A8443` is refused. A method with no
 * registered resolver is `unsupported-vid`; any other failure is
 * `did-document-unverified`, and nothing is sent.
 *
 * `route` says how the contact qualifies: a `domain-linked` one still needs
 * {@link verifyDomainLinkage} after the person continues.
 */
export async function resolveCommunityDocument(
  did: string,
  opts: ResolveCommunityOptions = {},
): Promise<
  { ok: true; doc: Record<string, unknown>; route: ContactRoute } | { ok: false; reason: TriggerLinkReason }
> {
  return resolveContactDocument(did, {
    ...(opts.resolveDid ? { resolveDid: opts.resolveDid } : {}),
    ...(opts.contactMethods ? { methods: opts.contactMethods } : {}),
  });
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

/** `auth/oob/prove`. Carries the handle as `parentThreadId` as well (C9:
 *  SHOULD). */
export function buildProve(
  kA: SigningIdentity,
  vtcDid: string,
  identify: OobDocument,
  requestId: string,
  version: OobVersion = "0.1",
): OobDocument<{ identify: OobDocument }> {
  const type = version === "0.2" ? OOB_TYPES.prove02 : OOB_TYPES.prove;
  return { ...envelope(type, kA.did, vtcDid, { identify }), parentThreadId: requestId };
}

/** `auth/oob/grant`, unsigned. The VTA signs it (for `assertionMethod`) only
 *  with the device's user-verification decision over its digest (C6). */
export function buildGrant(
  memberDid: string,
  vtcDid: string,
  payload: OobGrantPayload,
  version: OobVersion = "0.1",
): OobDocument<OobGrantPayload> {
  if (version === "0.1" && payload.signingScope !== undefined) {
    throw new OobReplyInvalidError("a 0.1 grant cannot delegate signing");
  }
  return envelope(version === "0.2" ? OOB_TYPES.grant02 : OOB_TYPES.grant, memberDid, vtcDid, payload);
}

/** `auth/oob/respond`. Carries the handle as `parentThreadId` as well (C9:
 *  SHOULD). */
export function buildRespond(
  kA: SigningIdentity,
  vtcDid: string,
  grant: OobDocument,
  requestId: string,
  version: OobVersion = "0.1",
): OobDocument<{ grant: OobDocument }> {
  const type = version === "0.2" ? OOB_TYPES.respond02 : OOB_TYPES.respond;
  return { ...envelope(type, kA.did, vtcDid, { grant }), parentThreadId: requestId };
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
 * SHA-256 of the JCS form of a document, as a sha2-256 multihash in base58btc
 * multibase (`z…`) — the encoding contract C9 fixes for `contextDigest`, and
 * the one `task-consent`'s `payloadDigest` uses. The grant digest the
 * user-verification decision covers uses the same form; its exact definition
 * is the VTA's (see `vault/sign-oob.ts`).
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
  /** The POST URL, `<TrustTaskHTTPS base>/trust-tasks` (binding 0.2 §6), as
   *  `selectSignInServices` composes it. */
  trustTaskEndpoint: string;
  fetch?: typeof fetch;
}

export interface OobReply<P> {
  doc: OobDocument<P>;
  payload: P;
}

/**
 * Sign `doc` with `K_a` (an operational proof, `authentication`), post it to
 * the community's Trust-Task endpoint, and return its reply once it checks
 * out: signed by the community for `replyPurpose` (`assertionMethod`, the
 * `auth/oob` steps' default, contract C5) with a key its verified document
 * lists under that relationship, threaded to this request, and addressed back
 * to `K_a`. A refusal throws {@link OobRefusedError}.
 */
export async function sendOob<P>(
  kA: SigningIdentity,
  doc: OobDocument,
  opts: OobSenderOptions,
  label: string,
  replyPurpose: "authentication" | "assertionMethod" = "assertionMethod",
): Promise<OobReply<P>> {
  if (doc.issuer !== kA.did || doc.recipient !== opts.vtcDid) {
    throw new OobReplyInvalidError(`${label}: the document is not from K_a to the community`);
  }
  await signTrustTask({
    envelope: doc as unknown as Record<string, unknown>,
    signing: kA,
    proofPurpose: "authentication",
  });
  return postCommunityTask<P>(doc, opts, label, replyPurpose);
}

/**
 * Post an already-signed document to the community's Trust-Task endpoint and
 * return its reply once it checks out: of the response type, threaded to this
 * document, addressed back to its issuer (when addressed at all), and signed by
 * the community for `replyPurpose` with a key its verified document lists under
 * that relationship. A refusal throws {@link OobRefusedError}; a reply that
 * does not check out, {@link OobReplyInvalidError}.
 *
 * The `auth/oob` steps are attested (`assertionMethod`, contract C5); every
 * other VTC response — the join requests' among them — is operational and
 * signed for `authentication` (VTI-KEY-106).
 */
export async function postCommunityTask<P>(
  doc: OobDocument,
  opts: OobSenderOptions,
  label: string,
  replyPurpose: "authentication" | "assertionMethod",
): Promise<OobReply<P>> {
  if (doc.recipient !== opts.vtcDid) {
    throw new OobReplyInvalidError(`${label}: the document is not addressed to the community`);
  }
  const fetchFn = withFetchTimeout(opts.fetch);
  let res: Response;
  try {
    res = await fetchFn(opts.trustTaskEndpoint, {
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
  if (reply.recipient !== undefined && reply.recipient !== doc.issuer) {
    throw new OobReplyInvalidError(`${label}: the reply is addressed to someone else`);
  }
  await assertSignedByCommunity(reply, opts.vtcDid, opts.vtcDocument, label, replyPurpose);
  return { doc: reply, payload: reply.payload };
}

/** The community's signature over a reply: `assertionMethod` for the
 *  `auth/oob` steps (contract C5), `authentication` for an operational one. */
export async function assertSignedByCommunity(
  reply: OobDocument,
  vtcDid: string,
  vtcDocument: Record<string, unknown>,
  label: string,
  purpose: "authentication" | "assertionMethod" = "assertionMethod",
): Promise<void> {
  const result = await verifyTrustTaskProof(reply as unknown as Record<string, unknown>, {
    expectedProofPurpose: purpose,
    resolveDid: async (did) => {
      if (did !== vtcDid) throw new Error(`reply signed by ${did}, not the community`);
      return vtcDocument;
    },
  });
  if (!result.verified || result.signer !== vtcDid) {
    throw new OobReplyInvalidError(`${label}: the reply is not signed by the community (${result.reason ?? "wrong signer"})`);
  }
  const vm = (reply.proof as { verificationMethod?: string }).verificationMethod!;
  const relationship = vtcDocument[purpose];
  const listed = Array.isArray(relationship) ? relationship : [];
  const fragment = vm.slice(vm.indexOf("#"));
  const ok = listed.some((m) => {
    const id = typeof m === "string" ? m : (m as { id?: unknown })?.id;
    return typeof id === "string" && (id === vm || id === fragment);
  });
  if (!ok) throw new OobReplyInvalidError(`${label}: the signing key is not one of the community's ${purpose} keys`);
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
  if (sessionAudienceOf(step1) === undefined) bad("a session this wallet does not know");
  const deadline = deadlineMs(step1.decisionDeadline);
  if (deadline === undefined) bad("no decision deadline");
  if (deadline! <= want.now) bad("the decision deadline has passed");
  return step1;
}

/** A deadline as epoch milliseconds. Contract C9: integer epoch seconds
 *  only; anything else (RFC 3339 included) is `undefined`. */
export function deadlineMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value * 1000 : undefined;
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
  // The audience the member approves is step 2's (the grant's
  // `contextDigest` covers it); it must be the one step 1 showed.
  if (sessionAudienceOf(step2) !== sessionAudienceOf(step1)) bad("it names a different session than step 1");
  if (typeof step2.sessionKey !== "string" || !/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/.test(step2.sessionKey)) {
    bad("the session key is not an Ed25519 did:key");
  }
  if (step2.identifiedAs !== memberDid) bad("a different identity");
  if (step2.signingScope !== undefined) {
    const scope = step2.signingScope;
    if (!Array.isArray(scope) || scope.length === 0 || scope.length > 8 || new Set(scope).size !== scope.length) bad("a malformed signing scope");
    for (const f of scope) {
      if (typeof f !== "string" || !FAMILY.test(f)) bad("a malformed signing scope");
      // Wallet item 5: never, whatever the service offers.
      if (UNDELEGABLE_FAMILIES.some((x) => f === x || f.startsWith(`${x}/`))) {
        bad(`it asks to let the browser sign ${f} documents as you, which a wallet never delegates`);
      }
    }
  }
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
  if (sameNetwork === true) return "same";
  if (sameNetwork === false) return "different";
  return "unknown";
}
