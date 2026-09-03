// VTA→approver task-execution consent, per the published
// `task-consent/{request,decision}/0.1` Trust-Task specs.
//
// The user's own VTA asks this device to authorize one privileged task before it
// runs. The device renders what the VTA says the task will do, the human decides,
// and the device signs a decision the VTA consumes.
//
// ## Why this is not `confirm/*`
//
// The superficially similar `confirm/request` (retired ecosystem-wide; the
// registry marks it supersededBy task-consent) carried an
// **RP-authored `reason` shown to the user verbatim**, and that was correct there:
// in `confirm/*` the relying party holds the authority and is merely asking a
// human to vouch for something it will then do itself. The RP is the executing
// party, so RP-authored prose is prose from the party who will act.
//
// Task consent inverts that. Here the **VTA** holds the authority and will do the
// executing, and the requester is the least-trusted component in the system. If
// the requester could author what the human reads, it would be writing the basis
// of a decision that authorizes it — while every signature still verified. So:
//
//   **This module renders only content it has verified came from an executor
//   this device is enrolled with.** A request whose proof does not verify, or
//   which was signed by anyone outside the enrolled-executor set — the user's
//   own VTA(s) plus any other executors the operator has enrolled (e.g. a
//   DID-hosting control plane that signs task-consent requests) — MUST NOT
//   reach a human.
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
import {
  TRUST_TASK_ENVELOPE_TYPE,
  isTrustTaskErrorType,
  type TrustTask,
  type TrustTaskErrorPayload,
} from "../vta/protocol.js";
import { signTrustTask } from "../trust-tasks/sign.js";
import { verifyTrustTaskProof } from "../trust-tasks/verify.js";
import {
  describeViolations,
  validateAgainstSchema,
  type PayloadValidator,
} from "../trust-tasks/validate.js";

import {
  PAYLOAD_SCHEMA,
  TYPE_URI as TASK_CONSENT_REQUEST_TYPE_URI,
  type Exposure,
  type StatePin,
} from "@openvtc/trust-tasks/task-consent/request/0.1/payload";
import {
  RESPONSE_PAYLOAD_SCHEMA as DECISION_RESPONSE_SCHEMA,
  TYPE_URI as TASK_CONSENT_DECISION_TYPE_URI,
} from "@openvtc/trust-tasks/task-consent/decision/0.1/payload";
import { TYPE_URI as TASK_CONSENT_GRANTED_TYPE_URI } from "@openvtc/trust-tasks/task-consent/granted/0.1/payload";
import type { SigningIdentity } from "../siop/self-issued.js";

export const TASK_CONSENT_REQUEST_TYPE = TASK_CONSENT_REQUEST_TYPE_URI;
export const TASK_CONSENT_DECISION_TYPE = TASK_CONSENT_DECISION_TYPE_URI;
/** VTA → requester: an approval landed and a grant is ready — re-submit now. */
export const TASK_CONSENT_GRANTED_TYPE = TASK_CONSENT_GRANTED_TYPE_URI;
/** The executor's acknowledgement of a decision this device sent. */
export const TASK_CONSENT_DECISION_RESPONSE_TYPE = `${TASK_CONSENT_DECISION_TYPE}#response`;

/**
 * What the executor did with a decision this device sent.
 *
 * `accepted: false` is the case that matters. A refusal means a human was
 * shown a change, agreed to it, and the agreement did not take — which is
 * strictly worse than a prompt that never arrived, because the person believes
 * they have acted. It has to reach them.
 */
export type TaskConsentOutcome =
  | {
      accepted: true;
      /** `granted` = threshold met, the requester can execute. `pending` =
       *  recorded, more approvals needed. `denied` = the request was aborted,
       *  which is a successful *outcome* of a `deny`, not a failure. */
      status: string;
      approvals?: number;
      needed?: number;
      payloadDigest?: string;
      /** The decision document id this answers, when the reply carried one. */
      thid?: string;
    }
  | {
      accepted: false;
      /** Framework status code — snake_case in error/0.1, lowerCamelCase in
       *  0.2. Opaque: log it, don't branch on a casing. */
      code: string;
      message?: string;
      retryable: boolean;
      details?: unknown;
      thid?: string;
    };

/**
 * Parse the executor's reply to a `task-consent/decision` this device sent.
 *
 * Returns `null` for anything that is not such a reply — that is the only case
 * a caller may ignore.
 *
 * ## Why this exists
 *
 * The executor answers a decision on the same DIDComm thread, as a Trust-Task
 * envelope: a `decision/0.1#response` document on success, a
 * `trust-task-error/0.x` on refusal. Nothing here recognised either, so
 * both fell through the inbound handler's final "anything else is ignored"
 * branch — no log, no surface, nothing.
 *
 * That is how an approval refused by the VTA looked identical, from this side,
 * to one that was delivered and worked: the human approved, the wallet sent,
 * the executor replied "no", and the wallet discarded the reply. The operator
 * then watched the requester re-submit forever with no clue which end was at
 * fault. Reading the answer is the difference between a two-minute diagnosis
 * and an afternoon of packet-staring.
 *
 * ## What is trusted
 *
 * Only the authcrypt sender, and only to decide whether to *believe* the
 * reply — it is diagnostic, and grants nothing. A reply whose sender is not an
 * enrolled executor is dropped: an unauthenticated party must not be able to
 * tell this device that its approval failed (a lie that invites the human to
 * approve a second time), nor that it succeeded.
 */
export function parseTaskConsentOutcome(
  message: Record<string, unknown>,
  opts: { enrolledExecutorDids: readonly string[] },
): TaskConsentOutcome | null {
  if (message.type !== TRUST_TASK_ENVELOPE_TYPE) return null;

  // A missing `from` means the transport could not authenticate the sender.
  // Unlike the `granted` nudge — which is cross-checked against a digest the
  // page already holds — nothing downstream re-verifies this, so an
  // unattributable reply is dropped rather than believed.
  const from = typeof message.from === "string" ? message.from : null;
  if (!from || !opts.enrolledExecutorDids.includes(from)) return null;

  const doc = (message.body ?? {}) as Partial<TrustTask<Record<string, unknown>>>;
  const thid =
    (typeof message.thid === "string" ? message.thid : undefined) ??
    (typeof doc.threadId === "string" ? doc.threadId : undefined);

  if (isTrustTaskErrorType(doc.type)) {
    // **Deliberately not schema-validated.** This branch carries the executor
    // refusing an approval a human already gave, and the one thing that must
    // not happen is failing to tell them. Refusing a malformed error document
    // would drop that notification for a defect in the *refusal*, which is
    // strictly worse than reporting a refusal whose members are read
    // defensively — as they are, member by member, below.
    const payload = (doc.payload ?? {}) as Partial<TrustTaskErrorPayload>;
    return {
      accepted: false,
      code: typeof payload.code === "string" ? payload.code : "unknown",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
      // The framework schema requires `retryable`; treat a missing one as
      // "don't retry" rather than inventing optimism about a refusal.
      retryable: payload.retryable === true,
      ...(payload.details !== undefined ? { details: payload.details } : {}),
      ...(thid ? { thid } : {}),
    };
  }

  if (doc.type === TASK_CONSENT_DECISION_RESPONSE_TYPE) {
    // Validated, unlike the error branch above. `status` is an enum of
    // `granted | pending | denied` and `payloadDigest` is a REQUIRED
    // `DigestMultibase`, and the hand-read below would have passed any string
    // through for the first and silently omitted the second. Nothing branches
    // on `status` today — it is reported, not acted on — so this is not the
    // fail-open the request path had. It is here because "the executor said
    // *granted*" is a claim worth being able to trust when something does
    // start branching on it.
    const check = validateAgainstSchema(DECISION_RESPONSE_SCHEMA, doc.payload);
    if (!check.valid) {
      return {
        accepted: false,
        code: "malformedRequest",
        message:
          `the executor's decision response does not satisfy ` +
          `${TASK_CONSENT_DECISION_RESPONSE_TYPE} — ${describeViolations(check.violations)}`,
        retryable: false,
        ...(thid ? { thid } : {}),
      };
    }
    const payload = doc.payload as Record<string, unknown>;
    return {
      accepted: true,
      status: typeof payload.status === "string" ? payload.status : "unknown",
      ...(typeof payload.approvals === "number" ? { approvals: payload.approvals } : {}),
      ...(typeof payload.needed === "number" ? { needed: payload.needed } : {}),
      ...(typeof payload.payloadDigest === "string"
        ? { payloadDigest: payload.payloadDigest }
        : {}),
      ...(thid ? { thid } : {}),
    };
  }

  return null;
}

/**
 * Parse a VTA→requester `task-consent/granted` notice.
 *
 * The VTA sends a **full Trust Task document inside a DIDComm envelope**, the
 * same binding {@link parseTaskConsentRequest} reads: the DIDComm `type` is
 * {@link TRUST_TASK_ENVELOPE_TYPE}, `body` is the document, and the salted
 * `payloadDigest` the requester already holds sits in `body.payload`.
 *
 * It is a **non-load-bearing nudge**: it only tells the requester to re-submit
 * now instead of polling, and the single-use grant check on that re-submit is
 * the real gate — so this needs no Data-Integrity proof. We still accept it only
 * from this device's enrolled VTA (the authcrypt sender), and the page re-checks
 * the digest against its outstanding approval before acting.
 *
 * # It used to read the pre-spec shape
 *
 * This matched `message.type` against the *task* type and read
 * `message.body.payloadDigest` — the bare `{status, payloadDigest, taskType}`
 * body the VTA sent before the notice gained its envelope. Both are wrong
 * against the current wire, and either alone is fatal: the DIDComm `type` is the
 * envelope type, so the first check never matched and this returned `null` on
 * every notice ever sent.
 *
 * Nothing failed loudly. The requester's page listens for the resulting
 * `consentgranted` event to replay its pinned re-submit, and deliberately runs
 * no timer poll for re-submitting (a blind retry loop would reopen the wallet's
 * un-skippable confirm on every tick). So a dropped notice is indistinguishable
 * from an approver who has not answered yet: the page sat on "this will publish
 * automatically the moment you approve" until the operator pressed the manual
 * fallback button.
 *
 * The sibling request parser was migrated to the envelope; this was not. Build
 * fixtures at the shape the peer actually emits — the tests that covered this
 * asserted the pre-spec form, so they passed throughout.
 */
export function parseTaskConsentGranted(
  message: Record<string, unknown>,
  expectedVtaDid: string,
): { payloadDigest: string } | null {
  if (message.type !== TRUST_TASK_ENVELOPE_TYPE) return null;
  const from = typeof message.from === "string" ? message.from : null;
  // If the transport surfaced a sender, it must be our VTA; a missing sender
  // is tolerated (the page-side digest match is the ultimate guard).
  if (from && from !== expectedVtaDid) return null;
  const doc = (message.body ?? {}) as {
    type?: unknown;
    issuer?: unknown;
    payload?: { payloadDigest?: unknown };
  };
  if (doc.type !== TASK_CONSENT_GRANTED_TYPE) return null;
  // The in-band issuer gets the same treatment as the transport sender: checked
  // when present, tolerated when absent. The notice is unsigned by design, so
  // this is a cheap filter and not an authentication.
  if (typeof doc.issuer === "string" && doc.issuer !== expectedVtaDid) return null;
  const digest = doc.payload?.payloadDigest;
  return typeof digest === "string" ? { payloadDigest: digest } : null;
}

/** SPEC §7.3 item 13 — the integrity effect of executing the task. */
export type SideEffectLevel = "none" | "mutating" | "destructive";


/**
 * One consequence of executing the task, authored by the VTA by dry-running the
 * handler it is about to invoke.
 */
export type { Exposure, StatePin };

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
  /** The enrolled executor that signed it — verified, not merely claimed.
   *  Decisions are routed back to this DID (the issuer awaiting the answer),
   *  which for the classic flow is the device's own VTA. */
  executorDid: string;
  request: TaskConsentRequestPayload;
  thid: string;
}

export type TaskConsentRequestRejection =
  /** Not addressed to this handler at all — the ONLY reason a caller may
   *  ignore silently. Everything else claimed to be a consent request and
   *  failed, which a human is waiting on and must therefore be reported. */
  | "not-a-task-consent-request"
  /** It IS a consent request, but its payload is unusable. Distinct from the
   *  above because it used to share it, and callers key on that reason to
   *  decide whether to stay quiet: a malformed request was dropped in total
   *  silence — no prompt, no log, and the pending record cleared — which is
   *  indistinguishable from a message that never arrived. */
  | "malformed-payload"
  | "untrusted_issuer"
  | "expired"
  | "not_eligible";

export type ParseTaskConsentResult =
  | { ok: true; parsed: ParsedTaskConsentRequest }
  | { ok: false; reason: TaskConsentRequestRejection; detail?: string };

export interface ParseTaskConsentOptions {
  /** The executors this device is enrolled with: its own VTA DID(s), plus any
   *  additional executor DIDs the operator has enrolled (e.g. a DID-hosting
   *  control plane). A request signed by any DID outside this set is refused —
   *  it does not matter how well-formed it is. */
  enrolledExecutorDids: readonly string[];
  /** This device's holder DID: who the request must be addressed to, and who it
   *  would be approving as. */
  holderDid: string;
  /** Defaults to now. Injected for tests. */
  now?: Date;
  /**
   * SPEC §7.2 item 2, if you want a different one.
   *
   * Defaults to `validateAgainstSchema`. There is deliberately **no way to
   * switch validation off**: a consent surface that skipped it would be
   * rendering unchecked content to a human, and an option to do so is an
   * option somebody eventually sets. Substitute a validator, don't remove one.
   */
  validatePayload?: PayloadValidator;
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
  if (!verification.signer || !opts.enrolledExecutorDids.includes(verification.signer)) {
    return reject(
      "untrusted_issuer",
      `signed by ${verification.signer ?? "an unknown key"}, not an executor this device is enrolled with`,
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

  // ── The payload, against the schema the registry publishes ───────────────
  //
  // This replaced a hand-written block of `typeof` checks, and the difference
  // is not thoroughness — it is that the hand-written version asked weaker
  // questions than the schema does, in one place that mattered.
  // `typeof payload.sideEffects !== "string"` admits any string, while the
  // schema admits `none`, `mutating` or `destructive`; the consent surface
  // renders severity by comparing against those three and falls through to its
  // calmest styling for anything else. So a `sideEffects` the schema would have
  // refused reached a human as the *least* alarming thing the UI can draw.
  //
  // The same gap ran through the rest: `minApprovals` was checked as a
  // `number` where the schema says integer ≥ 1 (`0` means a threshold no
  // approval is needed to meet), `effects` as `Array.isArray` with no element
  // shape, `exposure` as any object at all, and `note` — bounded to 500 by
  // framework 0.5 §7.3 item 19 precisely so a consent surface is not handed
  // unbounded prose — was not checked at all. `additionalProperties: false`
  // went unenforced too, so a member the schema forbids arrived silently.
  //
  // Validating the published schema also keeps this correct for free when the
  // registry amends `0.1` in place, which it does: an errata-style bound or a
  // widened enum lands with the binding, not with an edit here.
  const validate = opts.validatePayload ?? validateAgainstSchema;
  const schemaCheck = validate(PAYLOAD_SCHEMA, doc.payload);
  if (!schemaCheck.valid) {
    return reject(
      "malformed-payload",
      `payload does not satisfy ${TASK_CONSENT_REQUEST_TYPE} — ${describeViolations(schemaCheck.violations)}`,
    );
  }
  // Sound because the schema declares every member below REQUIRED and typed,
  // and the check above is the published schema rather than a summary of it.
  const payload = doc.payload as TaskConsentRequestPayload;

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
      executorDid: verification.signer,
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

/** A `task-consent/decision` ready to send, and the id to recognise its
 *  answer by. */
export interface BuiltTaskConsentDecision {
  /** The packed, mediator-routed wire message. */
  packed: string;
  /** The decision document's id. The executor answers on this thread
   *  (`thid`), so a caller that keeps it can match the reply to the decision
   *  it sent — and therefore tell the human *which* approval was refused.
   *  Returned rather than left inside the opaque packed blob because the
   *  alternative is not correlating at all, which is where this started. */
  id: string;
}

/** Build the authcrypted, mediator-routed `task-consent/decision` wire message. */
export async function buildTaskConsentDecision(
  args: BuildTaskConsentDecisionArgs,
): Promise<BuiltTaskConsentDecision> {
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
  const packed = await packAuthcryptJson(forwardJson, args.holder, [
    { kid: args.mediator.keyAgreementKid, jwk: args.mediator.keyAgreementPublicJwk },
  ]);
  return { packed, id: document.id };
}
