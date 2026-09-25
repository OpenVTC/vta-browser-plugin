import type {
  EnrollmentChallengeResponse,
  EnrollmentSubmitRequest,
  EnrollmentSubmitResponse,
  PasskeyList,
} from "./types.js";

/**
 * Transport-neutral passkey-management surface. Both the REST
 * (`VtaClient`) and DIDComm (`DidcommVtaTransport`) implementations
 * satisfy this — callers depend on the interface and pick the
 * concrete transport based on what the VTA advertises.
 */
export interface VtaTransport {
  requestEnrollmentChallenge(did: string): Promise<EnrollmentChallengeResponse>;
  submitPasskeyEnrollment(req: EnrollmentSubmitRequest): Promise<EnrollmentSubmitResponse>;
  listPasskeys(did: string): Promise<PasskeyList>;
  removePasskey(did: string, fragment: string): Promise<void>;
}

/**
 * An inbound DIDComm message after the bridge has decrypted it. The
 * bridge owns unpacking — and, for the mediator-session bridge,
 * authentication: only successfully sender-authenticated authcrypt
 * frames are ever surfaced (anoncrypt frames are dropped). Callers
 * validate `type` / `thid` / `from` on this shape.
 */
export interface DidcommReply {
  type?: string;
  /** Reply's own message id. The bridge correlates a reply to its request by
   *  `thid ?? id` (a reply with no `thid` threads under its own `id`), so
   *  callers must validate correlation the same way — some VTAs/mediators omit
   *  `thid` and echo the request id as the reply `id`. */
  id?: string;
  thid?: string;
  from?: string;
  body?: unknown;
}

/**
 * Seam for the DIDComm transport's send/receive plumbing. Lets us
 * separate "build the right DIDComm message bytes" from "actually
 * push them through a mediator". The first concern lives in
 * `@openvtc/pnm-core`; the second is the bridge implementation.
 *
 * Implementations transmit packed JWE bytes to the configured
 * mediator and surface the **decrypted** reply. `sendAndAwaitReply`
 * registers a reply expectation by `thid`; `send` is fire-and-forget
 * for DIDComm notifications.
 */
/** Options for {@link DidcommMessageBridge.sendAndAwaitReply}. */
export interface SendAndAwaitReplyOptions {
  timeoutMs?: number;
  /**
   * The peer(s) whose reply this is: the DID (or DIDs) the reply's envelope
   * must authenticate as. **Required** — a thread id is the id of a message
   * this wallet sent through the mediator, not a secret, so a waiter that
   * accepted any sender on its thread could be answered by anyone. Name the
   * party the request was addressed to, plus the relaying mediator when a
   * refusal of the hop is an answer the caller handles.
   */
  from: string | readonly string[];
}

export interface DidcommMessageBridge {
  sendAndAwaitReply(
    /** Outer JWE (forward envelope) to push to the mediator. */
    outerPackedJwe: string,
    /** Expected `thid` of the reply, so the bridge can demultiplex. */
    expectThreadId: string,
    options: SendAndAwaitReplyOptions,
  ): Promise<DidcommReply>;

  /**
   * Fire-and-forget. The DIDComm protocol message in
   * `outerPackedJwe` is one-way (notification) — caller doesn't
   * expect a reply. Implementations resolve once the bytes are
   * handed off to the underlying transport; they do not track
   * delivery acknowledgement at this layer.
   */
  send(outerPackedJwe: string): Promise<void>;
}
