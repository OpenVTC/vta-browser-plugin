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
 * `@pnm/core`; the second is the next milestone (WebSocket mediator
 * pickup, etc.).
 *
 * Implementations are responsible for transmitting the packed
 * (anoncrypt'd, forward-wrapped) JWE bytes to the configured
 * mediator and awaiting a single reply DIDComm message bound for
 * the holder — returned to the caller as the raw JWE/JWS/plaintext
 * string.
 */
export interface DidcommMessageBridge {
  sendAndAwaitReply(
    /** Outer JWE (anoncrypt'd forward envelope) to push to the mediator. */
    outerPackedJwe: string,
    /** Expected `thid` of the reply, so the bridge can demultiplex. */
    expectThreadId: string,
    options?: { timeoutMs?: number },
  ): Promise<string>;
}
