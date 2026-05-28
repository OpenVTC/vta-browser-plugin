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

import { IndexedDBKVStore } from "@openvtc/pnm-core";

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
   * **Default: `false`.** The wrap relies on
   * `navigator.credentials.create` / `.get`, which require a
   * visible, user-focused context. The current onboarding path
   * runs in the OFFSCREEN document (so it has IndexedDB +
   * DIDComm primitives), which is HIDDEN by design. WebAuthn
   * calls from there either reject with NotAllowedError or hang
   * indefinitely waiting for a user gesture that can never
   * arrive. So flipping the default to `true` (briefly tried in
   * #28) caused onboarding to lock up.
   *
   * The proper fix is a popup-driven enrol: offscreen completes
   * provision-integration → relays the seed to the popup over
   * the bridge → popup (visible) runs the WebAuthn ceremony +
   * encrypts the seed → returns the wrapped record → offscreen
   * stores it. That's queued as a follow-up; until it lands,
   * the operator can still opt in via the Settings page, but
   * the WebAuthn UI may not render correctly. Treat opt-in as
   * EXPERIMENTAL until the popup-driven path ships.
   *
   * **Existing wallets are unaffected** either way — the read
   * path dispatches on the stored record's `algorithm` tag, so
   * a wallet minted under any setting keeps loading via the
   * matching wrap.
   */
  encryptHolderSecret?: boolean;
}

const SETTINGS_KEY = "pnm/settings/v1";

/** Read the current settings, falling back to defaults for unset fields. */
export async function getSettings(): Promise<WalletSettings> {
  const s = await new IndexedDBKVStore().get<Partial<WalletSettings>>(SETTINGS_KEY);
  // `encryptHolderSecret` defaults to FALSE until the popup-driven
  // WebAuthn-enrol path lands — see the field's docblock for the
  // architectural constraint (offscreen + WebAuthn don't mix).
  // Explicit `true` / `false` round-trip as-is so an operator who
  // opted in (or out) via the Settings page keeps their choice.
  const encryptHolderSecret =
    typeof s?.encryptHolderSecret === "boolean" ? s.encryptHolderSecret : false;
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
