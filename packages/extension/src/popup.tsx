/// <reference types="chrome" />
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useConnectionStore } from "./store.js";
import {
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  type OnboardPrepareResult,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardPrepareResponse,
} from "./bridge-protocol.js";

const box: React.CSSProperties = { padding: 12, display: "grid", gap: 8 };
const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  wordBreak: "break-all",
};

// ─── Connected state ───
// Shown when the wallet has completed the onboarding swap for a VTA.
// Persisted via zustand so the state survives the popup closing.
function ConnectedView() {
  const connection = useConnectionStore((s) => s.connection)!;
  const clearConnection = useConnectionStore((s) => s.clearConnection);

  const transports = [
    connection.mediatorDid ? "DIDComm" : null,
    connection.restBaseUrl ? "REST" : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div style={box}>
      <h3 style={{ margin: 0 }}>Connected ✓</h3>
      <div style={{ fontSize: 12, color: "#555" }}>
        Your wallet is authorized at this VTA.
      </div>

      <div style={{ fontSize: 12, color: "#777" }}>VTA</div>
      <code style={mono}>{connection.vtaDid}</code>

      <div style={{ fontSize: 12, color: "#777" }}>Holder (your wallet DID)</div>
      <code style={mono}>{connection.holderDid}</code>

      <div style={{ fontSize: 12, color: "#777" }}>
        Role: <b>{connection.role}</b> &nbsp;·&nbsp; Transports: <b>{transports || "—"}</b>
      </div>

      <button onClick={clearConnection} style={{ marginTop: 8 }}>
        Disconnect (forget this VTA)
      </button>
      <small style={{ color: "#888" }}>
        Forgets the connection in this popup. Your wallet DID stays in the VTA&apos;s ACL until
        the operator revokes it (<code>pnm acl delete</code>).
      </small>
    </div>
  );
}

// ─── Onboarding ───
// Enter a VTA DID → wallet resolves transports + mints an ephemeral did:key →
// operator grants it with one printed command → wallet swaps the grant onto
// its long-term holder did:peer via `swap-acl`.
function OnboardView() {
  const setConnection = useConnectionStore((s) => s.setConnection);

  const [vtaDid, setVtaDid] = useState("");
  const [prep, setPrep] = useState<OnboardPrepareResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function prepare() {
    setBusy(true);
    setStatus(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_PREPARE,
        vtaDid: vtaDid.trim(),
      })) as RuntimeOnboardPrepareResponse;
      if (!res.ok) throw new Error(res.error);
      setPrep(res.result);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    setStatus(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_CONNECT,
      })) as RuntimeOnboardConnectResponse;
      if (!res.ok) throw new Error(res.error);
      setConnection({
        vtaDid: vtaDid.trim(),
        holderDid: res.result.holderDid,
        role: res.result.role,
        ...(prep?.restBaseUrl ? { restBaseUrl: prep.restBaseUrl } : {}),
        ...(prep?.mediatorDid ? { mediatorDid: prep.mediatorDid } : {}),
        connectedAt: Date.now(),
      });
      setPrep(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (prep) {
    return (
      <div style={box}>
        <h3 style={{ margin: 0 }}>Grant this wallet</h3>
        <small>
          Run this once as an existing admin (grants a one-time ephemeral key the wallet rotates
          away on connect):
        </small>
        <code style={{ ...mono, background: "#f3f4f6", padding: 8, borderRadius: 6 }}>
          {prep.command}
        </code>
        <button onClick={() => void navigator.clipboard.writeText(prep.command)}>
          Copy command
        </button>
        <small>
          Transport:{" "}
          {prep.mediatorDid ? "DIDComm (authcrypt)" : prep.restBaseUrl ? "REST" : "none"}
        </small>
        <button onClick={() => void connect()} disabled={busy}>
          {busy ? "Connecting…" : "I've granted it — Connect"}
        </button>
        <button onClick={() => setPrep(null)} disabled={busy}>
          Cancel
        </button>
        {status && <small style={{ color: "#c00" }}>{status}</small>}
      </div>
    );
  }

  return (
    <div style={box}>
      <h3 style={{ margin: 0 }}>Connect to a VTA</h3>
      <small>Enter the VTA&apos;s DID — the wallet resolves its endpoints for you.</small>
      <input
        placeholder="did:webvh:…"
        value={vtaDid}
        onChange={(e) => setVtaDid(e.target.value)}
        style={mono}
      />
      <button onClick={() => void prepare()} disabled={!vtaDid.trim() || busy}>
        {busy ? "Resolving…" : "Prepare"}
      </button>
      {status && <small style={{ color: "#c00" }}>{status}</small>}
    </div>
  );
}

function Popup() {
  const connection = useConnectionStore((s) => s.connection);
  return connection ? <ConnectedView /> : <OnboardView />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
