// Wallet configuration, persisted in IndexedDB (shared across the service
// worker, offscreen doc, popup, and options page — all the same extension
// origin). IndexedDB rather than chrome.storage because the offscreen document
// — where DIDComm login + onboarding run — does NOT expose chrome.storage,
// while IndexedDB is available in every extension context (and is already the
// holder identity's backing store).
//
// The mediator DID is the load-bearing setting: it's baked into the holder's
// `did:peer:2` service endpoint at first mint, so changing it mints a NEW
// wallet DID (which must be re-granted in every RP's ACL). The options page
// is responsible for warning + forcing a re-mint when it changes; reading the
// config here never re-mints on its own.

import { IndexedDBKVStore } from "@pnm/core";

/** The mediator the wallet uses for inbound + DIDComm login when unconfigured.
 *  The did-hosting demo mediator. A real deployment configures its own. */
export const DEFAULT_WALLET_MEDIATOR_DID =
  "did:webvh:QmTS3a3H9Dk4ZMPAZ8jNWGeyPbuKrPbrPZcSbg8CJ6yynD:webvh.storm.ws:mediator";

export interface WalletSettings {
  /** Mediator DID baked into the holder did:peer (inbox + DIDComm login). */
  mediatorDid: string;
  /** Optional default VTA DID prefilled into the step-up flow. */
  defaultStepUpVtaDid?: string;
  /** Optional default VTA mediator DID prefilled into the step-up flow. */
  defaultStepUpVtaMediatorDid?: string;
  /**
   * H1 from the May 2026 security review: encrypt the persisted
   * Ed25519 root secret with a key derived from the operator's
   * WebAuthn-PRF authenticator.
   *
   * **Default: `true` for new installs.** Onboarding mints a
   * v4 holder identity with the seed AES-GCM-encrypted under a
   * PRF-derived key; an exfiltrated IndexedDB row is useless
   * without the operator's authenticator. On browsers without a
   * PRF-capable authenticator (older platforms, no enrolled
   * platform passkey), the onboarding fallback in
   * `offscreen.ts:doOnboardConnect` catches the wrap-decline
   * and persists plaintext with a warning surfaced to the
   * popup — wallet still works, just unencrypted.
   *
   * **Existing wallets are unaffected.** Their persisted record
   * carries its own `algorithm` tag; the read path dispatches on
   * that, ignoring the caller's wrap preference. A wallet
   * minted before this default flipped continues to load via
   * PassthroughWrap exactly as before.
   *
   * Trade-off: encryption-on means every cold-start (new
   * browser session, service-worker eviction) prompts the
   * operator to tap their authenticator; losing the
   * authenticator without unenrolling first means losing the
   * wallet. The options page renders both risks explicitly
   * before flipping the flag manually.
   */
  encryptHolderSecret?: boolean;
}

const SETTINGS_KEY = "pnm/settings/v1";

/** Read the current settings, falling back to defaults for unset fields. */
export async function getSettings(): Promise<WalletSettings> {
  const s = await new IndexedDBKVStore().get<Partial<WalletSettings>>(SETTINGS_KEY);
  // `encryptHolderSecret` defaults to TRUE when unset — a fresh
  // install gets PRF-encrypted at rest unless the operator
  // explicitly opts out via the settings page (which persists
  // `false`). An explicit `false` round-trips as-is; an explicit
  // `true` round-trips as-is; only the "never set" state flips
  // to the new default. See the field's docblock for the
  // back-compat semantics for existing wallets.
  const encryptHolderSecret =
    typeof s?.encryptHolderSecret === "boolean" ? s.encryptHolderSecret : true;
  return {
    mediatorDid: s?.mediatorDid || DEFAULT_WALLET_MEDIATOR_DID,
    ...(s?.defaultStepUpVtaDid ? { defaultStepUpVtaDid: s.defaultStepUpVtaDid } : {}),
    ...(s?.defaultStepUpVtaMediatorDid
      ? { defaultStepUpVtaMediatorDid: s.defaultStepUpVtaMediatorDid }
      : {}),
    encryptHolderSecret,
  };
}

/** Merge a partial update into the stored settings. */
export async function setSettings(patch: Partial<WalletSettings>): Promise<void> {
  const current = await getSettings();
  await new IndexedDBKVStore().put(SETTINGS_KEY, { ...current, ...patch });
}
