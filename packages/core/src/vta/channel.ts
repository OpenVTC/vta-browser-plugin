// Layer 1 — the transport-agnostic Trust-Task channel.
//
// One interface that TSP, DIDComm, and REST each implement. Callers (domain
// ops like vault/list, acl/swap-key, passkey enroll) build a canonical
// request with `buildTrustTask` and hand it to a channel's `send`; the
// channel owns auth, wire framing, reply correlation, and normalizing errors
// to `VtaClientError` — then decodes the reply with `parseTrustTaskReply`.
//
// A VtaSession (Layer 3) resolves a VTA's advertised transports and builds an
// ordered channel chain (priority TSP > DIDComm > REST), degrading to the next
// channel when one reports a task type it can't route (`supports` / an
// `e.client.unsupported` throw). Domain ops never see the transport.

import type { TrustTask } from "./protocol.js";

export type TrustTaskChannelKind = "tsp" | "didcomm" | "rest";

export interface SendOpts {
  /** Expected response document `type` (the `<request>#response` URI). When
   *  set, a reply whose `type` is neither this nor a trust-task-error is a
   *  protocol error. Omit to accept any non-error response type. */
  expectedResponseType?: string;
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /** Label used to enrich error messages (defaults to the task type). */
  operationLabel?: string;
}

/**
 * A transport over which Trust-Task request/response exchanges run. The
 * request is always a canonical {@link TrustTask} envelope; the channel
 * returns the decoded response payload, or throws a `VtaClientError`.
 */
export interface TrustTaskChannel {
  /** Which transport this is — for selection, logging, and diagnostics. */
  readonly kind: TrustTaskChannelKind;

  /**
   * Deliver an authenticated Trust-Task request and return its response
   * payload. Throws a `VtaClientError` on transport failure, a
   * `trust-task-error` reply, or an unexpected response type.
   */
  send<Res>(envelope: TrustTask<unknown>, opts?: SendOpts): Promise<Res>;

  /**
   * Whether this VTA routes `taskType` over this channel. Drives the session's
   * fallback chain: a channel that returns `false` is skipped for that task.
   * Optional — when absent, the session assumes the channel supports every
   * task and relies on an `e.client.unsupported` throw to trigger fallback.
   */
  supports?(taskType: string): boolean;

  /** Release any live transport (mediator pickup socket, TSP session). REST is
   *  stateless and omits this. */
  close?(): Promise<void>;
}
