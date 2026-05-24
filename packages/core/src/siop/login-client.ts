// SIOPv2 login client for a Trust-Tasks Relying Party (the DID hosting
// service). Drives the RP's challenge → authenticate flow: fetch a
// nonce, self-issue an `id_token` signed by the holder's Ed25519
// `did:key`, wrap it in the RP's authenticate Trust-Task envelope, and
// exchange it for a session JWT. No passkey, no DIDComm to the RP — the
// RP verifies by resolving the holder DID.

import { createStopwatch, type TimingMark } from "../util/timing.js";
import { issueIdToken, type SigningIdentity } from "./self-issued.js";

/** The canonical authenticate Trust-Task type from trusttasks-tf.
 *  did-hosting + VTA + VTC all dispatch on this same URI. */
const TASK_AUTH_AUTHENTICATE = "https://trusttasks.org/spec/auth/authenticate/0.1";

export interface SiopLoginResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  /** Per-phase timings (challenge / id_token / authenticate). */
  timings: TimingMark[];
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
  const sw = createStopwatch();

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
  // Canonical wire (spec/auth/challenge/0.1#response): flat
  // { challenge, sessionId, expiresAt }. No `data` envelope.
  const challenge = (await challengeRes.json()) as {
    challenge: string;
    sessionId: string;
    expiresAt: string;
  };
  sw.mark("challenge");

  // 2. Self-issue the id_token — aud = the RP's DID, nonce = the challenge.
  const idToken = issueIdToken({
    identity: opts.signing,
    audience: opts.rpDid,
    nonce: challenge.challenge,
  });
  sw.mark("id_token signed");

  // 3. Wrap in the RP's authenticate Trust-Task envelope.
  const envelope = {
    id: `urn:uuid:${globalThis.crypto.randomUUID()}`,
    type: TASK_AUTH_AUTHENTICATE,
    issuer: opts.signing.did,
    issuedAt: new Date().toISOString(),
    payload: {
      id_token: idToken,
      session_id: challenge.sessionId,
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
  // Canonical wire (spec/auth/authenticate/0.1#response):
  // { session: Session, tokens: TokenBundle }. Session.id is the
  // session identifier; tokens.{accessToken, refreshToken} carry
  // the bearer material. `expiresIn` is seconds-from-issuance per
  // RFC 6749 §5.1 — clients compute the absolute moment as
  // Date.parse(session.issuedAt) + tokens.expiresIn * 1000.
  const r = (await authRes.json()) as {
    session: {
      id: string;
      subject: string;
      issuedAt: string;
      expiresAt: string;
      amr?: string[];
      acr?: string;
    };
    tokens: {
      accessToken: string;
      refreshToken?: string;
      tokenType: string;
      expiresIn: number;
      refreshExpiresIn?: number;
    };
  };
  sw.mark("authenticate");
  return {
    timings: sw.marks,
    accessToken: r.tokens.accessToken,
    refreshToken: r.tokens.refreshToken ?? "",
    sessionId: r.session.id,
  };
}
