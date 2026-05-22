// SIOPv2 login client for a Trust-Tasks Relying Party (the DID hosting
// service). Drives the RP's challenge → authenticate flow: fetch a
// nonce, self-issue an `id_token` signed by the holder's Ed25519
// `did:key`, wrap it in the RP's authenticate Trust-Task envelope, and
// exchange it for a session JWT. No passkey, no DIDComm to the RP — the
// RP verifies by resolving the holder DID.

import { issueIdToken, type SigningIdentity } from "./self-issued.js";

/** The DID-hosting authenticate Trust-Task type (flat did-hosting form,
 *  matching the service's `TASK_AUTH_AUTHENTICATE_1_0`). */
const TASK_AUTH_AUTHENTICATE =
  "https://trusttasks.org/did-hosting/auth/authenticate/1.0";

export interface SiopLoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface SiopLoginOptions {
  /** Base URL of the RP's auth API (e.g. `https://hosting.example/api`). */
  baseUrl: string;
  /** The RP's identifier — its server DID — used as the `id_token` `aud`. */
  rpDid: string;
  /** The holder's Ed25519 signing identity (from `generateOrLoadHolderIdentity().signing`). */
  signing: SigningIdentity;
  /** Optional ephemeral session pubkey (`z6Mk…` Ed25519 multikey) to bind
   *  for subsequent trust-task proofs. */
  sessionPubkeyB58btc?: string;
  /** fetch impl (defaults to the global). */
  fetch?: typeof fetch;
}

/**
 * Log into a Trust-Tasks RP via SIOPv2 self-issuance. Returns the
 * RP-issued session tokens. Throws on a transport error or an RP
 * rejection (the error message carries the RP's response body).
 */
export async function loginViaSiop(
  opts: SiopLoginOptions,
): Promise<SiopLoginResult> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const base = opts.baseUrl.replace(/\/+$/, "");

  // 1. Request a challenge nonce for the holder DID.
  const challengeRes = await fetchFn(`${base}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: opts.signing.did }),
  });
  if (!challengeRes.ok) {
    throw new Error(
      `siop login: challenge failed (${challengeRes.status}): ${await challengeRes.text()}`,
    );
  }
  const challenge = (await challengeRes.json()) as {
    session_id: string;
    data: { challenge: string };
  };

  // 2. Self-issue the id_token — aud = the RP's DID, nonce = the challenge.
  const idToken = issueIdToken({
    identity: opts.signing,
    audience: opts.rpDid,
    nonce: challenge.data.challenge,
  });

  // 3. Wrap in the RP's authenticate Trust-Task envelope.
  const envelope = {
    id: `urn:uuid:${globalThis.crypto.randomUUID()}`,
    type: TASK_AUTH_AUTHENTICATE,
    issuer: opts.signing.did,
    issuedAt: new Date().toISOString(),
    payload: {
      id_token: idToken,
      session_id: challenge.session_id,
      ...(opts.sessionPubkeyB58btc
        ? { session_pubkey_b58btc: opts.sessionPubkeyB58btc }
        : {}),
    },
  };

  // 4. Exchange for a session JWT.
  const authRes = await fetchFn(`${base}/auth/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!authRes.ok) {
    throw new Error(
      `siop login: authenticate failed (${authRes.status}): ${await authRes.text()}`,
    );
  }
  const r = (await authRes.json()) as {
    session_id: string;
    access_token: string;
    refresh_token: string;
  };
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    sessionId: r.session_id,
  };
}
