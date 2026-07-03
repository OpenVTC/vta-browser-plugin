// Onboarding key rotation — the wallet's ephemeral did:key, granted into a
// VTA's ACL by the operator, is swapped onto the wallet's long-term holder
// did:peer via the canonical Trust Task `acl/swap-key/0.1`.
//
// Two proofs ride along, exactly as the VTA's swap-key handler expects:
//   - the transport authenticates the **ephemeral** (the `currentSubject` being
//     rotated away from) — DIDComm authcrypt sender / REST bearer session;
//   - the inner VP-JWT (`issueSwapPresentation`), carried as `linkProof`,
//     proves control of the **holder did:peer** (the `newSubject`).
//
// Transport-agnostic: `swapAcl` sends the `acl/swap-key/0.1` Trust Task over any
// TrustTaskSender whose identity is the ephemeral. The VTA routes it through the
// shared dispatcher (`handle_swap_key`) over REST / DIDComm / TSP identically.
//
// NOTE: currently unused — onboarding adopts a VTA-minted holder via
// `runProvisionIntegration` (M2C) rather than self-minting + swapping. Kept
// consistent with the channel pattern for when a swap-based flow is needed.

import type { Identity } from "../didcomm/index.js";
import { issueSwapPresentation, type SigningIdentity } from "../siop/self-issued.js";
import type { TrustTaskSender } from "../vta/channel.js";
import { DidcommVtaTransport, type RemoteDidcommEndpoint } from "../vta/didcomm.js";
import { RestChannel } from "../vta/rest-channel.js";
import type { DidcommMessageBridge } from "../vta/transport.js";
import { buildTrustTask } from "../vta/trust-task.js";

const ACL_SWAP_KEY = "https://trusttasks.org/spec/acl/swap-key/0.1";
const ACL_SWAP_KEY_RESPONSE = "https://trusttasks.org/spec/acl/swap-key/0.1#response";

/** The ACL entry created for the new DID (the swap-key result body). */
export interface AclSwapResult {
  did: string;
  role: string;
  label?: string | null;
  allowed_contexts: string[];
  created_at: number;
  created_by: string;
  expires_at?: number | null;
}

export interface SwapAclParams {
  /** The OLD DID (operator-granted ephemeral). Its DID is `currentSubject` and
   *  the envelope `issuer`; the sender MUST authenticate as it. */
  ephemeralDid: string;
  /** Signs the `linkProof` VP-JWT; its DID is the NEW DID (holder did:peer) =
   *  `newSubject`. */
  holderSigning: SigningIdentity;
  /** The VTA — the presentation `aud` and the envelope `recipient`. */
  vtaDid: string;
}

/**
 * Rotate the caller's ACL entry from the ephemeral DID onto the holder did:peer
 * by sending the `acl/swap-key/0.1` Trust Task over `sender`. The sender's
 * identity MUST be the ephemeral (so the transport authenticates it as
 * `currentSubject`); the `linkProof` VP proves control of `newSubject`.
 */
export async function swapAcl(
  sender: TrustTaskSender,
  params: SwapAclParams,
): Promise<AclSwapResult> {
  const linkProof = issueSwapPresentation({
    holder: params.holderSigning,
    audience: params.vtaDid,
  });
  const envelope = buildTrustTask(
    ACL_SWAP_KEY,
    {
      currentSubject: params.ephemeralDid,
      newSubject: params.holderSigning.did,
      linkProof,
    },
    { issuer: params.ephemeralDid, recipient: params.vtaDid },
  );
  return sender.send<AclSwapResult>(envelope, {
    expectedResponseType: ACL_SWAP_KEY_RESPONSE,
    operationLabel: "acl/swap-key/0.1",
  });
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

/** @deprecated Use {@link swapAcl} with a channel/session whose identity is the
 *  ephemeral. Swap over DIDComm — builds a {@link DidcommVtaTransport} as the
 *  ephemeral and dispatches `acl/swap-key/0.1` through the binding envelope. */
export function swapAclDidcomm(opts: SwapAclDidcommOptions): Promise<AclSwapResult> {
  const channel = new DidcommVtaTransport({
    bridge: opts.bridge,
    holder: opts.ephemeral,
    vta: opts.service,
    ...(opts.mediator ? { mediator: opts.mediator } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return swapAcl(channel, {
    ephemeralDid: opts.ephemeral.did,
    holderSigning: opts.holderSigning,
    vtaDid: opts.vtaDid,
  });
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

/** @deprecated Use {@link swapAcl} with a channel/session whose identity is the
 *  ephemeral. Swap over REST — builds a {@link RestChannel} as the ephemeral and
 *  dispatches `acl/swap-key/0.1` over `/api/trust-tasks` (NOT the bespoke
 *  `/acl/swap` route, which is being retired now the dispatcher handles it). */
export function swapAclRest(opts: SwapAclRestOptions): Promise<AclSwapResult> {
  const channel = new RestChannel({
    baseUrl: opts.baseUrl,
    holder: opts.ephemeral,
    service: opts.service,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return swapAcl(channel, {
    ephemeralDid: opts.ephemeral.did,
    holderSigning: opts.holderSigning,
    vtaDid: opts.vtaDid,
  });
}
