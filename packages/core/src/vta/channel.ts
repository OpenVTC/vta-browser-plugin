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

/**
 * The minimal "carry a Trust-Task and return its response" capability. Both a
 * single {@link TrustTaskChannel} and a multi-channel `VtaSession` satisfy it,
 * so domain ops depend on this and don't care whether they're handed one
 * transport or a fallback chain.
 */
export interface TrustTaskSender {
  send<Res>(envelope: TrustTask<unknown>, opts?: SendOpts): Promise<Res>;
}

/**
 * A party named on a Trust-Task envelope — the `issuer` or the `recipient`.
 *
 * Deliberately just the DID. Building an envelope needs nothing else: an
 * `Identity` carries key material and a `RemoteDidcommEndpoint` carries a
 * key-agreement JWK, and neither is read when the only question is "whose DID
 * goes in this field". Both structurally satisfy this, so a caller that holds
 * one passes it unchanged.
 *
 * Asking for more than this is not free. A surface typed on `Identity` can only
 * be called from somewhere holding a private key, which forces key material
 * into callers that compose documents without ever signing them — the
 * management console being the case in point: it builds admin tasks and hands
 * them to the device to mint and sign, and holds no key of its own. Typing the
 * envelope's parties by what they actually are keeps that possible.
 */
export interface TaskParty {
  did: string;
}

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
 * The "deliver a Trust-Task and do not wait for an answer" capability.
 *
 * Some tasks define no response document at all — the threaded steps of a
 * credential exchange, for instance. SPEC.md §8.6 reserves a courtesy
 * `trust-task-ok` for them, and is explicit that a producer MUST NOT rely on
 * receiving one and that its absence carries no information. Calling
 * {@link TrustTaskSender.send} for such a task waits for something the
 * counterparty is entitled never to send: at best a timeout reported as a
 * failure after the message was delivered perfectly.
 *
 * `notify` resolves when the message has been handed to the transport. That is
 * the only promise any of the three transports can honestly make, and it is
 * deliberately weaker than `send`'s: **delivery is not application-level
 * success**, and nothing here tells a caller the task was performed.
 */
export interface TrustTaskNotifier {
  notify(envelope: TrustTask<unknown>, opts?: NotifyOpts): Promise<void>;
}

export interface NotifyOpts {
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /** Label used to enrich error messages (defaults to the task type). */
  operationLabel?: string;
}

/**
 * A transport over which Trust-Task exchanges run. The request is always a
 * canonical {@link TrustTask} envelope; the channel returns the decoded
 * response payload, or throws a `VtaClientError`.
 *
 * A channel carries both capabilities. A *caller* should depend on the
 * narrower one it needs — {@link TrustTaskSender} for request/response,
 * {@link TrustTaskNotifier} for one-way — so what a function does to the
 * network is visible in its signature.
 */
export interface TrustTaskChannel extends TrustTaskSender, TrustTaskNotifier {
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
