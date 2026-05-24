/// <reference types="chrome" />

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RUNTIME_CONSENT_RESULT } from "./bridge-protocol.js";

// Consent prompt shown in a popup window before the wallet logs into an RP.
// The background opens it with the request details as query params and
// awaits a RUNTIME_CONSENT_RESULT message keyed by `cid`.

const params = new URLSearchParams(window.location.search);
const consentId = params.get("cid") ?? "";
const origin = params.get("origin") ?? "(unknown site)";
const rpDid = params.get("rpDid") ?? "(unknown RP)";
const holderDid = params.get("holder");
// When present, this prompt is an RP-initiated action to confirm (inbound),
// not an outbound login.
const action = params.get("action");
// M5: when set, the rpDid this origin previously used. Render a
// louder warning so the operator sees the swap and decides
// whether to approve it.
const changedFromRpDid = params.get("changedFrom");

function decide(approved: boolean): void {
  chrome.runtime.sendMessage({ type: RUNTIME_CONSENT_RESULT, consentId, approved });
  window.close();
}

function Confirm() {
  return (
    <div style={{ padding: 16, fontSize: 14, lineHeight: 1.4 }}>
      <h3 style={{ margin: "0 0 12px" }}>{action ? "Confirmation request" : "Login request"}</h3>
      {changedFromRpDid && (
        <div
          role="alert"
          style={{
            border: "2px solid #c0392b",
            background: "#fdecea",
            color: "#7a1a13",
            padding: 12,
            margin: "0 0 12px",
            borderRadius: 4,
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            ⚠ Relying-party identity changed
          </strong>
          <div style={{ marginBottom: 6 }}>
            <strong>{origin}</strong> previously asked you to sign in to a different RP. Verify
            the new RP is correct before approving.
          </div>
          <div style={{ color: "#666", fontSize: 12 }}>Previously:</div>
          <div style={{ wordBreak: "break-all", fontSize: 12 }}>{changedFromRpDid}</div>
        </div>
      )}
      <p style={{ margin: "0 0 12px" }}>
        {action ? (
          <>
            The relying party is asking you to confirm: <strong>{action}</strong>
          </>
        ) : (
          <>
            <strong>{origin}</strong> wants you to sign in.
          </>
        )}
      </p>
      <dl style={{ margin: "0 0 16px" }}>
        <dt style={{ color: "#666" }}>Relying party</dt>
        <dd style={{ margin: "0 0 8px", wordBreak: "break-all" }}>{rpDid}</dd>
        {holderDid && (
          <>
            <dt style={{ color: "#666" }}>{action ? "As" : "Sign in as"}</dt>
            <dd style={{ margin: 0, wordBreak: "break-all" }}>{holderDid}</dd>
          </>
        )}
      </dl>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => decide(true)} style={{ flex: 1, padding: "8px 0" }}>
          Approve
        </button>
        <button onClick={() => decide(false)} style={{ flex: 1, padding: "8px 0" }}>
          Deny
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Confirm />
    </StrictMode>,
  );
}
