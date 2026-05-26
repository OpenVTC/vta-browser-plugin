/// <reference types="chrome" />
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useConnectionStore } from "./store.js";
import {
  RUNTIME_LOCK_WALLET,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_VAULT_LIST,
  type OnboardPrepareResult,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardPrepareResponse,
  type RuntimeVaultListResponse,
  type VaultEntryView,
} from "./bridge-protocol.js";
import { getSettings } from "./config.js";

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
  const [encryptOn, setEncryptOn] = useState(false);
  const [lockStatus, setLockStatus] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setEncryptOn(Boolean(s.encryptHolderSecret));
    })();
  }, []);

  async function lockWallet(): Promise<void> {
    setLockBusy(true);
    setLockStatus(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: RUNTIME_LOCK_WALLET });
      if (!res?.ok) throw new Error(res?.error ?? "lock failed");
      setLockStatus("Locked — next operation re-prompts your authenticator.");
    } catch (e) {
      setLockStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLockBusy(false);
    }
  }

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

      {encryptOn && (
        <>
          <button onClick={() => void lockWallet()} disabled={lockBusy} style={{ marginTop: 8 }}>
            {lockBusy ? "Locking…" : "🔒 Lock wallet"}
          </button>
          {lockStatus && (
            <small style={{ color: lockStatus.startsWith("Error") ? "#c00" : "#3a7" }}>
              {lockStatus}
            </small>
          )}
          <small style={{ color: "#888" }}>
            Clears the in-memory key so the next operation re-prompts your
            authenticator. The wallet identity isn&apos;t forgotten — the locked
            state survives until a successful unlock OR a browser restart.
          </small>
        </>
      )}

      <VaultPanel />

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

// ─── Vault panel (M1) ───
// Read-only enumeration of the connected VTA's vault entries via
// `vault/list/0.1`. No edit, no release, no creation — those land in M2+.
// Validates the wire-shape end-to-end against the VTA's trust-task dispatcher.
function VaultPanel() {
  const [entries, setEntries] = useState<VaultEntryView[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadVault() {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_VAULT_LIST,
      })) as RuntimeVaultListResponse;
      if (!res.ok) throw new Error(res.error);
      setEntries(res.result.entries);
      setTruncated(res.result.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12, padding: 8, background: "#fafafa", borderRadius: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>Vault</strong>
        <button onClick={() => void loadVault()} disabled={busy} style={{ fontSize: 11 }}>
          {busy ? "Loading…" : entries ? "Refresh" : "Load entries"}
        </button>
      </div>
      {error && (
        <small style={{ color: "#c00", display: "block", marginTop: 6 }}>{error}</small>
      )}
      {entries && entries.length === 0 && (
        <small style={{ color: "#888", display: "block", marginTop: 6 }}>
          No vault entries yet. Add one with the VTA&apos;s CLI (M1 is read-only;
          upsert lands in M2).
        </small>
      )}
      {entries && entries.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0 0" }}>
          {entries.map((e) => (
            <li
              key={e.id}
              style={{
                padding: "6px 0",
                borderTop: "1px solid #eee",
                display: "grid",
                gap: 2,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{e.label}</div>
              <div style={{ fontSize: 11, color: "#555" }}>
                <SecretKindBadge kind={e.secretKind} />
                {" · "}
                <span style={mono}>{summariseTargets(e.targets)}</span>
              </div>
              <div style={{ fontSize: 10, color: "#888" }}>
                ctx: <code style={mono}>{e.contextId}</code>
                {e.lastUsedAt && <> · last used {formatDate(e.lastUsedAt)}</>}
                {e.breachedAt && (
                  <>
                    {" · "}
                    <span style={{ color: "#c00" }}>⚠ breached</span>
                  </>
                )}
              </div>
            </li>
          ))}
          {truncated && (
            <li style={{ padding: "6px 0", fontSize: 11, color: "#888" }}>
              … truncated. M1 returns a single page; pagination lands in M2.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function SecretKindBadge({ kind }: { kind: string }): React.JSX.Element {
  const colour =
    kind === "password"
      ? "#4a6"
      : kind === "passkey"
        ? "#46a"
        : kind === "oauth-tokens"
          ? "#a64"
          : "#777";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        background: colour,
        color: "#fff",
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
      }}
    >
      {kind}
    </span>
  );
}

function summariseTargets(targets: VaultEntryView["targets"]): string {
  if (targets.length === 0) return "—";
  const first = targets[0];
  if (!first) return "—";
  const rest = targets.length > 1 ? ` (+${targets.length - 1})` : "";
  switch (first.kind) {
    case "web-origin":
      return first.origin + rest;
    case "did":
      return first.did + rest;
    case "ios-app":
      return `ios:${first.bundleId}${rest}`;
    case "android-app":
      return `android:${first.packageName}${rest}`;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
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
