/// <reference types="chrome" />

// Reserved for future RP interception: SIOPv2 / OpenID4VP handlers,
// passkey-assertion → DID-authentication translation, etc. The
// service worker has no responsibilities in the first milestone —
// enrollment runs entirely in the popup.

chrome.runtime.onInstalled.addListener(() => {
  console.info("[pnm] extension installed");
});

export {};
