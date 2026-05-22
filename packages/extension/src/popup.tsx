/// <reference types="chrome" />
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  enrollPasskey,
  enrollmentSubmitFromResult,
  base64urlToBytes,
  VtaClient,
  VtaClientError,
} from "@pnm/core";
import { useConnectionStore } from "./store.js";
import {
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  type OnboardPrepareResult,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardPrepareResponse,
} from "./bridge-protocol.js";

const box: React.CSSProperties = { padding: 12, display: "grid", gap: 8 };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: 11, wordBreak: "break-all" };

// ─── Onboarding: connect the wallet to a VTA by DID ───
// Enter a VTA DID → the wallet resolves its transports + mints an ephemeral
// did:key → the operator grants it with one command → the wallet connects as
// the ephemeral and swaps the ACL entry onto its long-term holder did:peer.
function Onboard() {
  const [vtaDid, setVtaDid] = useState("");
  const [prep, setPrep] = useState<OnboardPrepareResult | null>(null);
  const [connectedDid, setConnectedDid] = useState<string | null>(null);
  const [connectedRole, setConnectedRole] = useState<string | null>(null);
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
      setConnectedDid(res.result.holderDid);
      setConnectedRole(res.result.role);
      setPrep(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (connectedDid) {
    return (
      <div style={box}>
        <h3 style={{ margin: 0 }}>Connected ✓</h3>
        <small>Your wallet is now authorized at this VTA as:</small>
        <code style={mono}>{connectedDid}</code>
        <small>role: {connectedRole}</small>
        <button onClick={() => setConnectedDid(null)}>Connect another VTA</button>
      </div>
    );
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
        <button onClick={() => void navigator.clipboard.writeText(prep.command)}>Copy command</button>
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
      <small>Enter the VTA's DID — the wallet resolves its endpoints for you.</small>
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

// ─── Passkey enrollment (advanced / existing flow) ───
function EnrollPasskey() {
  const connection = useConnectionStore((s) => s.connection);
  const setConnection = useConnectionStore((s) => s.setConnection);
  const clearConnection = useConnectionStore((s) => s.clearConnection);

  const [vtaUrl, setVtaUrl] = useState("");
  const [did, setDid] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doEnroll() {
    if (!connection) return;
    setBusy(true);
    setStatus(null);
    const client = new VtaClient({ baseUrl: connection.vtaUrl, accessToken: connection.accessToken });
    try {
      const challenge = await client.requestEnrollmentChallenge(connection.did);
      const result = await enrollPasskey({
        challenge: base64urlToBytes(challenge.challenge),
        rp: { id: challenge.rpId, name: challenge.rpName },
        user: {
          id: base64urlToBytes(challenge.userHandle),
          name: challenge.userName,
          displayName: challenge.userDisplayName,
        },
        ...(challenge.timeoutMs !== undefined ? { timeout: challenge.timeoutMs } : {}),
      });
      const submitted = await client.submitPasskeyEnrollment(
        enrollmentSubmitFromResult(connection.did, result, challenge.ceremonyId, label || undefined),
      );
      setStatus(`Enrolled ${submitted.verificationMethod.id}`);
    } catch (err) {
      const e = err as VtaClientError | Error;
      setStatus(e instanceof VtaClientError ? `${e.code}: ${e.message}` : (e.message ?? "error"));
    } finally {
      setBusy(false);
    }
  }

  if (!connection) {
    return (
      <div style={box}>
        <input placeholder="VTA URL" value={vtaUrl} onChange={(e) => setVtaUrl(e.target.value)} />
        <input placeholder="DID" value={did} onChange={(e) => setDid(e.target.value)} />
        <input
          placeholder="Enrollment token"
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
        />
        <button
          onClick={() => {
            setConnection({ vtaUrl, did, accessToken });
            setStatus("Connected.");
          }}
          disabled={!vtaUrl || !did || !accessToken}
        >
          Save
        </button>
        {status && <small>{status}</small>}
      </div>
    );
  }

  return (
    <div style={box}>
      <small style={mono}>{connection.did}</small>
      <input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button onClick={() => void doEnroll()} disabled={busy}>
        {busy ? "Working…" : "Enroll passkey"}
      </button>
      <button onClick={clearConnection}>Disconnect</button>
      {status && <small>{status}</small>}
    </div>
  );
}

function Popup() {
  const [showEnroll, setShowEnroll] = useState(false);
  return (
    <div>
      <Onboard />
      <div style={{ padding: "0 12px 12px" }}>
        <button
          style={{ background: "none", border: "none", color: "#2d6cdf", cursor: "pointer", padding: 0, fontSize: 12 }}
          onClick={() => setShowEnroll((v) => !v)}
        >
          {showEnroll ? "▾ Hide passkey enrollment" : "▸ Enroll a passkey (advanced)"}
        </button>
      </div>
      {showEnroll && <EnrollPasskey />}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
