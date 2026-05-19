import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useConnectionStore } from "../store.js";

export function Connect() {
  const setConnection = useConnectionStore((s) => s.setConnection);
  const existing = useConnectionStore((s) => s.connection);
  const navigate = useNavigate();

  const [vtaUrl, setVtaUrl] = useState(existing?.vtaUrl ?? "");
  const [did, setDid] = useState(existing?.did ?? "");
  const [accessToken, setAccessToken] = useState(existing?.accessToken ?? "");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const parsed = new URL(vtaUrl);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
        setError("VTA URL must be https:// (or http://localhost for dev)");
        return;
      }
    } catch {
      setError("VTA URL is not a valid URL");
      return;
    }
    if (!did.startsWith("did:")) {
      setError("DID must start with did:");
      return;
    }
    if (accessToken.length < 16) {
      setError("Access token looks too short");
      return;
    }
    setConnection({ vtaUrl, did, accessToken });
    navigate("/passkeys");
  }

  return (
    <section className="card">
      <h2>Connect to a VTA</h2>
      <p className="muted">
        Paste a short-lived enrollment token from <code>pnm passkey-enroll-token</code>.
        The token is stored only in this browser and used to call your VTA over HTTPS.
      </p>
      <form onSubmit={onSubmit} className="form">
        <label>
          VTA URL
          <input
            value={vtaUrl}
            onChange={(e) => setVtaUrl(e.target.value)}
            placeholder="https://vta.example.com"
            autoComplete="off"
          />
        </label>
        <label>
          DID
          <input
            value={did}
            onChange={(e) => setDid(e.target.value)}
            placeholder="did:webvh:example.com:abc..."
            autoComplete="off"
          />
        </label>
        <label>
          Enrollment token
          <input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="paste token here"
            autoComplete="off"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary">
          Continue
        </button>
      </form>
    </section>
  );
}
