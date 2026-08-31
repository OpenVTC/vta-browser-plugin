/// <reference types="chrome" />
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApproverPrfSecretWrap,
  approverDid,
  clearHolderIdentity,
  IndexedDBKVStore,
  mintApproverIdentity,
  rewrapHolderSecret,
} from "@openvtc/pnm-core";
import { DEFAULT_WALLET_MEDIATOR_DID, getSettings, setSettings } from "./config.js";
import { base64url } from "@openvtc/vti-didcomm-js";
import { readActiveHolderDid, readActiveVtaDid } from "./active-vta.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import { runPrfUnlockCeremony } from "./webauthn-prf-unlock.js";
import {
  RUNTIME_APPROVER_STATE,
  RUNTIME_UNLOCK_APPROVER,
  type RuntimeApproverStateResponse,
  type RuntimeUnlockApproverResponse,
} from "./bridge-protocol.js";
import { AppShell } from "./app-shell.js";
import { sendToBackground } from "./send-message.js";
import { VaultPanel } from "./vault-panel.js";
import { releaseSelectAfterPointerChange } from "./select-wheel.js";
import "./theme.css";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  background: "var(--w-ground)",
  color: "var(--w-text)",
  border: "1px solid var(--w-line)",
  borderRadius: 6,
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
};
const labelStyle: React.CSSProperties = { fontSize: 13, color: "var(--w-muted)", marginTop: 14 };

export function AdvancedPane() {
  // The mediator DID the existing holder was minted with — changing away from
  // this is what forces a re-mint.
  const [vtaDid, setVtaDid] = useState("");
  const [vtaMediatorDid, setVtaMediatorDid] = useState("");
  // Additional enrolled executor DIDs (one per line) — executors beyond the
  // onboarded VTA(s) whose signed approval requests this wallet will render
  // (e.g. a did:webvh DID-hosting control plane).
  const [enrolledExecutors, setEnrolledExecutors] = useState("");
  const [pushGatewayUrl, setPushGatewayUrl] = useState("");
  const [pushGatewayVapidPublicKey, setPushGatewayVapidPublicKey] = useState("");
  const [holderDid, setHolderDid] = useState("");
  // H1: encryption state. Tracked separately from `WalletSettings` because
  // the actual setting flips only after the migration succeeds (auto-migrate
  // is one toggle = one tap = persisted state).
  const [encryptOn, setEncryptOn] = useState(false);
  const [encryptBusy, setEncryptBusy] = useState(false);
  const [preferTspOn, setPreferTspOn] = useState(false);
  // The co-located approver identity for the active VTA (Phase 2): its DID once
  // minted, so the operator can register it in the VTA's approver_set + ACL.
  const [approverDidValue, setApproverDidValue] = useState<string | null>(null);
  const [approverBusy, setApproverBusy] = useState(false);
  const [approverRunning, setApproverRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Trusted-site state moved into SitesPanel, which owns both permission
  // sources and refreshes itself from chrome.permissions events.

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setVtaDid(s.defaultStepUpVtaDid ?? "");
      setVtaMediatorDid(s.defaultStepUpVtaMediatorDid ?? "");
      setEnrolledExecutors((s.enrolledExecutorDids ?? []).join("\n"));
      setPushGatewayUrl(s.pushGatewayUrl ?? "");
      setPushGatewayVapidPublicKey(s.pushGatewayVapidPublicKey ?? "");
      setEncryptOn(Boolean(s.encryptHolderSecret));
      setPreferTspOn(Boolean(s.preferTsp));
      // Multi-VTA: show the active VTA's holder DID. Read straight
      // from the persisted connection — no decryption needed for a
      // display string, and options runs in a context with no PRF
      // AES cache, so loading the holder would throw WalletLockedError
      // on encrypted wallets.
      setHolderDid((await readActiveHolderDid()) ?? "");
      // Show the active VTA's approver DID if one has been minted (no key
      // material is touched — just the stored DID).
      const activeVta = await readActiveVtaDid();
      if (activeVta) {
        setApproverDidValue(await approverDid(new IndexedDBKVStore(), activeVta));
      }
    })();
  }, []);

  /**
   * Mint the co-located approver identity for the active VTA.
   *
   * Runs the WebAuthn PRF ceremony (so the approver seed is sealed behind the
   * same authenticator that encrypts the wallet, under its own key domain), then
   * mints a fresh did:key and stores it PRF-wrapped. The resulting DID is shown
   * so the operator can register it in the VTA's approver_set + ACL — the
   * approver only *confers* authority once the VTA knows it as a context admin.
   */
  async function createApprover(): Promise<void> {
    setApproverBusy(true);
    setStatus(null);
    try {
      const activeVta = await readActiveVtaDid();
      if (!activeVta) {
        setStatus("No active VTA — connect to a VTA first, then create the approver.");
        return;
      }
      // Reuse the wallet's enrolled authenticator to get a PRF output. A random
      // challenge is fine here: minting only needs the PRF bytes to derive the
      // approver KEK; the per-approval gesture (bound to the payload) happens at
      // decision time.
      const { prfOutput } = await runPrfUnlockCeremony(chrome.runtime.id);
      const store = new IndexedDBKVStore();
      const minted = await mintApproverIdentity(store, {
        vtaDid: activeVta,
        secretWrap: new ApproverPrfSecretWrap(prfOutput),
      });
      setApproverDidValue(minted.did);
      setStatus("Approver identity created. Register its DID in the VTA's approver set + ACL.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setApproverBusy(false);
    }
  }

  /**
   * Unlock the approver and bring up its inbox session, so it can receive
   * task-consent requests addressed to it. One biometric establishes the
   * session; each individual approval still requires its own gesture. Uses a
   * random-challenge unlock (the per-decision, digest-bound gesture happens in
   * the approval popup).
   */
  /** Re-read whether the approver's inbox is actually live. */
  const refreshApproverState = useCallback(async () => {
    const res = await sendToBackground<RuntimeApproverStateResponse>({
      type: RUNTIME_APPROVER_STATE,
    }).catch(() => null);
    if (res?.ok) {
      setApproverRunning(res.result.running);
      if (res.result.approverDid) setApproverDidValue(res.result.approverDid);
    }
  }, []);

  useEffect(() => {
    void refreshApproverState();
    // The offscreen document can be torn down at any point, taking the session
    // with it. Poll while this page is open rather than trusting one reading.
    const id = setInterval(() => void refreshApproverState(), 5000);
    return () => clearInterval(id);
  }, [refreshApproverState]);

  async function startApproving(): Promise<void> {
    setApproverBusy(true);
    setStatus(null);
    try {
      const activeVta = await readActiveVtaDid();
      if (!activeVta) {
        setStatus("No active VTA — connect first.");
        return;
      }
      const { prfOutput } = await runPrfUnlockCeremony(chrome.runtime.id);
      // sendToBackground rather than a bare sendMessage: an unanswered
      // message resolves undefined, and reading `.ok` off it produced
      // "Cannot read properties of undefined" — a TypeError that named none
      // of the actual causes.
      const res = await sendToBackground<RuntimeUnlockApproverResponse>({
        type: RUNTIME_UNLOCK_APPROVER,
        prfOutputB64u: base64url.encode(prfOutput),
        vtaDid: activeVta,
      });
      if (res.ok) {
        setStatus("Approver unlocked — its inbox is now listening for approvals.");
        await refreshApproverState();
      } else {
        setStatus(`Error: ${res.error}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setApproverBusy(false);
    }
  }


  /**
   * Auto-migrate the holder secret to the requested encryption
   * state. ON-flip prompts the operator for their authenticator
   * during enrollment; OFF-flip prompts during the unwrap. The
   * persisted `encryptHolderSecret` flag is only written after
   * the underlying re-wrap succeeds, so a cancelled or failed
   * passkey ceremony leaves the prior state intact.
   */
  async function toggleEncryption(next: boolean): Promise<void> {
    setEncryptBusy(true);
    setStatus(null);
    try {
      // Confirm before the OFF-flip — operators with an established
      // encrypted wallet need a clear "yes I want plaintext at rest"
      // moment before the secret goes back on disk unwrapped.
      if (!next && encryptOn) {
        const ok = window.confirm(
          "Disable wallet encryption?\n\n" +
            "Your Ed25519 root secret will be re-saved as plaintext. " +
            "Anyone with origin-scoped storage access (a malicious extension, " +
            "an XSS in this extension's pages, device-level exfil) can read it " +
            "without your authenticator.\n\nProceed?",
        );
        if (!ok) {
          setEncryptBusy(false);
          return;
        }
      }

      const wrap = new WebAuthnPrfSecretWrap(chrome.runtime.id);
      const store = new IndexedDBKVStore();

      if (next) {
        // Flip ON: re-persist the existing plaintext secret behind
        // the wrap. Triggers a WebAuthn enrollment ceremony.
        await rewrapHolderSecret(store, { toWrap: wrap });
        await setSettings({ encryptHolderSecret: true });
        setEncryptOn(true);
        setStatus(
          "Encryption enabled — tap your authenticator on each cold start to unlock the wallet.",
        );
      } else {
        // Flip OFF: unwrap with the existing wrap (triggers an
        // authenticator assertion to recover the AES key), then
        // re-persist plaintext. Clear the enrolled credential after
        // so a future re-enable doesn't trip the "credential already
        // enrolled" guard.
        await rewrapHolderSecret(store, { fromWrap: wrap });
        await WebAuthnPrfSecretWrap.unenroll();
        await setSettings({ encryptHolderSecret: false });
        setEncryptOn(false);
        setStatus("Encryption disabled — wallet secret re-saved as plaintext.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setEncryptBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      // `mediatorDid` is deliberately NOT written here. The inbox moved to the
      // Setup pane, which owns the re-mint confirmation that changing it
      // requires. Writing it from this form too would let a stale copy — read
      // when Advanced mounted — silently revert an inbox the user just changed
      // on the other pane, re-minting their identity as a side effect of
      // saving an unrelated setting.
      await setSettings({
        ...(vtaDid.trim() ? { defaultStepUpVtaDid: vtaDid.trim() } : {}),
        ...(vtaMediatorDid.trim() ? { defaultStepUpVtaMediatorDid: vtaMediatorDid.trim() } : {}),
        // Always written (an empty list is a valid state): un-enrolling an
        // executor must actually revoke it, not linger as a stale merge.
        enrolledExecutorDids: enrolledExecutors
          .split("\n")
          .map((d) => d.trim())
          .filter((d) => d.length > 0),
        ...(pushGatewayUrl.trim() ? { pushGatewayUrl: pushGatewayUrl.trim() } : {}),
        ...(pushGatewayVapidPublicKey.trim()
          ? { pushGatewayVapidPublicKey: pushGatewayVapidPublicKey.trim() }
          : {}),
      });
      setHolderDid((await readActiveHolderDid()) ?? "");
      setStatus("Saved.");
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>Advanced</h1>
      <div style={{ fontSize: 13, color: "var(--w-muted)", maxWidth: "64ch", lineHeight: 1.55 }}>
        Everything here is optional — the wallet works without any of it. Your inbox and the
        passkey lock live under <strong>Setup</strong>.
      </div>
      <div style={{ fontSize: 13, color: "var(--w-muted)", marginTop: 6 }}>
        Current wallet DID:{" "}
        <code style={{ wordBreak: "break-all", color: "var(--w-text)" }}>{holderDid || "—"}</code>
      </div>

      <label style={labelStyle}>Default step-up VTA DID (optional)</label>
      <input
        style={inputStyle}
        value={vtaDid}
        placeholder="did:webvh:…"
        onChange={(e) => setVtaDid(e.target.value)}
      />

      <label style={labelStyle}>Default step-up VTA mediator DID (optional)</label>
      <input
        style={inputStyle}
        value={vtaMediatorDid}
        placeholder="did:webvh:…"
        onChange={(e) => setVtaMediatorDid(e.target.value)}
      />

      <label style={labelStyle}>Enrolled executor DIDs (optional — one per line)</label>
      <textarea
        style={{ ...inputStyle, minHeight: 64, resize: "vertical" }}
        value={enrolledExecutors}
        placeholder={"did:webvh:… (e.g. a DID-hosting control plane)"}
        onChange={(e) => setEnrolledExecutors(e.target.value)}
      />
      <small style={{ color: "var(--w-muted)", marginTop: 4 }}>
        Executors beyond your onboarded VTA(s) whose signed approval requests (task consent,
        step-up) this wallet will render. Requests signed by anyone not enrolled are dropped
        without prompting.
      </small>

      <label style={labelStyle}>Push gateway URL (optional — Web Push test)</label>
      <input
        style={inputStyle}
        value={pushGatewayUrl}
        placeholder="https://gateway.example"
        onChange={(e) => setPushGatewayUrl(e.target.value)}
      />

      <label style={labelStyle}>Push gateway VAPID public key (optional)</label>
      <input
        style={inputStyle}
        value={pushGatewayVapidPublicKey}
        placeholder="base64url P-256 public key"
        onChange={(e) => setPushGatewayVapidPublicKey(e.target.value)}
      />
      <small style={{ color: "var(--w-muted)", marginTop: 4 }}>
        Set both to enable Web Push wake-up: the wallet subscribes with this VAPID key, registers
        with the gateway (<code>push/register</code>), and conveys the handle to the active VTA
        (<code>device/set-wake</code>). Leave blank to keep push off.
      </small>

      <div
        style={{
          marginTop: 22,
          padding: 14,
          border: "1px solid var(--w-line)",
          borderRadius: 8,
          background: "var(--w-surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            id="encryptHolderSecret"
            type="checkbox"
            checked={encryptOn}
            disabled={encryptBusy}
            onChange={(e) => void toggleEncryption(e.target.checked)}
            style={{ transform: "scale(1.2)" }}
          />
          <label htmlFor="encryptHolderSecret" style={{ fontSize: 14, color: "var(--w-text)" }}>
            Encrypt wallet at rest (WebAuthn / passkey)
            {encryptBusy && (
              <span style={{ marginLeft: 8, color: "var(--w-muted)", fontSize: 12 }}>working…</span>
            )}
          </label>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--w-muted)", lineHeight: 1.5 }}>
          Wraps the Ed25519 root secret with an AES key derived from a WebAuthn
          PRF credential on your authenticator (Touch ID, Windows Hello, FIDO2
          key). Without this, the secret lives plaintext in IndexedDB.
          <br />
          <strong>If you lose your passkey:</strong> you won&apos;t be able to unlock this
          wallet again, but nothing important is lost — your credentials are kept by your
          trust agent, not in this browser. You&apos;d set the wallet up again and reconnect,
          and the sites you use would need reconnecting too. You&apos;ll be asked for your
          passkey once per browser session.{" "}
          {encryptOn ? "Toggle off to revert." : ""}
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: 14,
          border: "1px solid var(--w-line)",
          borderRadius: 8,
          background: "var(--w-surface)",
        }}
      >
        {/* Neutral surface, not the danger palette. This panel describes a
            protective feature, and in its healthy state — approver created and
            listening — a red card contradicted the green "running" pill inside
            it. Red here also spends the one colour that should mean "something
            is wrong". */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span aria-hidden style={{ fontSize: 16 }}>
            🛡️
          </span>
          <strong style={{ fontSize: 14, color: "var(--w-text)" }}>
            Approver identity (biometric approval)
          </strong>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--w-muted)", lineHeight: 1.5 }}>
          A second, distinct identity this browser uses to <em>approve</em> tasks —
          separate from the working identity that <em>requests</em> them. Its
          signing key is released only by your authenticator, per approval. Create
          it here, then register the DID below in the VTA&apos;s
          {" "}<code>approver_set</code> and ACL (as a context admin) so its
          approvals confer authority.
        </div>
        {approverDidValue ? (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: "var(--w-ok)",
              lineHeight: 1.5,
              background: "var(--w-ok-soft)",
              border: "1px solid var(--w-ok-soft)",
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            {approverRunning ? (
              <>
                Listening. Approvals for tasks proposed on <em>other</em> devices reach you
                here, and a task started in this browser prompts you directly.
              </>
            ) : (
              <>
                Ready. A task started in this browser prompts you automatically. Unlock the
                wallet — or use the button below — to also receive approvals for tasks
                proposed on a <em>different</em> device.
              </>
            )}
          </div>
        ) : null}

        {approverDidValue ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: "var(--w-muted)", marginBottom: 4 }}>
              Approver DID (active VTA)
            </div>
            <code
              style={{
                display: "block",
                wordBreak: "break-all",
                color: "var(--w-accent)",
                background: "var(--w-accent-soft)",
                border: "1px solid var(--w-accent-soft)",
                borderRadius: 6,
                padding: "8px 10px",
                fontSize: 12,
              }}
            >
              {approverDidValue}
            </code>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(approverDidValue)}
                style={{
                  padding: "6px 12px",
                  background: "none",
                  color: "var(--w-accent)",
                  border: "1px solid var(--w-line)",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Copy DID
              </button>
              {/* State, not a button that always says the same thing. The
                  session is in-memory in the offscreen document, so it is
                  re-read rather than remembered — MV3 can evict it at any
                  moment, and a UI insisting the approver is up when it is not
                  means approval requests nobody ever sees. */}
              {approverRunning ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "6px 12px",
                    borderRadius: 999,
                    background: "var(--w-ok-soft)",
                    color: "var(--w-ok)",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <span aria-hidden>●</span> Approver is running
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void startApproving()}
                  disabled={approverBusy}
                  style={{
                    padding: "6px 14px",
                    background: "var(--w-accent)",
                    color: "var(--w-accent-ink)",
                    border: "none",
                    borderRadius: 6,
                    cursor: approverBusy ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 700,
                    opacity: approverBusy ? 0.6 : 1,
                  }}
                >
                  {approverBusy ? "Working…" : "Start approving (unlock)"}
                </button>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void createApprover()}
            disabled={approverBusy || !encryptOn}
            style={{
              marginTop: 12,
              padding: "9px 16px",
              background: encryptOn ? "var(--w-accent)" : "var(--w-raised)",
              color: "var(--w-accent-ink)",
              border: "none",
              borderRadius: 6,
              cursor: approverBusy || !encryptOn ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 700,
              opacity: approverBusy ? 0.6 : 1,
            }}
          >
            {approverBusy ? "Creating…" : "Create approver identity"}
          </button>
        )}
        {!encryptOn && !approverDidValue && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--w-warn)" }}>
            Enable “Encrypt wallet at rest” above first — it enrolls the
            authenticator the approver key reuses.
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 22,
          padding: 14,
          border: "1px solid var(--w-line)",
          borderRadius: 8,
          background: "var(--w-surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            id="preferTsp"
            type="checkbox"
            checked={preferTspOn}
            onChange={(e) => {
              const on = e.target.checked;
              setPreferTspOn(on);
              void setSettings({ preferTsp: on });
            }}
            style={{ transform: "scale(1.2)" }}
          />
          <label htmlFor="preferTsp" style={{ fontSize: 14, color: "var(--w-text)" }}>
            Prefer TSP transport
          </label>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--w-muted)", lineHeight: 1.5 }}>
          When a VTA advertises a <code>TSPTransport</code> service, route trust tasks over TSP
          first (TSP &gt; DIDComm &gt; REST). TSP shares the same mediator socket as DIDComm and
          falls back to DIDComm if it can&apos;t connect. <strong>On by default.</strong> Turn off
          to pin a VTA to DIDComm/REST if a particular mediator&apos;s TSP delivery misbehaves.
        </div>
      </div>

      <button
        onClick={save}
        disabled={busy}
        style={{
          marginTop: 18,
          padding: "10px 16px",
          background: "var(--w-accent)",
          color: "var(--w-accent-ink)",
          border: "none",
          borderRadius: 6,
          cursor: busy ? "default" : "pointer",
          fontSize: 14,
          justifySelf: "start",
        }}
      >
        {busy ? "Working…" : "Save settings"}
      </button>
      {status && (
        <small style={{ marginTop: 8, color: status.startsWith("Error") ? "var(--w-danger)" : "var(--w-ok)" }}>
          {status}
        </small>
      )}
    </div>
  );
}

function Wallet() {
  return <AppShell advanced={<AdvancedPane />} vault={<VaultPane />} />;
}

/** The Vault pane. VaultPanel carries its own heading and empty states, so
 *  this only supplies the surrounding page furniture. */
function VaultPane() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <VaultPanel />
    </div>
  );
}

// Chromium leaves the wheel pointed at a focused <select>; without this,
// picking an option kills scrolling over that control until the user
// clicks elsewhere. See src/select-wheel.ts.
releaseSelectAfterPointerChange(document);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Wallet />
    </StrictMode>,
  );
}
