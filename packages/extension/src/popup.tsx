/// <reference types="chrome" />
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useConnectionStore } from "./store.js";
import {
  RUNTIME_LOCK_WALLET,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_VAULT_DELETE,
  RUNTIME_VAULT_LIST,
  RUNTIME_VAULT_PROXY_LOGIN,
  RUNTIME_VAULT_RELEASE,
  RUNTIME_VAULT_UPSERT,
  type OnboardPrepareResult,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardPrepareResponse,
  type RuntimeVaultDeleteResponse,
  type RuntimeVaultListResponse,
  type RuntimeVaultProxyLoginResponse,
  type RuntimeVaultReleaseResponse,
  type RuntimeVaultUpsertResponse,
  type SessionBlobView,
  type VaultEntryView,
  type VaultSecretView,
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

// ─── Vault panel (M1 read + M2A.6 write) ───
// List, add, delete, reveal entries against the connected VTA via the
// canonical vault/{list,upsert,delete,release}/0.1 Trust Tasks.
//
// Secret material: round-trips as DIDComm authcrypt JWE. The popup
// receives cleartext only from RUNTIME_VAULT_RELEASE responses and
// holds it in component state for `ttlSeconds`. After TTL expires the
// state is wiped — the popup never persists secret bytes (no chrome.storage,
// no IndexedDB, no service worker; the React component scope IS the lifetime).
function VaultPanel() {
  const [entries, setEntries] = useState<VaultEntryView[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // M2A.6 write surface
  const [adding, setAdding] = useState(false);

  // Per-row reveal state. Holds the cleartext secret + when it expires
  // (Date.now() ms). A countdown timer wipes the state at expiry.
  const [revealed, setRevealed] = useState<{
    entryId: string;
    secret: VaultSecretView;
    expiresAtMs: number;
  } | null>(null);

  // Per-row proxy-login state (M2B.3). Holds the cleartext SessionBlob
  // + when it expires (Date.now() ms). Auto-wiped at TTL via the same
  // countdown pattern as `revealed`. The SessionBlob is small but its
  // headers carry the SIOP id_token; treating it like a release secret
  // (in-memory only, wipe at TTL) is the right discipline.
  const [usedSession, setUsedSession] = useState<{
    entryId: string;
    sessionBlob: SessionBlobView;
    expiresAtMs: number;
  } | null>(null);

  // M2A.7 context filter
  const [contextFilter, setContextFilter] = useState<"all" | string>("all");

  // TTL countdown timer for revealed secret. Re-runs whenever `revealed`
  // changes; clears itself on unmount or when revealed is cleared.
  useEffect(() => {
    if (!revealed) return;
    const remaining = revealed.expiresAtMs - Date.now();
    if (remaining <= 0) {
      setRevealed(null);
      return;
    }
    const t = setTimeout(() => setRevealed(null), remaining);
    return () => clearTimeout(t);
  }, [revealed]);

  // TTL countdown timer for the used session — same shape as the
  // reveal timer.
  useEffect(() => {
    if (!usedSession) return;
    const remaining = usedSession.expiresAtMs - Date.now();
    if (remaining <= 0) {
      setUsedSession(null);
      return;
    }
    const t = setTimeout(() => setUsedSession(null), remaining);
    return () => clearTimeout(t);
  }, [usedSession]);

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

  async function deleteEntry(entry: VaultEntryView) {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_VAULT_DELETE,
        id: entry.id,
        expectedVersion: entry.version,
      })) as RuntimeVaultDeleteResponse;
      if (!res.ok) throw new Error(res.error);
      // Reload — cheaper than splicing the array in place and avoids
      // the (low-probability) "another wallet just modified this" race.
      await loadVault();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revealEntry(entry: VaultEntryView) {
    // Hide any previously-revealed secret first.
    setRevealed(null);
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_VAULT_RELEASE,
        entryId: entry.id,
      })) as RuntimeVaultReleaseResponse;
      if (!res.ok) throw new Error(res.error);
      setRevealed({
        entryId: entry.id,
        secret: res.result.secret,
        expiresAtMs: Date.now() + res.result.ttlSeconds * 1000,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // M2B.3 — proxy-login (the "Use" button). VTA logs in on the
  // holder's behalf and returns a SessionBlob (cookies / headers /
  // id_token). The popup holds the SessionBlob in memory only for the
  // server-declared TTL and shows a redacted preview so the user can
  // confirm the session was minted; full integration (header injection
  // via declarativeNetRequest) lands in a follow-up that builds on the
  // M2B.4 demo.
  async function useEntry(entry: VaultEntryView) {
    // Hide any previously-used session or reveal — switching to a new
    // entry should wipe the prior in-memory material immediately.
    setUsedSession(null);
    setRevealed(null);
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_VAULT_PROXY_LOGIN,
        entryId: entry.id,
      })) as RuntimeVaultProxyLoginResponse;
      if (!res.ok) throw new Error(res.error);
      // Trust the server-declared expiresAt — it's the authoritative
      // wipe deadline. `Date.parse` returns NaN on malformed strings;
      // fall back to a defensive 60 s if so (better than a setTimeout
      // with NaN that resolves immediately).
      const parsed = Date.parse(res.result.expiresAt);
      const expiresAtMs = Number.isFinite(parsed) ? parsed : Date.now() + 60_000;
      setUsedSession({
        entryId: entry.id,
        sessionBlob: res.result.sessionBlob,
        expiresAtMs,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Visible entries after applying the context filter.
  const visibleEntries = entries
    ? contextFilter === "all"
      ? entries
      : entries.filter((e) => e.contextId === contextFilter)
    : null;

  // Distinct contexts found in the loaded entries — drives the filter
  // dropdown. Empty until entries load.
  const distinctContexts = entries
    ? Array.from(new Set(entries.map((e) => e.contextId))).sort()
    : [];

  return (
    <div style={{ marginTop: 12, padding: 8, background: "#fafafa", borderRadius: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>Vault</strong>
        <div style={{ display: "flex", gap: 6 }}>
          {entries && entries.length > 0 && (
            <button
              onClick={() => setAdding((s) => !s)}
              disabled={busy}
              style={{ fontSize: 11 }}
            >
              {adding ? "Cancel" : "+ Add"}
            </button>
          )}
          <button onClick={() => void loadVault()} disabled={busy} style={{ fontSize: 11 }}>
            {busy ? "…" : entries ? "Refresh" : "Load entries"}
          </button>
        </div>
      </div>

      {entries && distinctContexts.length > 1 && (
        <div style={{ marginTop: 6, fontSize: 11 }}>
          <label style={{ color: "#777" }}>Context: </label>
          <select
            value={contextFilter}
            onChange={(e) => setContextFilter(e.target.value)}
            style={{ fontSize: 11 }}
          >
            <option value="all">All ({entries.length})</option>
            {distinctContexts.map((ctx) => {
              const count = entries.filter((e) => e.contextId === ctx).length;
              return (
                <option key={ctx} value={ctx}>
                  {ctx} ({count})
                </option>
              );
            })}
          </select>
        </div>
      )}

      {adding && (
        <AddEntryForm
          contexts={distinctContexts}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (form) => {
            setBusy(true);
            setError(null);
            try {
              const res = (await chrome.runtime.sendMessage({
                type: RUNTIME_VAULT_UPSERT,
                contextId: form.contextId,
                targets: [{ kind: "web-origin" as const, origin: form.origin }],
                label: form.label,
                secretKind: "password",
                secret: {
                  kind: "password",
                  username: form.username || undefined,
                  password: form.password,
                  ...(form.notes ? { secureNotes: form.notes } : {}),
                },
              })) as RuntimeVaultUpsertResponse;
              if (!res.ok) throw new Error(res.error);
              setAdding(false);
              await loadVault();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {error && (
        <small style={{ color: "#c00", display: "block", marginTop: 6 }}>{error}</small>
      )}
      {entries && entries.length === 0 && (
        <div style={{ marginTop: 6 }}>
          <small style={{ color: "#888", display: "block" }}>
            No vault entries yet.
          </small>
          <button
            onClick={() => setAdding(true)}
            style={{ marginTop: 6, fontSize: 11 }}
          >
            + Add your first entry
          </button>
        </div>
      )}
      {visibleEntries && visibleEntries.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0 0" }}>
          {visibleEntries.map((e) => (
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
                <ContextChip ctx={e.contextId} />
                {e.lastUsedAt && <> · last used {formatDate(e.lastUsedAt)}</>}
                {e.breachedAt && (
                  <>
                    {" · "}
                    <span style={{ color: "#c00" }}>⚠ breached</span>
                  </>
                )}
              </div>
              {revealed?.entryId === e.id ? (
                <RevealedSecretView
                  secret={revealed.secret}
                  expiresAtMs={revealed.expiresAtMs}
                  onDismiss={() => setRevealed(null)}
                />
              ) : usedSession?.entryId === e.id ? (
                <UsedSessionView
                  sessionBlob={usedSession.sessionBlob}
                  expiresAtMs={usedSession.expiresAtMs}
                  onDismiss={() => setUsedSession(null)}
                />
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {e.secretKind === "did-self-issued" && (
                    <button
                      onClick={() => void useEntry(e)}
                      disabled={busy}
                      style={{ fontSize: 11 }}
                      title="VTA logs in on your behalf — long-term key never leaves the VTA"
                    >
                      🔑 Use
                    </button>
                  )}
                  <button
                    onClick={() => void revealEntry(e)}
                    disabled={busy}
                    style={{ fontSize: 11 }}
                  >
                    🔓 Reveal
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete "${e.label}"? This cannot be undone.`)) {
                        void deleteEntry(e);
                      }
                    }}
                    disabled={busy}
                    style={{ fontSize: 11, color: "#c00" }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
          {truncated && (
            <li style={{ padding: "6px 0", fontSize: 11, color: "#888" }}>
              … truncated. Pagination lands when the vault grows past ~100 entries.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ─── Add-entry form (M2A.6) ───
// M2A.6 ships Password kind only — the most common case. Other kinds
// (Passkey, OAuth, BearerToken, Custom) follow when there's a UX
// pattern for them; for now the canonical schema + the @pnm/core
// vaultUpsertRest helper accept all eight kinds.
function AddEntryForm({
  contexts,
  busy,
  onCancel,
  onSubmit,
}: {
  contexts: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (form: {
    label: string;
    contextId: string;
    origin: string;
    username: string;
    password: string;
    notes: string;
  }) => Promise<void>;
}): React.JSX.Element {
  const [label, setLabel] = useState("");
  const [contextId, setContextId] = useState(contexts[0] ?? "");
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const valid = label.trim() && contextId.trim() && origin.trim() && password.length > 0;

  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        background: "#fff",
        border: "1px solid #ddd",
        borderRadius: 4,
        display: "grid",
        gap: 6,
        fontSize: 11,
      }}
    >
      <strong style={{ fontSize: 12 }}>New password</strong>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Work GitHub"
        />
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Context</span>
        {contexts.length > 0 ? (
          <input
            value={contextId}
            onChange={(e) => setContextId(e.target.value)}
            list="known-contexts"
            placeholder="ctx_…"
            style={mono}
          />
        ) : (
          <input
            value={contextId}
            onChange={(e) => setContextId(e.target.value)}
            placeholder="ctx_…"
            style={mono}
          />
        )}
        <datalist id="known-contexts">
          {contexts.map((ctx) => (
            <option key={ctx} value={ctx} />
          ))}
        </datalist>
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Site origin</span>
        <input
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder="https://github.com"
          style={mono}
        />
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Username</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Password</span>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            style={{ fontSize: 10 }}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Notes (optional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          onClick={() =>
            void onSubmit({ label, contextId, origin, username, password, notes })
          }
          disabled={!valid || busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Revealed-secret view (M2A.6) ───
// Inline display of the cleartext secret post-release. Includes a
// countdown showing how many seconds remain until the parent auto-wipes
// the secret from state.
function RevealedSecretView({
  secret,
  expiresAtMs,
  onDismiss,
}: {
  secret: VaultSecretView;
  expiresAtMs: number;
  onDismiss: () => void;
}): React.JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000)),
  );
  useEffect(() => {
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
      setSecondsLeft(left);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAtMs]);

  return (
    <div
      style={{
        marginTop: 4,
        padding: 6,
        background: "#fff7e6",
        border: "1px solid #f0d090",
        borderRadius: 4,
        display: "grid",
        gap: 4,
        fontSize: 11,
      }}
    >
      {secret.kind === "password" && (
        <>
          {secret.username && (
            <div>
              <span style={{ color: "#666" }}>Username:</span>{" "}
              <code style={mono}>{secret.username}</code>
              <CopyButton text={secret.username} />
            </div>
          )}
          {secret.password && (
            <div>
              <span style={{ color: "#666" }}>Password:</span>{" "}
              <code style={mono}>{secret.password}</code>
              <CopyButton text={secret.password} />
            </div>
          )}
          {secret.secureNotes && (
            <div>
              <span style={{ color: "#666" }}>Notes:</span>{" "}
              <span>{secret.secureNotes}</span>
            </div>
          )}
        </>
      )}
      {secret.kind !== "password" && (
        <div style={{ color: "#666" }}>
          Cleartext displayed for kind <code>{secret.kind}</code>. M2A.6 renders only
          password entries; other kinds show below as raw JSON until per-kind UI lands.
          <pre style={{ ...mono, background: "#f8f8f8", padding: 4, overflow: "auto" }}>
            {JSON.stringify(secret, null, 2)}
          </pre>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", color: "#888" }}>
        <span>Auto-clears in {secondsLeft}s</span>
        <button onClick={onDismiss} style={{ fontSize: 10 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ─── Used-session view (M2B.3) ───
// Inline display of a `vault/proxy-login/0.1` SessionBlob. Shows the
// session id, bound origin, refresh hint, countdown to expiry, and a
// redacted preview of the Authorization header (id_token / bearer)
// with a copy button so a developer can paste it into a curl / RP test
// flow. The parent's setTimeout wipes `usedSession` at `expiresAtMs`;
// this component only renders + counts down — it never persists.
function UsedSessionView({
  sessionBlob,
  expiresAtMs,
  onDismiss,
}: {
  sessionBlob: SessionBlobView;
  expiresAtMs: number;
  onDismiss: () => void;
}): React.JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000)),
  );
  useEffect(() => {
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
      setSecondsLeft(left);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAtMs]);

  const authHeader = sessionBlob.headers?.find(
    (h) => h.name.toLowerCase() === "authorization",
  );
  const headerCount = sessionBlob.headers?.length ?? 0;
  const cookieCount = sessionBlob.cookies?.length ?? 0;

  return (
    <div
      style={{
        marginTop: 4,
        padding: 6,
        background: "#e8f5e9",
        border: "1px solid #80c684",
        borderRadius: 4,
        display: "grid",
        gap: 4,
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong style={{ color: "#206c20" }}>✓ Session ready</strong>
        <span style={{ color: "#666", fontSize: 10 }}>
          expires in {secondsLeft}s
        </span>
      </div>
      {sessionBlob.bindOrigin && (
        <div>
          <span style={{ color: "#666" }}>Bound origin:</span>{" "}
          <code style={mono}>{sessionBlob.bindOrigin}</code>
        </div>
      )}
      <div>
        <span style={{ color: "#666" }}>Session id:</span>{" "}
        <code style={mono}>{sessionBlob.sessionId.slice(0, 12)}…</code>
      </div>
      <div style={{ color: "#666", fontSize: 10 }}>
        {headerCount} header{headerCount === 1 ? "" : "s"} ·{" "}
        {cookieCount} cookie{cookieCount === 1 ? "" : "s"}
        {sessionBlob.refreshHint && <> · refresh: {sessionBlob.refreshHint}</>}
      </div>
      {authHeader && (
        <div>
          <span style={{ color: "#666" }}>{authHeader.name}:</span>{" "}
          <code style={mono} title="redacted preview — copy below for full value">
            {redactBearer(authHeader.value)}
          </code>
          <CopyButton text={authHeader.value} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button onClick={onDismiss} style={{ fontSize: 10 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Redact the middle of a Bearer-token value so the popup doesn't shoulder-
// surf the full id_token. Keeps the scheme + the first 8 / last 8
// characters for at-a-glance "is this the token I expected" comparison.
function redactBearer(headerValue: string): string {
  const m = /^(\s*Bearer\s+)(.+)$/i.exec(headerValue);
  if (!m || !m[1] || !m[2])
    return headerValue.length > 24 ? `${headerValue.slice(0, 12)}…` : headerValue;
  const scheme = m[1];
  const token = m[2];
  if (token.length <= 20) return `${scheme}${token}`;
  return `${scheme}${token.slice(0, 8)}…${token.slice(-8)}`;
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={{ fontSize: 10, marginLeft: 6 }}
      title="Copy to clipboard"
    >
      {copied ? "✓" : "Copy"}
    </button>
  );
}

function ContextChip({ ctx }: { ctx: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0 4px",
        background: "#eef2ff",
        color: "#4338ca",
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        marginRight: 4,
      }}
      title={`Context: ${ctx}`}
    >
      {ctx}
    </span>
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
