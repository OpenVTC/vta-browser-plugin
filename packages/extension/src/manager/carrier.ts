// What crosses the bridge when the console runs an admin task — and what does
// not.
//
// Every helper in `@openvtc/pnm-core/admin` builds a canonical envelope with
// `buildTrustTask` and hands it to a `TrustTaskSender`. That gives the console
// the API it wants: typed payloads and responses, with the wire shapes owned by
// the generated `@openvtc/trust-tasks` bindings rather than transcribed here.
//
// But `core/src/vta/request-task.ts` is explicit that **the device mints the
// envelope**. A wallet that counter-signs a document composed somewhere else
// attests to every field the agent will subsequently trust *because the wallet
// signed it* — issuer, recipient, expiry, id — none of which it checked. That
// rule does not soften because the composer happens to be an extension page:
// what the signature claims is the same either way.
//
// So the envelope the admin helper builds is a **carrier**, not a document.
// `carrierParams` takes the only two members a caller is entitled to propose
// and drops the rest; the offscreen document mints the real envelope and the
// channel signs it (`signOutboundTask`, SPEC §7.2 item 7a).
//
// Deliberately free of relative imports so it can be unit-tested in plain Node
// — the same constraint every other tested module in this package observes, and
// the reason the chrome-facing half lives in `sender.ts`.

import type { TrustTask } from "@openvtc/pnm-core";

/** The two members that may travel. Mirrors `RequestTaskParams`. */
export interface CarrierParams {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Strip a carrier envelope down to what may cross the bridge.
 *
 * An absent payload becomes `{}` rather than `undefined`: `auth/whoami` and
 * friends legitimately send an empty payload, and relaying `undefined` reaches
 * the agent as a missing member that fails schema validation for no visible
 * reason.
 */
export function carrierParams(envelope: TrustTask<unknown>): CarrierParams {
  return {
    type: envelope.type,
    payload: (envelope.payload ?? {}) as Record<string, unknown>,
  };
}

/**
 * The agent will not run this task until a human approves it.
 *
 * **Not a failure, and it must never be rendered as one.** The refusal carries
 * the executor-signed consent requests an approver has to see and the salted
 * digest whose prefix the operator matches on their approving device. A console
 * that printed "Error: consent required" would discard the informed-consent
 * ceremony at the exact moment the human was supposed to act.
 *
 * `TrustTaskSender.send` returns a value or throws, so this arrives as a
 * *typed* throw. The panes catch this class specifically; nothing else in the
 * console is allowed to catch it.
 */
export class ConsentRequiredError extends Error {
  /** Salted digest of the exact payload awaiting approval; a prefix is the
   *  cross-device match code. */
  readonly payloadDigest: string;
  readonly challenge: string;
  readonly approverSet: string;
  readonly minApprovals: number;
  /** Executor-signed `task-consent/request` documents, one per approver. */
  readonly consentRequests: unknown[];
  /** Task type the operator was attempting, for the ceremony's copy. */
  readonly taskType: string;

  constructor(taskType: string, outcome: Record<string, unknown>) {
    super(`${taskType} needs human approval before the agent will run it`);
    this.name = "ConsentRequiredError";
    this.taskType = taskType;
    this.payloadDigest = typeof outcome.payloadDigest === "string" ? outcome.payloadDigest : "";
    this.challenge = typeof outcome.challenge === "string" ? outcome.challenge : "";
    this.approverSet = typeof outcome.approverSet === "string" ? outcome.approverSet : "";
    this.minApprovals = typeof outcome.minApprovals === "number" ? outcome.minApprovals : 1;
    this.consentRequests = Array.isArray(outcome.consentRequests) ? outcome.consentRequests : [];
  }
}

/**
 * The task failed, and here is the machine-readable reason.
 *
 * The sibling of {@link ConsentRequiredError}, and for the same reason: a pane
 * that can only catch `Error` can only print a sentence. Before this class the
 * relay collapsed every rejection to prose — `${label} failed: ${message}` —
 * so a pane wanting to behave differently for one particular refusal had to
 * match on the message text, which R3.7 forbids: the agent may reword a message
 * whenever it likes and may not change a code.
 *
 * `code` and `details` are both optional and usually absent. Most failures are
 * a dead connection or a timeout, and a pane that assumed a code would find
 * `undefined` — so the shape a pane should write is "switch on the code when
 * there is one, render {@link Error.message} either way". The message is
 * unchanged from what the bare `Error` carried, so nothing that already renders
 * it needs touching.
 *
 * Deliberately NOT thrown for a `consentRequired` outcome. That is not a
 * failure at all; it is a ceremony, and it keeps its own class.
 */
export class RelayTaskError extends Error {
  /**
   * The agent's own stable code, when it sent one — a SPEC §8.3 standard code
   * (`permissionDenied`) or a §8.5 extended one
   * (`persona/profile/delete:profileInUse`) — or the client's `VtaErrorCode`
   * (`e.client.timeout`) when the failure never reached the agent. Compare with
   * `===`; never parse it.
   */
  readonly code?: string;
  /** The agent's structured context for this refusal, e.g. the `personaDids`
   *  blocking a profile deletion. Plain JSON — the relay round-trips it — so a
   *  pane may read members off it, but it is unvalidated wire data and every
   *  member has to be checked before it is used. */
  readonly details?: unknown;
  /** The task type the operator was attempting. */
  readonly taskType: string;

  constructor(taskType: string, message: string, failure: RelayFailureFields) {
    super(message);
    this.name = "RelayTaskError";
    this.taskType = taskType;
    if (failure.code !== undefined) this.code = failure.code;
    if (failure.details !== undefined) this.details = failure.details;
  }
}

/** The machine-readable half of a failed reply. Mirrors `RelayTaskFailure` in
 *  `bridge-protocol.ts`. */
export interface RelayFailureFields {
  code?: string;
  details?: unknown;
}

/** The bridge's reply, structurally. Kept here rather than imported so this
 *  module stays free of relative imports; `sender.ts` passes the real typed
 *  value, and a drift between the two breaks its build. */
export interface RelayReply extends RelayFailureFields {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

/**
 * Turn the bridge's reply into a result, or throw the right kind of error.
 *
 * Three outcomes, and the middle one is the reason this is a function rather
 * than an `if (!ok) throw`: `accepted` unwraps, `consentRequired` throws the
 * typed ceremony, and anything else means the relay changed shape underneath
 * this file. That last case must be loud — returning it would hand a pane an
 * object whose members all read `undefined`, which renders as a convincing
 * empty result.
 *
 * A refused reply is the fourth, and it throws {@link RelayTaskError} carrying
 * whatever machine-readable code and structured details survived the bridge.
 */
export function interpretOutcome<Res>(
  taskType: string,
  label: string,
  reply: RelayReply,
): Res {
  if (!reply.ok) {
    // Typed, and carrying whatever the agent said. The prose is byte-identical
    // to what the bare `Error` produced — a pane that renders `.message` sees
    // no change — but a pane that wants to *act* on one refusal now has a code
    // to compare instead of a sentence to match (R3.7).
    throw new RelayTaskError(taskType, `${label} failed: ${reply.error ?? "unknown error"}`, reply);
  }

  const outcome = reply.result;
  if (outcome?.kind === "consentRequired") {
    throw new ConsentRequiredError(taskType, outcome);
  }
  if (outcome?.kind !== "accepted") {
    throw new Error(
      `${label} returned an outcome this console does not understand ` +
        `(kind=${String(outcome?.kind)}). The wallet and console builds may differ.`,
    );
  }
  return outcome.result as Res;
}
