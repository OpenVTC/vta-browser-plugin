/// <reference types="chrome" />
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { clearHolderIdentity, IndexedDBKVStore, rewrapHolderSecret } from "@openvtc/pnm-core";
import { DEFAULT_WALLET_MEDIATOR_DID, getSettings, setSettings } from "./config.js";
import { readActiveHolderDid } from "./active-vta.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import { listTrustedSites, untrustOrigin, type TrustedSiteRecord } from "./trusted-sites.js";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  background: "#1a1d24",
  color: "#e6e8ee",
  border: "1px solid #2a2f3a",
  borderRadius: 6,
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
};
const labelStyle: React.CSSProperties = { fontSize: 13, color: "#9aa3b2", marginTop: 14 };

function Options() {
  // The mediator DID the existing holder was minted with — changing away from
  // this is what forces a re-mint.
  const [savedMediatorDid, setSavedMediatorDid] = useState(DEFAULT_WALLET_MEDIATOR_DID);
  const [mediatorDid, setMediatorDid] = useState("");
  const [vtaDid, setVtaDid] = useState("");
  const [vtaMediatorDid, setVtaMediatorDid] = useState("");
  const [holderDid, setHolderDid] = useState("");
  // H1: encryption state. Tracked separately from `WalletSettings` because
  // the actual setting flips only after the migration succeeds (auto-migrate
  // is one toggle = one tap = persisted state).
  const [encryptOn, setEncryptOn] = useState(false);
  const [encryptBusy, setEncryptBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trustedSites, setTrustedSites] = useState<TrustedSiteRecord[]>([]);

  useEffect(() => {
    void listTrustedSites().then(setTrustedSites);
  }, []);

  async function revokeSite(origin: string): Promise<void> {
    await untrustOrigin(origin);
    setTrustedSites(await listTrustedSites());
  }

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSavedMediatorDid(s.mediatorDid);
      setMediatorDid(s.mediatorDid);
      setVtaDid(s.defaultStepUpVtaDid ?? "");
      setVtaMediatorDid(s.defaultStepUpVtaMediatorDid ?? "");
      setEncryptOn(Boolean(s.encryptHolderSecret));
      // Multi-VTA: show the active VTA's holder DID. Read straight
      // from the persisted connection — no decryption needed for a
      // display string, and options runs in a context with no PRF
      // AES cache, so loading the holder would throw WalletLockedError
      // on encrypted wallets.
      setHolderDid((await readActiveHolderDid()) ?? "");
    })();
  }, []);

  const mediatorChanged = mediatorDid.trim() !== savedMediatorDid;

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
      const trimmedMediator = mediatorDid.trim() || DEFAULT_WALLET_MEDIATOR_DID;

      if (trimmedMediator !== savedMediatorDid) {
        const ok = window.confirm(
          "Changing the mediator DID mints a NEW wallet identity (a new did:peer). " +
            "Your current wallet DID will stop working until you re-grant the new DID " +
            "in every relying party's ACL.\n\nProceed and re-mint?",
        );
        if (!ok) {
          setBusy(false);
          return;
        }
        // Drop the persisted holder so the next load re-mints with the new
        // mediator baked into the did:peer service endpoint.
        await clearHolderIdentity(new IndexedDBKVStore());
      }

      await setSettings({
        mediatorDid: trimmedMediator,
        ...(vtaDid.trim() ? { defaultStepUpVtaDid: vtaDid.trim() } : {}),
        ...(vtaMediatorDid.trim() ? { defaultStepUpVtaMediatorDid: vtaMediatorDid.trim() } : {}),
      });
      setSavedMediatorDid(trimmedMediator);

      // Reflect the (possibly re-minted) holder DID — display-only,
      // read from the persisted connection.
      setHolderDid((await readActiveHolderDid()) ?? "");
      setStatus(
        trimmedMediator !== savedMediatorDid
          ? "Saved — wallet identity re-minted. Re-grant the new DID in your RP ACLs."
          : "Saved.",
      );
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>VTA Wallet · Settings</h1>
      <div style={{ fontSize: 13, color: "#9aa3b2" }}>
        Current wallet DID:{" "}
        <code style={{ wordBreak: "break-all", color: "#e6e8ee" }}>{holderDid || "—"}</code>
      </div>

      <label style={labelStyle}>Mediator DID (wallet inbox + DIDComm login)</label>
      <input style={inputStyle} value={mediatorDid} onChange={(e) => setMediatorDid(e.target.value)} />
      {mediatorChanged && (
        <small style={{ color: "#e0a64a", marginTop: 4 }}>
          ⚠ Changing this re-mints your wallet identity (new did:peer). You must re-grant the new
          DID in every RP&apos;s ACL.
        </small>
      )}

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

      <div
        style={{
          marginTop: 22,
          padding: 14,
          border: "1px solid #2a2f3a",
          borderRadius: 8,
          background: "#15181f",
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
          <label htmlFor="encryptHolderSecret" style={{ fontSize: 14, color: "#e6e8ee" }}>
            Encrypt wallet at rest (WebAuthn / passkey)
            {encryptBusy && (
              <span style={{ marginLeft: 8, color: "#9aa3b2", fontSize: 12 }}>working…</span>
            )}
          </label>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "#9aa3b2", lineHeight: 1.5 }}>
          Wraps the Ed25519 root secret with an AES key derived from a WebAuthn
          PRF credential on your authenticator (Touch ID, Windows Hello, FIDO2
          key). Without this, the secret lives plaintext in IndexedDB.
          <br />
          <strong style={{ color: "#e0a64a" }}>Trade-off:</strong> you&apos;ll tap your
          authenticator on each cold start (new browser session). Losing the
          authenticator without disabling first means losing the wallet — no
          recovery path. {encryptOn ? "Toggle off to revert." : ""}
        </div>
      </div>

      <div
        style={{
          marginTop: 22,
          padding: 14,
          border: "1px solid #2a2f3a",
          borderRadius: 8,
          background: "#15181f",
        }}
      >
        <div style={{ fontSize: 14, color: "#e6e8ee", marginBottom: 4 }}>Connected sites</div>
        <div style={{ fontSize: 12, color: "#9aa3b2", lineHeight: 1.5, marginBottom: 10 }}>
          Sites you ticked “Remember this site” for. A connected site can log in and read your
          vault entries without a prompt. Revoke any you no longer trust — the next request from
          that site will prompt again.
        </div>
        {trustedSites.length === 0 ? (
          <div style={{ fontSize: 12, color: "#6b7280" }}>No connected sites.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {trustedSites.map((s) => (
              <div
                key={s.origin}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid #2a2f3a",
                  borderRadius: 6,
                  background: "#11141a",
                }}
              >
                <code style={{ wordBreak: "break-all", color: "#e6e8ee", fontSize: 12 }}>
                  {s.origin}
                </code>
                <button
                  onClick={() => void revokeSite(s.origin)}
                  style={{
                    flex: "none",
                    padding: "5px 10px",
                    background: "transparent",
                    color: "#e0524a",
                    border: "1px solid #5a2a27",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={save}
        disabled={busy}
        style={{
          marginTop: 18,
          padding: "10px 16px",
          background: mediatorChanged ? "#7a4a18" : "#2d6cdf",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: busy ? "default" : "pointer",
          fontSize: 14,
          justifySelf: "start",
        }}
      >
        {busy ? "Working…" : mediatorChanged ? "Save & re-mint identity" : "Save settings"}
      </button>
      {status && (
        <small style={{ marginTop: 8, color: status.startsWith("Error") ? "#e0524a" : "#4ad07a" }}>
          {status}
        </small>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Options />
    </StrictMode>,
  );
}
