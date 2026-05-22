import { generateOrLoadHolderIdentity, IndexedDBKVStore, type HolderIdentityResult } from "@pnm/core";
import { getSettings } from "./config.js";

/** The wallet's inbox mediator DID — configurable (see `config.ts`), baked
 *  into the holder `did:peer:2` service endpoint at first mint so RPs can
 *  route inbound DIDComm (RP-initiated `confirm` requests) to the wallet. It's
 *  also the mediator the wallet authenticates to for DIDComm login, so the
 *  wallet is already a registered recipient there.
 *
 *  NOTE: this is baked into the DID at first mint, so changing it mints a NEW
 *  holder DID (which must be re-granted in the RP ACL). The options page
 *  handles that re-mint explicitly; `loadHolder` only uses it for a fresh mint. */
export async function getWalletMediatorDid(): Promise<string> {
  return (await getSettings()).mediatorDid;
}

/** Load (or first-mint) the wallet's holder identity as a service-bearing
 *  `did:peer:2`. All extension contexts (SW + offscreen) go through this so
 *  the minted DID is identical and reachable for inbound. */
export async function loadHolder(): Promise<HolderIdentityResult> {
  const mediatorDid = await getWalletMediatorDid();
  return generateOrLoadHolderIdentity(new IndexedDBKVStore(), { mediatorDid });
}
