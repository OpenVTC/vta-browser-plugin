// VTA→approver task-execution consent, per the published
// `task-consent/{request,decision}/0.1` Trust-Task specs.
//
// The user's own VTA asks this device to authorize one privileged task before it
// runs. The device renders what the VTA says the task will do, the human decides,
// and the device signs a decision the VTA consumes.
//
// ## Why this is not `confirm/*`
//
// The superficially similar `confirm/request` (see `./confirm.ts`) carries an
// **RP-authored `reason` shown to the user verbatim**, and that is correct there:
// in `confirm/*` the relying party holds the authority and is merely asking a
// human to vouch for something it will then do itself. The RP is the executing
// party, so RP-authored prose is prose from the party who will act.
//
// Task consent inverts that. Here the **VTA** holds the authority and will do the
// executing, and the requester is the least-trusted component in the system. If
// the requester could author what the human reads, it would be writing the basis
// of a decision that authorizes it — while every signature still verified. So:
//
//   **This module renders only content it has verified came from the user's own
//   VTA.** A request whose proof does not verify, or which was signed by anyone
//   other than the VTA this device is enrolled with, MUST NOT reach a human.
//
// ## Why the effects, and not the payload
//
// A payload says what was *asked for*. Only the code about to run knows what will
// *happen*, and it knows it only against state the requester cannot see: a
// `did:webvh` document update whose payload adds one service endpoint also
// rotates the DID's update key. That consequence lives in the handler's
// semantics, not the payload's shape, so no diff of the payload recovers it —
// which is why the VTA dry-runs the real handler and sends `effects`, and why a
// surface that rendered the payload instead would be confidently misinforming
// the person it was asking.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { TRUST_TASK_ENVELOPE_TYPE, type TrustTask } from "../vta/protocol.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import type { SigningIdentity } from "../siop/self-issued.js";

export const TASK_CONSENT_REQUEST_TYPE =
  "https://trusttasks.org/spec/task-consent/request/0.1";
export const TASK_CONSENT_DECISION_TYPE =
  "https://trusttasks.org/spec/task-consent/decision/0.1";
/** VTA → requester: an approval landed and a grant is ready — re-submit now. */
export const TASK_CONSENT_GRANTED_TYPE =
  "https://trusttasks.org/spec/task-consent/granted/0.1";

/**
 * Parse a VTA→requester `task-consent/granted` notice.
 *
 * The VTA sends it as a plaintext DIDComm message whose `type` is the granted
 * type and whose `body` carries the salted `payloadDigest` the requester already
 * holds. It is a **non-load-bearing nudge**: it only tells the requester to
 * re-submit now instead of polling, and the single-use grant check on that
 * re-submit is the real gate — so this needs no Data-Integrity proof. We still
 * accept it only from this device's enrolled VTA (the authcrypt sender), and the
 * page re-checks the digest against its outstanding approval before acting.
 */
export function parseTaskConsentGranted(
  message: Record<string, unknown>,
  expectedVtaDid: string,
): { payloadDigest: string } | null {
  if (message.type !== TASK_CONSENT_GRANTED_TYPE) return null;
  const from = typeof message.from === "string" ? message.from : null;
  // If the transport surfaced a sender, it must be our VTA; a missing sender
  // is tolerated (the page-side digest match is the ultimate guard).
  if (from && from !== expectedVtaDid) return null;
  const body = (message.body ?? {}) as { payloadDigest?: unknown };
  return typeof body.payloadDigest === "string"
    ? { payloadDigest: body.payloadDigest }
    : null;
}

/** SPEC §7.3 item 13 — the integrity effect of executing the task. */
export type SideEffectLevel = "none" | "mutating" | "destructive";

/** SPEC §7.3 item 14 — what leaves the executor, and whose authority is used. */
export interface Exposure {
  discloses: "none" | "metadata" | "secret";
  actsAsSubject: boolean;
}

/**
 * One consequence of executing the task, authored by the VTA by dry-running the
 * handler it is about to invoke.
 */
export interface ConsentEffect {
  /** Machine discriminator. The set is OPEN — handlers evolve faster than this
   *  type, so a surface MUST tolerate a kind it does not recognise. */
  kind: string;
  /** Human-facing sentence, authored by the VTA. The **only** member a surface is
   *  guaranteed able to render, and therefore the one it must always show. */
  summary: string;
  path?: string;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
}

/** The prior state the effects were computed against. */
export interface StatePin {
  resource: string;
  version: string;
}

/** Payload of an inbound `task-consent/request/0.1` (VTA → approver). */
export interface TaskConsentRequestPayload {
  /** ≥128-bit nonce. Echoed in the decision, and the salt in `payloadDigest`. */
  challenge: string;
  /** Type URI of the task awaiting approval. */
  taskType: string;
  /** Salted digest binding the approval to this exact payload. Echoed verbatim
   *  in the decision — never recomputed here, because this device does not hold
   *  the payload and must not accept one from anybody who offers it. */
  payloadDigest: string;
  /** Authoritative class, derived by the VTA from its compiled handler. */
  sideEffects: SideEffectLevel;
  exposure: Exposure;
  /** What executing the task will do. MAY be empty — see `consequences`. */
  effects: ConsentEffect[];
  /** The DID that submitted the task. */
  requester: string;
  approverSet: string;
  minApprovals: number;
  /** When true, `requester` may not approve — this device must refuse if it is
   *  the requester, rather than casting a vote that would be thrown away. */
  excludeRequester: boolean;
  expiresAt: string;
  subject?: string;
  /** Browser-attested origin of the page that proposed the task, if any. */
  origin?: string;
  statePin?: StatePin;
  /** The task specification's static fallback text, when the VTA has no dry-run
   *  for this handler. Per-task, not per-request. */
  consequences?: string[];
}

export interface ParsedTaskConsentRequest {
  /** The VTA that signed it — verified, not merely claimed. */
  vtaDid: string;
  request: TaskConsentRequestPayload;
  thid: string;
}

export type TaskConsentRequestRejection =
  | "not-a-task-consent-request"
  | "untrusted_issuer"
  | "expired"
  | "not_eligible";

export type ParseTaskConsentResult =
  | { ok: true; parsed: ParsedTaskConsentRequest }
  | { ok: false; reason: TaskConsentRequestRejection; detail?: string };

export interface ParseTaskConsentOptions {
  /** The VTA this device is enrolled with. A request signed by anyone else is
   *  refused — it does not matter how well-formed it is. */
  expectedVtaDid: string;
  /** This device's holder DID: who the request must be addressed to, and who it
   *  would be approving as. */
  holderDid: string;
  /** Defaults to now. Injected for tests. */
  now?: Date;
}

/**
 * Parse and **verify** an inbound `task-consent/request/0.1`.
 *
 * Every check here is a precondition for showing a human anything. A surface
 * that prompted first and verified later would already have handed an attacker
 * the thing they wanted: the user's attention, and a plausible story.
 */
export async function parseTaskConsentRequest(
  message: Record<string, unknown>,
  opts: ParseTaskConsentOptions,
): Promise<ParseTaskConsentResult> {
  const reject = (
    reason: TaskConsentRequestRejection,
    detail?: string,
  ): ParseTaskConsentResult => ({ ok: false, reason, ...(detail ? { detail } : {}) });

  if (message.type !== TRUST_TASK_ENVELOPE_TYPE) {
    return reject("not-a-task-consent-request");
  }
  const doc = (message.body ?? {}) as Partial<TrustTask<Partial<TaskConsentRequestPayload>>> & {
    proof?: unknown;
    recipient?: unknown;
  };
  if (doc.type !== TASK_CONSENT_REQUEST_TYPE) {
    return reject("not-a-task-consent-request");
  }

  // ── The proof, before anything else ──────────────────────────────────────
  //
  // The transport (an authcrypt from the sender) authenticates the hop. It does
  // not authenticate the *content*: a mediator, or anything else on the path,
  // delivers what it is given. The Data-Integrity proof is what ties these
  // effects to the VTA, and it is the reason a human may be shown them.
  const verification = await verifyTrustTaskProof(doc as Record<string, unknown>, {
    expectedProofPurpose: "assertionMethod",
  });
  if (!verification.verified) {
    return reject("untrusted_issuer", verification.reason ?? "proof did not verify");
  }
  if (verification.signer !== opts.expectedVtaDid) {
    return reject(
      "untrusted_issuer",
      `signed by ${verification.signer ?? "an unknown key"}, not this device's VTA`,
    );
  }
  // The in-band issuer must agree with the proven signer (SPEC §4.8.1).
  if (typeof doc.issuer === "string" && doc.issuer !== verification.signer) {
    return reject("untrusted_issuer", "issuer does not match the proven signer");
  }

  // Addressed to *this* device. A request addressed to another approver, replayed
  // here, is otherwise indistinguishable — and approving it would cast a vote the
  // VTA attributes to us.
  if (typeof doc.recipient === "string" && doc.recipient !== opts.holderDid) {
    return reject("untrusted_issuer", "request is addressed to another device");
  }

  const payload = (doc.payload ?? {}) as Partial<TaskConsentRequestPayload>;
  if (
    typeof payload.challenge !== "string" ||
    typeof payload.taskType !== "string" ||
    typeof payload.payloadDigest !== "string" ||
    typeof payload.sideEffects !== "string" ||
    typeof payload.requester !== "string" ||
    typeof payload.approverSet !== "string" ||
    typeof payload.expiresAt !== "string" ||
    typeof payload.minApprovals !== "number" ||
    typeof payload.excludeRequester !== "boolean" ||
    !Array.isArray(payload.effects) ||
    !payload.exposure ||
    typeof payload.exposure !== "object"
  ) {
    return reject("not-a-task-consent-request", "payload is missing required members");
  }

  const now = opts.now ?? new Date();
  const expiry = new Date(payload.expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry <= now) {
    return reject("expired", `request lapsed at ${payload.expiresAt}`);
  }

  // We are the requester and the policy excludes them. Refusing here is not
  // pedantry: the point of `excludeRequester` is that a single compromised device
  // must not be able to both propose and approve, so a device that finds itself on
  // both ends must decline rather than ask its user a question whose answer the
  // VTA would throw away.
  if (payload.excludeRequester && payload.requester === opts.holderDid) {
    return reject("not_eligible", "this device proposed the task and may not approve it");
  }

  const thid =
    (typeof message.thid === "string" ? message.thid : undefined) ??
    (typeof doc.id === "string" ? doc.id : undefined) ??
    (typeof message.id === "string" ? message.id : "");

  return {
    ok: true,
    parsed: {
      vtaDid: verification.signer,
      thid,
      request: payload as TaskConsentRequestPayload,
    },
  };
}

/**
 * What a consent surface should put in front of the human.
 *
 * `effects` when the VTA had a dry-run for the handler; the specification's
 * static `consequences` when it did not; and — when it has **neither** — an
 * explicit statement that the consequences could not be determined.
 *
 * That last case is the one worth being careful about. "No effects" and "effects
 * unknown" render identically if you let them, and the difference is the whole
 * decision: one means the task is inert, the other means nobody can tell you what
 * it does. A surface that silently showed an empty list would be presenting the
 * most dangerous case as the most reassuring one.
 */
export function describeEffects(request: TaskConsentRequestPayload): {
  lines: string[];
  determined: boolean;
} {
  if (request.effects.length > 0) {
    return { lines: request.effects.map((e) => e.summary), determined: true };
  }
  if (request.consequences && request.consequences.length > 0) {
    return { lines: [...request.consequences], determined: true };
  }
  return {
    lines: ["This agent could not determine what this task will do."],
    determined: false,
  };
}

export interface BuildTaskConsentDecisionArgs {
  holder: Identity;
  signing: SigningIdentity;
  vta: RemoteDidcommEndpoint;
  mediator: RemoteDidcommEndpoint;
  /** The human's actual answer. */
  decision: "approve" | "deny";
  /** Echoed verbatim from the verified request. */
  challenge: string;
  /** Echoed verbatim from the verified request. Never recomputed. */
  payloadDigest: string;
  reason?: string;
  thid: string;
}

export async function buildTaskConsentDecisionDocument(
  args: Pick<
    BuildTaskConsentDecisionArgs,
    "signing" | "decision" | "challenge" | "payloadDigest" | "reason" | "vta"
  >,
): Promise<TrustTask<Record<string, unknown>> & { proof?: unknown }> {
  const document = {
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: TASK_CONSENT_DECISION_TYPE,
    issuer: args.signing.did,
    recipient: args.vta.did,
    issuedAt: new Date().toISOString(),
    payload: {
      challenge: args.challenge,
      payloadDigest: args.payloadDigest,
      decision: args.decision,
      ...(args.reason ? { reason: args.reason } : {}),
    },
  } as TrustTask<Record<string, unknown>> & { proof?: unknown };

  // The proof IS the authorization: the VTA takes the approver's identity from
  // it and not from the session that carried it. A bearer token proves who
  // opened the channel, not who agreed.
  await signTrustTask({
    envelope: document as unknown as Record<string, unknown> & { proof?: unknown },
    signing: args.signing,
  });
  return document;
}

/** Build the authcrypted, mediator-routed `task-consent/decision` wire message. */
export async function buildTaskConsentDecision(
  args: BuildTaskConsentDecisionArgs,
): Promise<string> {
  const document = await buildTaskConsentDecisionDocument(args);

  const message = {
    id: document.id,
    type: TRUST_TASK_ENVELOPE_TYPE,
    from: args.holder.did,
    to: [args.vta.did],
    thid: args.thid,
    body: document,
  };

  const inner = await packAuthcrypt(message, args.holder, [
    { kid: args.vta.keyAgreementKid, jwk: args.vta.keyAgreementPublicJwk },
  ]);
  const forwardJson = wrapForward(args.vta.did, args.holder.did, args.mediator.did, inner);
  return packAuthcryptJson(forwardJson, args.holder, [
    { kid: args.mediator.keyAgreementKid, jwk: args.mediator.keyAgreementPublicJwk },
  ]);
}
