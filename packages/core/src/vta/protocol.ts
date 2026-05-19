/**
 * DIDComm v2 protocol — `passkey-management/1.0`.
 *
 * Operation-for-operation parity with the REST surface in `VtaClient`.
 * Request/response messages thread by `thid = request.id`; failures
 * use the standard DIDComm `problem-report/2.0` shape.
 *
 * These shapes describe only the **body** of the DIDComm message —
 * the envelope (id, type, from, to, thid, …) is built by the
 * `DidcommVtaTransport`.
 */

const BASE = "https://didcomm.org/passkey-management/1.0";

export const PasskeyManagementProtocol = {
  enrollChallenge: `${BASE}/enroll-challenge`,
  enrollChallengeResponse: `${BASE}/enroll-challenge-response`,
  enrollSubmit: `${BASE}/enroll-submit`,
  enrollSubmitResponse: `${BASE}/enroll-submit-response`,
  list: `${BASE}/list`,
  listResponse: `${BASE}/list-response`,
  revoke: `${BASE}/revoke`,
  revokeResponse: `${BASE}/revoke-response`,
  problemReport: "https://didcomm.org/report-problem/2.0/problem-report",
} as const;

export type PasskeyManagementMessageType =
  (typeof PasskeyManagementProtocol)[keyof typeof PasskeyManagementProtocol];

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface EnrollChallengeRequestBody {
  did: string;
}

export interface EnrollSubmitRequestBody {
  did: string;
  credentialId: string;
  publicKeyMultibase: string;
  coseAlgorithm: number;
  attestationObject: string;
  clientDataJson: string;
  authenticatorData: string;
  transports: AuthenticatorTransport[];
  label?: string;
}

export interface ListRequestBody {
  did: string;
}

export interface RevokeRequestBody {
  did: string;
  fragment: string;
}

// ---------------------------------------------------------------------------
// Response bodies (mirror the REST response shapes, sans transport
// framing). Re-using the types from `./types.js` keeps drift impossible.
// ---------------------------------------------------------------------------

export type {
  EnrollmentChallengeResponse as EnrollChallengeResponseBody,
  EnrollmentSubmitResponse as EnrollSubmitResponseBody,
  PasskeyList as ListResponseBody,
} from "./types.js";

// ---------------------------------------------------------------------------
// Problem report
// ---------------------------------------------------------------------------

export interface ProblemReportBody {
  code: string;
  comment?: string;
  args?: string[];
}
