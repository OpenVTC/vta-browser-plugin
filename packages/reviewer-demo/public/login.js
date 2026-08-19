// Login screen — two ways in, and they are not interchangeable.
//
// The key ID is the bootstrap: a reviewer needs it before the wallet is set up,
// because authorising the wallet is what the key ID lets them do. SIOPv2 is the
// flow under review, and only works once that has happened.

import {
  loadConfig,
  post,
  say,
  clear,
  withButton,
  walletPresent,
  trackWalletPresence,
} from "./shared.js";

const cfg = await loadConfig();

// ── key ID ──────────────────────────────────────────────────────────────────

document.getElementById("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clear("key-msg");
  return withButton("key-submit", async () => {
    const key = document.getElementById("key").value.trim();
    const res = await post("/api/login-key", { key });
    if (!res.ok) {
      say("key-msg", res.error ?? "Sign-in failed.", "err");
      return;
    }
    window.location.href = "/app";
  });
});

// ── SIOPv2 ──────────────────────────────────────────────────────────────────

const reflectWalletPresence = trackWalletPresence("siop-hint");

document.getElementById("siop-go").addEventListener("click", () => {
  clear("siop-msg");
  reflectWalletPresence();

  if (!walletPresent()) {
    say(
      "siop-msg",
      "No wallet on this page yet — enable it from the extension's popup, then try again.",
      "err",
    );
    return;
  }

  return withButton("siop-go", async () => {
    let result;
    try {
      // The wallet performs the SIOPv2 exchange against the demo agent and
      // hands back what the agent issued. Everything here arrived via the
      // browser, so the server spends the token against the agent before it
      // believes any of it.
      result = await window.vtaWallet.login({
        rpDid: cfg.vtaDid,
        baseUrl: cfg.vtaBaseUrl,
      });
    } catch (e) {
      say(
        "siop-msg",
        `The wallet did not complete the sign-in: ${e instanceof Error ? e.message : e}`,
        "err",
      );
      return;
    }

    const verified = await post("/api/login-siop", {
      accessToken: result.accessToken,
      sessionId: result.sessionId,
    });
    if (!verified.ok) {
      say("siop-msg", verified.error ?? "The demo agent would not confirm that sign-in.", "err");
      return;
    }
    say("siop-msg", `Signed in as ${verified.did}. Loading…`, "ok");
    window.location.href = "/app";
  });
});
