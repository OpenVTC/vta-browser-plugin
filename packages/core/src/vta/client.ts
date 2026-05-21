import type { PasskeyEnrollmentResult } from "../webauthn/register.js";
import { errorFromResponse, VtaClientError } from "./errors.js";
import type { VtaTransport } from "./transport.js";
import type {
  EnrollmentChallengeResponse,
  EnrollmentSubmitRequest,
  EnrollmentSubmitResponse,
  PasskeyList,
} from "./types.js";

export type {
  EnrollmentChallengeResponse,
  EnrollmentSubmitRequest,
  EnrollmentSubmitResponse,
  PasskeyList,
};

export interface VtaClientConfig {
  /** Base URL of the VTA, e.g. `https://vta.example.com`. */
  baseUrl: string;
  /** Bearer token. See README — initial enrollment uses a short-lived
   *  token minted by the `pnm` CLI; later requests use a passkey-derived JWT. */
  accessToken: string;
  /** Optional override for the global fetch. Useful for tests. */
  fetch?: typeof fetch;
}

export class VtaClient implements VtaTransport {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: VtaClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.accessToken = cfg.accessToken;
    this.fetchImpl = cfg.fetch ?? fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.accessToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new VtaClientError("e.client.network", (err as Error).message);
    }
    if (!res.ok) throw await errorFromResponse(res);
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new VtaClientError("e.client.parse", (err as Error).message, {
        status: res.status,
      });
    }
  }

  /**
   * Step 1 of the enrollment ceremony: ask the VTA for a challenge.
   * The challenge is stored server-side and verified against the
   * `clientDataJSON.challenge` value the authenticator signs.
   */
  requestEnrollmentChallenge(did: string): Promise<EnrollmentChallengeResponse> {
    const qs = new URLSearchParams({ did }).toString();
    return this.request(`/did/verification-methods/passkey/challenge?${qs}`, {
      method: "POST",
    });
  }

  /**
   * Step 2: submit the credential. The VTA verifies the
   * attestation, derives the VM `id`, appends a WebVH LogEntry, and
   * returns the canonical VM as published.
   */
  submitPasskeyEnrollment(
    payload: EnrollmentSubmitRequest,
  ): Promise<EnrollmentSubmitResponse> {
    return this.request("/did/verification-methods/passkey", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listPasskeys(did: string): Promise<PasskeyList> {
    const qs = new URLSearchParams({ did }).toString();
    return this.request(`/did/verification-methods/passkey?${qs}`);
  }

  removePasskey(did: string, fragment: string): Promise<void> {
    const qs = new URLSearchParams({ did }).toString();
    return this.request(
      `/did/verification-methods/passkey/${encodeURIComponent(fragment)}?${qs}`,
      { method: "DELETE" },
    );
  }
}

/**
 * Convenience: wire a `PasskeyEnrollmentResult` straight into the
 * VTA's submit-enrollment request shape.
 */
export function enrollmentSubmitFromResult(
  did: string,
  result: PasskeyEnrollmentResult,
  ceremonyId: string,
  label?: string,
): EnrollmentSubmitRequest {
  const req: EnrollmentSubmitRequest = {
    did,
    ceremonyId,
    credentialId: result.credentialId,
    publicKeyMultibase: result.publicKeyMultikey,
    coseAlgorithm: result.coseAlg,
    attestationObject: result.attestationObjectB64u,
    clientDataJson: result.clientDataJsonB64u,
    authenticatorData: result.authenticatorDataB64u,
    transports: result.transports,
  };
  if (label !== undefined) req.label = label;
  return req;
}
