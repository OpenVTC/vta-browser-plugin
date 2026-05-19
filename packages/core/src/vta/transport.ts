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
 * Seam for the DIDComm transport's send/receive plumbing. Lets us
 * separate "build the right DIDComm message bytes" from "actually
 * push them through a mediator". The first concern lives in
 * `@pnm/core`; the second is the WebSocket / HTTPS bridge
 * implementation.
 *
 * Implementations transmit packed JWE bytes to the configured
 * mediator. `sendAndAwaitReply` registers a reply expectation by
 * `thid`; `send` is fire-and-forget for DIDComm notifications
 * (e.g. `pickup/3.0/live-delivery-change`, `messages-received`).
 */
export interface DidcommMessageBridge {
  sendAndAwaitReply(
    /** Outer JWE (anoncrypt'd forward envelope) to push to the mediator. */
    outerPackedJwe: string,
    /** Expected `thid` of the reply, so the bridge can demultiplex. */
    expectThreadId: string,
    options?: { timeoutMs?: number },
  ): Promise<string>;

  /**
   * Fire-and-forget. The DIDComm protocol message in
   * `outerPackedJwe` is one-way (notification) — caller doesn't
   * expect a reply. Implementations resolve once the bytes are
   * handed off to the underlying transport; they do not track
   * delivery acknowledgement at this layer.
   */
  send(outerPackedJwe: string): Promise<void>;
}
