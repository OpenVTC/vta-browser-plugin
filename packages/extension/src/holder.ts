import {
  generateOrLoadHolderIdentity,
  IndexedDBKVStore,
  type HolderIdentityResult,
  type SecretWrap,
} from "@pnm/core";
import { getSettings } from "./config.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";

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

/**
 * Build the secret wrap the load path should use, given the
 * current `encryptHolderSecret` setting. Returns `undefined`
 * when encryption is off (the loader then operates plaintext).
 *
 * The wrap's WebAuthn rpId is the extension's runtime id —
 * `chrome-extension://<id>` is the effective origin; WebAuthn
 * rejects `chrome-extension:` scheme as an rpId, so we pass the
 * bare id (the authenticator stores the credential against
 * that). The authenticator uses the same rpId on every unwrap.
 */
function buildSecretWrap(): SecretWrap {
  return new WebAuthnPrfSecretWrap(chrome.runtime.id);
}

/** Load (or first-mint) the wallet's holder identity as a service-bearing
 *  `did:peer:2`. All extension contexts (SW + offscreen) go through this so
 *  the minted DID is identical and reachable for inbound.
 *
 *  When `encryptHolderSecret` is on, the persisted Ed25519 secret is
 *  wrapped/unwrapped through a `WebAuthnPrfSecretWrap`. The first
 *  invocation per cold-start prompts the operator for their authenticator;
 *  subsequent invocations in the same SW lifetime reuse the in-memory
 *  derived key (cleared by `WebAuthnPrfSecretWrap.lock()` or SW eviction).
 */
export async function loadHolder(): Promise<HolderIdentityResult> {
  const settings = await getSettings();
  return generateOrLoadHolderIdentity(new IndexedDBKVStore(), {
    mediatorDid: settings.mediatorDid,
    ...(settings.encryptHolderSecret ? { secretWrap: buildSecretWrap() } : {}),
  });
}
