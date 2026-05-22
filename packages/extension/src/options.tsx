/// <reference types="chrome" />
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { clearHolderIdentity, IndexedDBKVStore } from "@pnm/core";
import { DEFAULT_WALLET_MEDIATOR_DID, getSettings, setSettings } from "./config.js";
import { loadHolder } from "./holder.js";

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
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSavedMediatorDid(s.mediatorDid);
      setMediatorDid(s.mediatorDid);
      setVtaDid(s.defaultStepUpVtaDid ?? "");
      setVtaMediatorDid(s.defaultStepUpVtaMediatorDid ?? "");
      const { signing } = await loadHolder();
      setHolderDid(signing.did);
    })();
  }, []);

  const mediatorChanged = mediatorDid.trim() !== savedMediatorDid;

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

      // Reflect the (possibly re-minted) holder DID.
      const { signing } = await loadHolder();
      setHolderDid(signing.did);
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
