// Onboarding key rotation — the wallet's ephemeral did:key, granted into a
// VTA's ACL by the operator, is swapped onto the wallet's long-term holder
// did:peer on first connect via the `swap-acl` Trust-Task.
//
// Two proofs ride along, exactly as the VTA's swap-acl handler expects:
//   - the DIDComm authcrypt envelope authenticates the **ephemeral** (the
//     "old" DID being rotated away from), via its sender key;
//   - the inner VP-JWT (`issueSwapPresentation`) proves control of the
//     **holder did:peer** (the "new" DID), signed by its #key-2.
//
// Mirrors `requestVtaApproval`: build message → authcrypt to the VTA → forward
// via its mediator → await the reply by `thid`. DIDComm is the first-class
// path — the authcrypt envelope *is* the caller authentication, so no separate
// token round-trip is needed.

import { packAuthcrypt, packAuthcryptJson, wrapForward, type Identity } from "../didcomm/index.js";
import { issueSwapPresentation, type SigningIdentity } from "../siop/self-issued.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { DidcommMessageBridge } from "../vta/transport.js";

const SWAP_ACL = "https://firstperson.network/protocols/acl-management/1.0/swap-acl";
const SWAP_ACL_RESULT = "https://firstperson.network/protocols/acl-management/1.0/swap-acl-result";
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

  const presentation = issueSwapPresentation({ holder: holderSigning, audience: vtaDid });
  const requestId = globalThis.crypto.randomUUID();
  const message = {
    id: requestId,
    type: SWAP_ACL,
    from: ephemeral.did,
    to: [service.did],
    body: { presentation },
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
    throw new Error(`swap-acl: reply thid ${reply.thid ?? "(none)"} != request ${requestId}`);
  }
  if (reply.from !== vtaDid) {
    throw new Error(`swap-acl: reply from ${reply.from ?? "(none)"} != VTA ${vtaDid}`);
  }
  if (reply.type !== SWAP_ACL_RESULT) {
    // Most commonly a problem-report (e.g. the VP failed to verify, or the
    // ephemeral isn't in the ACL yet).
    throw new Error(`swap-acl: ${reply.type ?? "(no type)"} — ${JSON.stringify(reply.body ?? {})}`);
  }

  return (reply.body ?? {}) as AclSwapResult;
}
