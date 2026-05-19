import type { PasskeyVerificationMethod } from "../did/verification-method.js";

/**
 * Wire types for VTA passkey-management operations. Shared by the
 * REST transport (`VtaClient`) and the DIDComm transport
 * (`DidcommVtaTransport`) so both deliver the same logical surface.
 */

export interface EnrollmentChallengeResponse {
  /** Server-issued challenge (base64url). The browser passes the raw bytes
   *  to `navigator.credentials.create`; the VTA verifies the returned
   *  clientDataJSON against the same value. */
  challenge: string;
  /** Relying-Party identifier — typically the VTA's hostname. */
  rpId: string;
  rpName: string;
  /** Stable user handle to associate with the credential. Bytes the VTA
   *  picked; opaque to the client. */
  userHandle: string;
  userName: string;
  userDisplayName: string;
  /** Server-suggested timeout in milliseconds. */
  timeoutMs?: number;
}

export interface EnrollmentSubmitRequest {
  did: string;
  credentialId: string;
  publicKeyMultibase: string;
  coseAlgorithm: number;
  /** Raw WebAuthn fields the VTA needs for its own verification. */
  attestationObject: string;
  clientDataJson: string;
  authenticatorData: string;
  transports: AuthenticatorTransport[];
  /** Optional human-friendly label. */
  label?: string;
}

export interface EnrollmentSubmitResponse {
  verificationMethod: PasskeyVerificationMethod;
  /** WebVH log entry index that recorded the change. */
  webvhVersion: string;
}

export interface PasskeyList {
  verificationMethods: PasskeyVerificationMethod[];
}
