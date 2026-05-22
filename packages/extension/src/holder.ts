import { generateOrLoadHolderIdentity, IndexedDBKVStore, type HolderIdentityResult } from "@pnm/core";

// The wallet's inbox mediator. Baked into the holder `did:peer:2` service
// endpoint (via `generateOrLoadHolderIdentity({ mediatorDid })`) so RPs can
// route inbound DIDComm (RP-initiated `confirm` requests) to the wallet. It's
// the same mediator the wallet authenticates to for DIDComm login, so the
// wallet is already a registered recipient there.
//
// NOTE: this is baked into the DID at first mint, so changing it mints a NEW
// holder DID (which must be re-granted in the RP ACL). For the demo it's the
// did-hosting mediator; a real wallet would let the operator choose.
export const WALLET_MEDIATOR_DID =
  "did:webvh:QmTS3a3H9Dk4ZMPAZ8jNWGeyPbuKrPbrPZcSbg8CJ6yynD:webvh.storm.ws:mediator";

/** Load (or first-mint) the wallet's holder identity as a service-bearing
 *  `did:peer:2`. All extension contexts (SW + offscreen) go through this so
 *  the minted DID is identical and reachable for inbound. */
export function loadHolder(): Promise<HolderIdentityResult> {
  return generateOrLoadHolderIdentity(new IndexedDBKVStore(), {
    mediatorDid: WALLET_MEDIATOR_DID,
  });
}
