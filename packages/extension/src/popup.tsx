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

function Popup() {
  const connection = useConnectionStore((s) => s.connection);
  const setConnection = useConnectionStore((s) => s.setConnection);
  const clearConnection = useConnectionStore((s) => s.clearConnection);

  const [vtaUrl, setVtaUrl] = useState("");
  const [did, setDid] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function save() {
    setConnection({ vtaUrl, did, accessToken });
    setStatus("Connected.");
  }

  async function doEnroll() {
    if (!connection) return;
    setBusy(true);
    setStatus(null);
    const client = new VtaClient({
      baseUrl: connection.vtaUrl,
      accessToken: connection.accessToken,
    });
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
        enrollmentSubmitFromResult(
          connection.did,
          result,
          challenge.ceremonyId,
          label || undefined,
        ),
      );
      setStatus(`Enrolled ${submitted.verificationMethod.id}`);
    } catch (err) {
      const e = err as VtaClientError | Error;
      setStatus(
        e instanceof VtaClientError ? `${e.code}: ${e.message}` : (e.message ?? "error"),
      );
    } finally {
      setBusy(false);
    }
  }

  if (!connection) {
    return (
      <div style={{ padding: 12, display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Connect to VTA</h3>
        <input
          placeholder="VTA URL"
          value={vtaUrl}
          onChange={(e) => setVtaUrl(e.target.value)}
        />
        <input placeholder="DID" value={did} onChange={(e) => setDid(e.target.value)} />
        <input
          placeholder="Enrollment token"
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
        />
        <button onClick={save} disabled={!vtaUrl || !did || !accessToken}>
          Save
        </button>
        {status && <small>{status}</small>}
      </div>
    );
  }

  return (
    <div style={{ padding: 12, display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Enroll a passkey</h3>
      <small style={{ wordBreak: "break-all" }}>{connection.did}</small>
      <input
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button onClick={doEnroll} disabled={busy}>
        {busy ? "Working…" : "Enroll passkey"}
      </button>
      <button onClick={clearConnection}>Disconnect</button>
      {status && <small>{status}</small>}
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
