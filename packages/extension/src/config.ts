/// <reference types="chrome" />

// Wallet configuration, persisted in `chrome.storage.local` (shared across
// the service worker, offscreen doc, popup, and options page — all the same
// extension origin).
//
// The mediator DID is the load-bearing setting: it's baked into the holder's
// `did:peer:2` service endpoint at first mint, so changing it mints a NEW
// wallet DID (which must be re-granted in every RP's ACL). The options page
// is responsible for warning + forcing a re-mint when it changes; reading the
// config here never re-mints on its own.

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
}

const SETTINGS_KEY = "pnm/settings/v1";

/** Read the current settings, falling back to defaults for unset fields. */
export async function getSettings(): Promise<WalletSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const s = stored[SETTINGS_KEY] as Partial<WalletSettings> | undefined;
  return {
    mediatorDid: s?.mediatorDid || DEFAULT_WALLET_MEDIATOR_DID,
    ...(s?.defaultStepUpVtaDid ? { defaultStepUpVtaDid: s.defaultStepUpVtaDid } : {}),
    ...(s?.defaultStepUpVtaMediatorDid
      ? { defaultStepUpVtaMediatorDid: s.defaultStepUpVtaMediatorDid }
      : {}),
  };
}

/** Merge a partial update into the stored settings. */
export async function setSettings(patch: Partial<WalletSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}
