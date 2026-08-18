// The walkthrough page: paste the command, authorise, and (optionally) put the
// demo agent back to a known state.

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

document.getElementById("signed-in-as").textContent =
  cfg.signedInVia === "siop"
    ? `Signed in with your wallet as ${cfg.signedInAs ?? "an unknown DID"}.`
    : "Signed in with the reviewer key ID.";

document.getElementById("reset-card").hidden = !cfg.resetEnabled;

// ── authorise a wallet ──────────────────────────────────────────────────────

document.getElementById("acl-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clear("acl-msg");
  return withButton("acl-submit", async () => {
    const command = document.getElementById("command").value;
    const res = await post("/api/acl", { command });
    if (!res.ok) {
      say("acl-msg", res.error ?? "That did not work.", "err");
      return;
    }
    say(
      "acl-msg",
      `Authorised. ${res.did} may connect as ${res.role} for the next ${res.expires}. ` +
        `Go back to the wallet and click Connect.`,
      "ok",
    );
  });
});

// ── reset ───────────────────────────────────────────────────────────────────

document.getElementById("reset-go")?.addEventListener("click", () => {
  clear("reset-msg");
  // A reset disconnects every wallet already set up against this agent, so it
  // asks first. `confirm` is the right amount of ceremony for a demo — the
  // damage it can do is bounded by the demo itself.
  const proceed = window.confirm(
    "Reset the demo agent? This clears its login profiles and contexts. " +
      "Any wallet already connected to it will have to be set up again from step 1.",
  );
  if (!proceed) return;

  return withButton("reset-go", async () => {
    const res = await post("/api/reset", {});
    if (!res.ok) {
      say("reset-msg", res.error ?? "The reset did not complete.", "err");
      return;
    }
    say(
      "reset-msg",
      "The demo agent is back to its starting state. Start from step 1 — your wallet will need " +
        "authorising again.",
      "ok",
    );
  });
});

// ── the approval prompt ─────────────────────────────────────────────────────

const reflectWalletPresence = trackWalletPresence("task-hint");

document.getElementById("task-go").addEventListener("click", () => {
  clear("task-msg");
  reflectWalletPresence();

  if (!walletPresent()) {
    say(
      "task-msg",
      "No wallet on this page yet — enable it from the extension's popup, then try again.",
      "err",
    );
    return;
  }

  return withButton("task-go", async () => {
    let result;
    try {
      // A relying party proposes a task type and a payload, and nothing else.
      // It does not get to say what the task will do or how the prompt reads —
      // that is the whole design, and the reason this page cannot make the
      // prompt say anything flattering about itself.
      result = await window.vtaWallet.requestTask({
        type: cfg.demoTaskType,
        payload: {},
      });
    } catch (e) {
      // A denial arrives here, and for this demo that is a pass, not a
      // failure: the page learns only that it was refused.
      const message = e instanceof Error ? e.message : String(e);
      say(
        "task-msg",
        `Refused: ${message} — which is the point. The page is told nothing except that you said no.`,
        "ok",
      );
      return;
    }

    // A task the agent's policy gates comes back as a `requireConsent` result
    // rather than a thrown error: it carries the digest an approver must match
    // on their own device. Name it, rather than rendering it as a bare object.
    const gated =
      result && typeof result === "object" && "requireConsent" in result
        ? result.requireConsent
        : null;
    if (gated) {
      say(
        "task-msg",
        "Your agent will not act on this without a second approval, from an approver device — " +
          "this reply carries the digest that approver has to match. Nothing has happened yet.",
        "ok",
      );
      return;
    }

    say(
      "task-msg",
      `Approved, and your agent carried it out. It replied: ${JSON.stringify(result).slice(0, 400)}`,
      "ok",
    );
  });
});

// ── sign out ────────────────────────────────────────────────────────────────

document.getElementById("logout").addEventListener("click", async () => {
  await post("/api/logout", {});
  window.location.href = "/";
});
