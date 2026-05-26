// Onboarding key rotation — the wallet's ephemeral did:key, granted into a
// VTA's ACL by the operator, is swapped onto the wallet's long-term holder
// did:peer on first connect via the canonical Trust Task `acl/swap-key/0.1`.
//
// Two proofs ride along, exactly as the VTA's swap-acl handler expects:
//   - the DIDComm authcrypt envelope authenticates the **ephemeral** (the
//     "currentSubject" being rotated away from), via its sender key;
//   - the inner VP-JWT (`issueSwapPresentation`) — carried as `linkProof` —
//     proves control of the **holder did:peer** (the "newSubject"),
//     signed by its #key-2.
//
// Mirrors `requestVtaApproval`: build message → authcrypt to the VTA → forward
// via its mediator → await the reply by `thid`. DIDComm is the first-class
// path — the authcrypt envelope *is* the caller authentication, so no separate
// token round-trip is needed.
//
// Wire format: the canonical Trust Task URI `acl/swap-key/0.1` per the
// dtgwg-trust-tasks-tf registry. The VTA also accepts the legacy
// `firstperson.network/protocols/acl-management/1.0/swap-acl` URI during the
// deprecation window so older plugins keep working; new plugins SHOULD emit
// the canonical URI.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import { issueSwapPresentation, type SigningIdentity } from "../siop/self-issued.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

const ACL_SWAP_KEY = "https://trusttasks.org/spec/acl/swap-key/0.1";
const ACL_SWAP_KEY_RESPONSE = "https://trusttasks.org/spec/acl/swap-key/0.1#response";
const VTA_AUTHENTICATE = "https://affinidi.com/atm/1.0/authenticate";
const DEFAULT_TIMEOUT_MS = 30_000;

/** The ACL entry created for the new DID (the swap-acl result body). */
export interface AclSwapResult {
  did: string;
  role: string;
  label?: string | null;
  allowed_contexts: string[];
  created_at: number;
  created_by: string;
  expires_at?: number | null;
}

export interface SwapAclDidcommOptions {
  /** Mediator-backed bridge that ships the JWE and surfaces the decrypted,
   *  sender-authenticated reply (keyed by `thid`). */
  bridge: DidcommMessageBridge;
  /** Authcrypt sender = the OLD DID (the operator-granted ephemeral did:key). */
  ephemeral: Identity;
  /** Signs the VP-JWT; its DID is the NEW DID (the wallet's holder did:peer). */
  holderSigning: SigningIdentity;
  /** The VTA's DID + keyAgreement key (inner authcrypt recipient). */
  service: RemoteDidcommEndpoint;
  /** The VTA's mediator (forward target); omit for a direct, non-mediated send. */
  mediator?: RemoteDidcommEndpoint;
  /** The VTA's DID — the presentation `aud` + the expected reply `from`. */
  vtaDid: string;
  timeoutMs?: number;
}

/**
 * Rotate the caller's ACL entry from the ephemeral DID onto the holder
 * did:peer over DIDComm. Returns the new ACL entry. Throws if the VTA replies
 * with anything other than a swap-acl-result (e.g. a problem-report).
 */
export async function swapAclDidcomm(opts: SwapAclDidcommOptions): Promise<AclSwapResult> {
  const { bridge, ephemeral, holderSigning, service, mediator, vtaDid } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const linkProof = issueSwapPresentation({ holder: holderSigning, audience: vtaDid });
  const requestId = globalThis.crypto.randomUUID();
  const message = {
    id: requestId,
    type: ACL_SWAP_KEY,
    from: ephemeral.did,
    to: [service.did],
    body: {
      currentSubject: ephemeral.did,
      newSubject: holderSigning.did,
      linkProof,
    },
  };

  const inner = await packAuthcrypt(message, ephemeral, [
    { kid: service.keyAgreementKid, jwk: service.keyAgreementPublicJwk },
  ]);

  let outer = inner;
  if (mediator) {
    const forwardJson = wrapForward(service.did, ephemeral.did, mediator.did, inner);
    outer = await packAuthcryptJson(forwardJson, ephemeral, [
      { kid: mediator.keyAgreementKid, jwk: mediator.keyAgreementPublicJwk },
    ]);
  }

  const reply = await bridge.sendAndAwaitReply(outer, requestId, { timeoutMs });

  if (reply.thid !== requestId) {
    throw new Error(`acl/swap-key: reply thid ${reply.thid ?? "(none)"} != request ${requestId}`);
  }
  if (reply.from !== vtaDid) {
    throw new Error(`acl/swap-key: reply from ${reply.from ?? "(none)"} != VTA ${vtaDid}`);
  }
  if (reply.type !== ACL_SWAP_KEY_RESPONSE) {
    // Most commonly a problem-report (e.g. the VP failed to verify, or the
    // ephemeral isn't in the ACL yet).
    throw new Error(
      `acl/swap-key: ${reply.type ?? "(no type)"} — ${JSON.stringify(reply.body ?? {})}`,
    );
  }

  return (reply.body ?? {}) as AclSwapResult;
}

export interface SwapAclRestOptions {
  /** VTA REST base URL (from `#vta-rest`, e.g. `http://localhost:8100`). */
  baseUrl: string;
  /** Authcrypt sender = the OLD DID (the operator-granted ephemeral). */
  ephemeral: Identity;
  /** Signs the VP-JWT; its DID is the NEW DID (the wallet's holder did:peer). */
  holderSigning: SigningIdentity;
  /** The VTA's DID + keyAgreement (authcrypt recipient for `/auth/`). */
  service: RemoteDidcommEndpoint;
  /** The VTA's DID — the presentation `aud`. Usually `service.did`. */
  vtaDid: string;
  /** fetch impl (defaults to global). */
  fetch?: typeof fetch;
}

/**
 * REST-only swap: when a VTA advertises `#vta-rest` but no `#vta-didcomm`, the
 * wallet still uses DIDComm authcrypt to authenticate (the VTA's `/auth/`
 * unpacks a DIDComm message), then POSTs the swap over HTTP. Same proofs as
 * the DIDComm path — the authcrypted authenticate message proves control of
 * the ephemeral, the VP-JWT proves control of the holder did:peer — only the
 * transport differs (direct HTTP, no mediator).
 */
export async function swapAclRest(opts: SwapAclRestOptions): Promise<AclSwapResult> {
  const { baseUrl, ephemeral, holderSigning, service, vtaDid } = opts;
  const f = opts.fetch ?? fetch.bind(globalThis);
  const base = baseUrl.replace(/\/+$/, "");

  // 1. /auth/challenge → flat { challenge, sessionId, expiresAt } per
  //    `vti_common::auth::handlers::challenge::ChallengeResponse`. Fields
  //    are top-level, NOT nested under `data`.
  const cRes = await f(`${base}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: ephemeral.did }),
  });
  if (!cRes.ok) {
    throw new Error(`vta /auth/challenge failed (${cRes.status}): ${await cRes.text()}`);
  }
  const cBody = (await cRes.json()) as { sessionId?: string; challenge?: string };
  if (!cBody.sessionId || !cBody.challenge) {
    throw new Error(`vta /auth/challenge: malformed response: ${JSON.stringify(cBody)}`);
  }

  // 2. Authcrypt an `atm/1.0/authenticate` message to the VTA (direct, no
  //    forward — there's no mediator on this transport).
  const authMsg = {
    id: globalThis.crypto.randomUUID(),
    type: VTA_AUTHENTICATE,
    from: ephemeral.did,
    to: [service.did],
    body: { challenge: cBody.challenge, session_id: cBody.sessionId },
  };
  const packed = await packAuthcrypt(authMsg, ephemeral, [
    { kid: service.keyAgreementKid, jwk: service.keyAgreementPublicJwk },
  ]);

  // 3. POST the packed JWE to `/auth/` → AuthenticateResponse with
  //    { session, tokens: { accessToken, ... } } per vta-sdk's
  //    `protocols::auth::AuthenticateResponse`.
  const aRes = await f(`${base}/auth/`, {
    method: "POST",
    headers: { "content-type": "application/didcomm-encrypted+json" },
    body: packed,
  });
  if (!aRes.ok) {
    throw new Error(`vta /auth/ failed (${aRes.status}): ${await aRes.text()}`);
  }
  const aBody = (await aRes.json()) as { tokens?: { accessToken?: string } };
  const accessToken = aBody.tokens?.accessToken;
  if (!accessToken) {
    throw new Error(`vta /auth/: malformed response: ${JSON.stringify(aBody)}`);
  }

  // 4. POST /acl/swap with Bearer + the holder's VP-JWT (as `linkProof`) → the
  //    new ACL entry. Canonical Trust Task `acl/swap-key/0.1` body shape.
  const linkProof = issueSwapPresentation({ holder: holderSigning, audience: vtaDid });
  const sRes = await f(`${base}/acl/swap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      currentSubject: ephemeral.did,
      newSubject: holderSigning.did,
      linkProof,
    }),
  });
  if (!sRes.ok) {
    throw new Error(`vta /acl/swap failed (${sRes.status}): ${await sRes.text()}`);
  }
  return (await sRes.json()) as AclSwapResult;
}
