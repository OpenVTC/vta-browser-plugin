// VTA-approval step-up for a did-hosting Relying Party.
//
// Elevates an existing `aal1` session to `aal2`: the RP issues a nonce, the
// holder's VTA signs an approval over DIDComm, and the RP exchanges that
// approval for a fresh, higher-assurance session token. The DIDComm leg
// mirrors `loginViaDidcomm` exactly (build message → authcrypt to the VTA →
// forward via its mediator → await reply by `thid`), but with the
// step-up approve-request/response message types.
//
// Three steps:
//   1. RP start  (REST)    → nonce
//   2. VTA approve (DIDComm) → approval_token (compact JWS)
//   3. RP finish (REST)    → elevated session tokens
//
// Server contract (step 1 + 3 REST responses are **snake_case**, unlike the
// camelCase login responses).

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

const MSG_APPROVE_REQUEST = "https://trusttasks.org/vta/step-up/approve-request/1.0";
const MSG_APPROVE_RESPONSE = "https://trusttasks.org/vta/step-up/approve-response/1.0";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequestVtaApprovalOptions {
  /** Mediator-backed bridge that ships the JWE and surfaces the decrypted,
   *  sender-authenticated reply (keyed by `thid`). */
  bridge: DidcommMessageBridge;
  /** The wallet's holder identity (authcrypt sender). */
  holder: Identity;
  /** The VTA's DID + keyAgreement key (authcrypt recipient). */
  service: RemoteDidcommEndpoint;
  /** The VTA's mediator. When set, the message is wrapped in a
   *  routing/2.0/forward and authcrypted to the mediator. */
  mediator?: RemoteDidcommEndpoint;
  /** The RP's DID — bound into the approval the VTA signs. */
  rpDid: string;
  /** The nonce from the RP's step-up start call. */
  nonce: string;
  /** Reply timeout (default 30s). */
  timeoutMs?: number;
}

/**
 * Ask the holder's VTA to approve a step-up over DIDComm and return the
 * compact-JWS approval token. Throws if the VTA replies with anything
 * other than an approve-response (e.g. a problem-report).
 */
export async function requestVtaApproval(opts: RequestVtaApprovalOptions): Promise<string> {
  const { bridge, holder, service, mediator, rpDid, nonce } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestId = globalThis.crypto.randomUUID();
  const message = {
    id: requestId,
    type: MSG_APPROVE_REQUEST,
    from: holder.did,
    to: [service.did],
    body: { rp_did: rpDid, nonce },
  };

  const inner = await packAuthcrypt(message, holder, [
    { kid: service.keyAgreementKid, jwk: service.keyAgreementPublicJwk },
  ]);

  let outer = inner;
  if (mediator) {
    const forwardJson = wrapForward(service.did, holder.did, mediator.did, inner);
    outer = await packAuthcryptJson(forwardJson, holder, [
      { kid: mediator.keyAgreementKid, jwk: mediator.keyAgreementPublicJwk },
    ]);
  }

  const reply = await bridge.sendAndAwaitReply(outer, requestId, { timeoutMs });

  if (reply.thid !== requestId) {
    throw new Error(`vta step-up: reply thid ${reply.thid ?? "(none)"} != request ${requestId}`);
  }
  if (reply.from !== service.did) {
    throw new Error(`vta step-up: reply from ${reply.from ?? "(none)"} != VTA ${service.did}`);
  }
  if (reply.type !== MSG_APPROVE_RESPONSE) {
    // Most commonly a problem-report (e.g. VTA declined the step-up).
    throw new Error(
      `vta step-up: ${reply.type ?? "(no type)"} — ${JSON.stringify(reply.body ?? {})}`,
    );
  }

  const body = (reply.body ?? {}) as { approval_token?: string };
  if (!body.approval_token) {
    throw new Error(
      `vta step-up: malformed approve-response body: ${JSON.stringify(body)}`,
    );
  }
  return body.approval_token;
}

/**
 * Step 1 — RP start. Authenticated with the existing `aal1` access token,
 * returns the nonce the VTA must sign over.
 */
export async function stepUpVtaStart(
  baseUrl: string,
  accessToken: string,
  fetchFn?: typeof fetch,
): Promise<string> {
  const f = fetchFn ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");
  const res = await f(`${base}/auth/step-up/vta/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`vta step-up start: failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { nonce?: string };
  if (!json.nonce) {
    throw new Error(`vta step-up start: malformed response: ${JSON.stringify(json)}`);
  }
  return json.nonce;
}

export interface StepUpVtaFinishResult {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/**
 * Step 3 — RP finish. Submits the VTA's approval token and returns the
 * elevated session tokens. Response body is **snake_case**.
 */
export async function stepUpVtaFinish(
  baseUrl: string,
  accessToken: string,
  approvalToken: string,
  fetchFn?: typeof fetch,
): Promise<StepUpVtaFinishResult> {
  const f = fetchFn ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");
  const res = await f(`${base}/auth/step-up/vta/finish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ approval_token: approvalToken }),
  });
  if (!res.ok) {
    throw new Error(`vta step-up finish: failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    session_id?: string;
    access_token?: string;
    access_expires_at?: number;
    refresh_token?: string;
    refresh_expires_at?: number;
  };
  if (!body.access_token || !body.session_id || !body.refresh_token) {
    throw new Error(`vta step-up finish: malformed response body: ${JSON.stringify(body)}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    sessionId: body.session_id,
  };
}
