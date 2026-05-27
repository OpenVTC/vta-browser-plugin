/// <reference types="chrome" />
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useConnectionStore } from "./store.js";
import {
  RUNTIME_CREATE_CONTEXT,
  RUNTIME_DERIVE_SIGNING_KEY_ID,
  RUNTIME_HOLDER_STATE,
  RUNTIME_LIST_CONTEXTS,
  RUNTIME_LOCK_WALLET,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_INJECT_COOKIES,
  RUNTIME_VAULT_DELETE,
  RUNTIME_VAULT_LIST,
  RUNTIME_VAULT_PROXY_LOGIN,
  RUNTIME_VAULT_RELEASE,
  RUNTIME_VAULT_UPSERT,
  type ContextRecordView,
  type HolderStateInfo,
  type InjectCookiesResultView,
  type OnboardPrepareResult,
  type RuntimeCreateContextResponse,
  type RuntimeDeriveSigningKeyIdResponse,
  type RuntimeHolderStateResponse,
  type RuntimeInjectCookiesResponse,
  type RuntimeListContextsResponse,
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
    /** Set when the SessionBlob carried cookies and the wallet
     *  successfully wrote them into the user's cookie jar via
     *  chrome.cookies.set. Drives the "Open site" affordance in
     *  UsedSessionView. */
    injection?: InjectCookiesResultView;
    /** Non-fatal warning from the inject step (partial success or
     *  permission denied for the target origin). */
    injectionWarning?: string;
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

      // If the SessionBlob carries cookies (Password POST driver path,
      // M2B.5), auto-inject them via chrome.cookies.set. SIOP entries
      // emit no cookies and just carry the id_token in headers — for
      // those, this step is a no-op.
      let injection: InjectCookiesResultView | undefined;
      let injectionWarning: string | undefined;
      const cookies = res.result.sessionBlob.cookies ?? [];
      if (cookies.length > 0 && res.result.sessionBlob.bindOrigin) {
        const injRes = (await chrome.runtime.sendMessage({
          type: RUNTIME_INJECT_COOKIES,
          bindOrigin: res.result.sessionBlob.bindOrigin,
          cookies,
        })) as RuntimeInjectCookiesResponse;
        if (injRes.ok) {
          injection = injRes.result;
          if (injection.injected < injection.total) {
            injectionWarning = `Wrote ${injection.injected} of ${injection.total} cookies; some failed. Check console for details.`;
          }
        } else {
          injectionWarning = `Could not inject cookies: ${injRes.error}`;
        }
      }

      setUsedSession({
        entryId: entry.id,
        sessionBlob: res.result.sessionBlob,
        expiresAtMs,
        ...(injection ? { injection } : {}),
        ...(injectionWarning ? { injectionWarning } : {}),
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
            // The form lifts its own kind-specific shape construction
            // (targets[], secretKind, secret). The parent just hands
            // it to the bridge — no further per-kind branching here.
            setBusy(true);
            setError(null);
            try {
              const res = (await chrome.runtime.sendMessage({
                type: RUNTIME_VAULT_UPSERT,
                contextId: form.contextId,
                targets: form.targets,
                label: form.label,
                secretKind: form.secretKind,
                secret: form.secret,
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
              {e.principalDid && (
                <div
                  style={{ fontSize: 10, color: "#666" }}
                  title="DID the VTA will act AS when you click Use"
                >
                  acts as: <code style={mono}>{e.principalDid}</code>
                  <CopyButton text={e.principalDid} />
                </div>
              )}
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
                  {...(usedSession.injection ? { injection: usedSession.injection } : {})}
                  {...(usedSession.injectionWarning
                    ? { injectionWarning: usedSession.injectionWarning }
                    : {})}
                  onDismiss={() => setUsedSession(null)}
                />
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {(e.secretKind === "did-self-issued" ||
                    e.secretKind === "password") && (
                    <button
                      onClick={() => void useEntry(e)}
                      disabled={busy}
                      style={{ fontSize: 11 }}
                      title={
                        e.secretKind === "did-self-issued"
                          ? "VTA mints a SIOP id_token on your behalf — long-term key never leaves the VTA"
                          : "VTA logs in on your behalf and injects the session cookies — the password never reaches this browser"
                      }
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
// ─── Add-entry form (M2A.6 password / M2B.5 password+loginConfig / M2B.4 did-self-issued) ───
// The form owns the kind-specific shape: it decides which targets[]
// entry to construct, builds the cleartext secret, and emits a single
// ready-to-send object to the parent. The parent just hands that off
// to RUNTIME_VAULT_UPSERT — no per-kind branching in the dispatcher.
//
// Currently supports `password` (with optional `loginConfig`) and
// `did-self-issued`. Passkey / OAuth / DIDComm-peer / SSH / custom
// follow when there's an end-to-end flow that exercises them.

type AddEntryOutput = {
  label: string;
  contextId: string;
  targets: VaultEntryView["targets"];
  secretKind: "password" | "did-self-issued";
  secret: VaultSecretView;
};

function AddEntryForm({
  contexts: _seedContexts,
  busy,
  onCancel,
  onSubmit,
}: {
  /** Contexts seen on currently-loaded entries — used only as the
   *  initial dropdown selection while the fresh VTA-side list loads. */
  contexts: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (form: AddEntryOutput) => Promise<void>;
}): React.JSX.Element {
  // Shared fields
  const [kind, setKind] = useState<"password" | "did-self-issued">("password");
  const [label, setLabel] = useState("");
  const [contextId, setContextId] = useState(_seedContexts[0] ?? "");
  const [notes, setNotes] = useState("");

  // Context dropdown state — fetched from the VTA on mount. Until the
  // fetch returns we render with `_seedContexts` (from loaded entries)
  // so the form is usable instantly even on slow networks.
  const NEW_CONTEXT = "__new__";
  const [vtaContexts, setVtaContexts] = useState<ContextRecordView[] | null>(null);
  const [contextsLoadError, setContextsLoadError] = useState<string | null>(null);
  const [newContextId, setNewContextId] = useState("");
  const [newContextName, setNewContextName] = useState("");
  const [newContextDescription, setNewContextDescription] = useState("");
  const [creatingContext, setCreatingContext] = useState(false);
  const [createContextError, setCreateContextError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_LIST_CONTEXTS,
      })) as RuntimeListContextsResponse;
      if (res.ok) {
        setVtaContexts(res.result.contexts);
        // Seed the dropdown to the first real context if we don't have
        // a selection yet (or if the prior seed isn't in the real list).
        if (
          res.result.contexts.length > 0 &&
          !res.result.contexts.find((c) => c.id === contextId)
        ) {
          setContextId(res.result.contexts[0]!.id);
        }
      } else {
        setContextsLoadError(res.error);
      }
    })();
    // Intentionally empty: fetch once when the form mounts. The
    // dropdown isn't auto-refreshed on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Password-kind fields
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Optional auto-login config (M2B.5) for password entries
  const [loginConfigEnabled, setLoginConfigEnabled] = useState(false);
  const [loginUrl, setLoginUrl] = useState("");
  const [loginFormat, setLoginFormat] = useState<"json" | "form-urlencoded">("json");

  // did-self-issued fields
  const [rpDid, setRpDid] = useState("");
  const [principalDid, setPrincipalDid] = useState("");
  const [signingKeyId, setSigningKeyId] = useState("");
  // signingKeyId derivation state: `auto` candidates derived from the
  // principal DID, the picker selection when multiple match, and a
  // status string for the operator (resolved / error / multi).
  const [kidCandidates, setKidCandidates] = useState<string[]>([]);
  const [kidDeriveError, setKidDeriveError] = useState<string | null>(null);
  const [kidDeriving, setKidDeriving] = useState(false);

  async function deriveSigningKidFor(did: string) {
    setKidDeriving(true);
    setKidDeriveError(null);
    setKidCandidates([]);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_DERIVE_SIGNING_KEY_ID,
        did,
      })) as RuntimeDeriveSigningKeyIdResponse;
      if (!res.ok) {
        setKidDeriveError(res.error);
        return;
      }
      if (res.result.error) {
        setKidDeriveError(res.result.error);
        return;
      }
      const cands = res.result.candidates;
      setKidCandidates(cands);
      if (cands.length === 1) {
        // Unambiguous — auto-fill. The operator can still edit the
        // field if they want a different kid.
        setSigningKeyId(cands[0]!);
      }
      // Multiple candidates: leave the field empty, the picker
      // renders inline so the operator chooses.
    } finally {
      setKidDeriving(false);
    }
  }

  const passwordValid =
    label.trim() &&
    contextId.trim() &&
    origin.trim() &&
    password.length > 0 &&
    (!loginConfigEnabled || loginUrl.trim().length > 0);
  const didSelfIssuedValid =
    label.trim() &&
    contextId.trim() &&
    rpDid.trim() &&
    principalDid.trim() &&
    signingKeyId.trim();
  const valid = kind === "password" ? passwordValid : didSelfIssuedValid;

  async function createNewContext() {
    setCreatingContext(true);
    setCreateContextError(null);
    try {
      const id = newContextId.trim();
      if (!id) {
        setCreateContextError("context id is required");
        return;
      }
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_CREATE_CONTEXT,
        id,
        ...(newContextName.trim() ? { name: newContextName.trim() } : {}),
        ...(newContextDescription.trim()
          ? { description: newContextDescription.trim() }
          : {}),
      })) as RuntimeCreateContextResponse;
      if (!res.ok) {
        setCreateContextError(res.error);
        return;
      }
      // Add the freshly-created context to the dropdown and select it.
      const created: ContextRecordView = res.result;
      setVtaContexts((prev) => (prev ? [...prev, created] : [created]));
      setContextId(created.id);
      // Clear the inline-create form so a second context-create starts
      // from a blank state.
      setNewContextId("");
      setNewContextName("");
      setNewContextDescription("");
    } finally {
      setCreatingContext(false);
    }
  }

  function buildOutput(): AddEntryOutput {
    if (kind === "password") {
      const secret: VaultSecretView = {
        kind: "password",
        password,
        ...(username ? { username } : {}),
        ...(notes ? { secureNotes: notes } : {}),
        ...(loginConfigEnabled
          ? {
              loginConfig: {
                loginUrl: loginUrl.trim(),
                format: loginFormat,
              },
            }
          : {}),
      };
      return {
        label,
        contextId,
        targets: [{ kind: "web-origin" as const, origin }],
        secretKind: "password",
        secret,
      };
    }
    const secret: VaultSecretView = {
      kind: "did-self-issued",
      did: principalDid.trim(),
      signingKeyId: signingKeyId.trim(),
      ...(notes ? { secureNotes: notes } : {}),
    };
    return {
      label,
      contextId,
      targets: [{ kind: "did" as const, did: rpDid.trim() }],
      secretKind: "did-self-issued",
      secret,
    };
  }

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
      <strong style={{ fontSize: 12 }}>
        {kind === "password" ? "New password entry" : "New did-self-issued entry"}
      </strong>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Secret kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "password" | "did-self-issued")}
          style={{ fontSize: 11 }}
        >
          <option value="password">password</option>
          <option value="did-self-issued">did-self-issued</option>
        </select>
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={kind === "password" ? "Work GitHub" : "Work persona"}
        />
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Context</span>
        {vtaContexts ? (
          <select
            value={contextId === "" && vtaContexts.length === 0 ? NEW_CONTEXT : contextId}
            onChange={(e) => setContextId(e.target.value)}
            style={mono}
          >
            {vtaContexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id === c.name ? c.id : `${c.id} — ${c.name}`}
              </option>
            ))}
            <option value={NEW_CONTEXT}>+ New context…</option>
          </select>
        ) : (
          // Fallback while the VTA-side list is still loading or
          // failed to fetch. Free-text input so the operator isn't
          // blocked on the network; the field accepts any context id
          // and the upsert will fail clearly if it doesn't exist.
          <input
            value={contextId}
            onChange={(e) => setContextId(e.target.value)}
            placeholder="ctx_…"
            style={mono}
          />
        )}
        {contextsLoadError && (
          <small style={{ color: "#c00" }}>
            Couldn&apos;t fetch contexts: {contextsLoadError}
          </small>
        )}
      </label>
      {contextId === NEW_CONTEXT && (
        <div
          style={{
            display: "grid",
            gap: 6,
            paddingLeft: 8,
            borderLeft: "2px solid #e5e7eb",
          }}
        >
          <small style={{ color: "#666" }}>
            Create a new context on the VTA (requires super-admin grant).
          </small>
          <input
            placeholder="id (e.g. work)"
            value={newContextId}
            onChange={(e) => setNewContextId(e.target.value)}
            style={mono}
          />
          <input
            placeholder="name (optional — defaults to id)"
            value={newContextName}
            onChange={(e) => setNewContextName(e.target.value)}
          />
          <input
            placeholder="description (optional)"
            value={newContextDescription}
            onChange={(e) => setNewContextDescription(e.target.value)}
          />
          <button
            onClick={() => void createNewContext()}
            disabled={creatingContext || !newContextId.trim()}
          >
            {creatingContext ? "Creating…" : "Create context"}
          </button>
          {createContextError && (
            <small style={{ color: "#c00" }}>{createContextError}</small>
          )}
        </div>
      )}

      {kind === "password" && (
        <>
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
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", color: "#444" }}
            title="When enabled, the VTA POSTs these credentials to loginUrl during vault/proxy-login. Without this, the entry is browser-fill only."
          >
            <input
              type="checkbox"
              checked={loginConfigEnabled}
              onChange={(e) => setLoginConfigEnabled(e.target.checked)}
            />
            Auto-login (proxy-login via VTA)
          </label>
          {loginConfigEnabled && (
            <>
              <label style={{ display: "grid", gap: 2 }}>
                <span style={{ color: "#666" }}>Login URL</span>
                <input
                  value={loginUrl}
                  onChange={(e) => setLoginUrl(e.target.value)}
                  placeholder="http://127.0.0.1:4040/api/login"
                  style={mono}
                />
              </label>
              <label style={{ display: "grid", gap: 2 }}>
                <span style={{ color: "#666" }}>Body format</span>
                <select
                  value={loginFormat}
                  onChange={(e) =>
                    setLoginFormat(e.target.value as "json" | "form-urlencoded")
                  }
                  style={{ fontSize: 11 }}
                >
                  <option value="json">JSON</option>
                  <option value="form-urlencoded">form-urlencoded</option>
                </select>
              </label>
            </>
          )}
        </>
      )}

      {kind === "did-self-issued" && (
        <>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "#666" }}>Relying party DID (target)</span>
            <input
              value={rpDid}
              onChange={(e) => setRpDid(e.target.value)}
              placeholder="did:webvh:…"
              style={mono}
            />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "#666" }}>Persona DID (iss / sub)</span>
            <input
              value={principalDid}
              onChange={(e) => setPrincipalDid(e.target.value)}
              onBlur={() => {
                const trimmed = principalDid.trim();
                if (trimmed.length > 0) void deriveSigningKidFor(trimmed);
              }}
              placeholder="did:webvh:…"
              style={mono}
            />
            <small style={{ color: "#888" }}>
              When you tab away, the wallet resolves this DID and tries to auto-fill the signing
              key id below.
            </small>
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "#666" }}>
              Signing key id{" "}
              <em style={{ color: "#888" }}>(optional — auto-derived from DID)</em>
            </span>
            <input
              value={signingKeyId}
              onChange={(e) => setSigningKeyId(e.target.value)}
              placeholder="did:webvh:…#key-0"
              style={mono}
            />
            {kidDeriving && (
              <small style={{ color: "#888" }}>Resolving DID to derive key id…</small>
            )}
            {!kidDeriving && kidCandidates.length === 1 && signingKeyId === kidCandidates[0] && (
              <small style={{ color: "#3a7" }}>Auto-derived from persona DID.</small>
            )}
            {!kidDeriving && kidCandidates.length > 1 && (
              <div style={{ display: "grid", gap: 4 }}>
                <small style={{ color: "#8a6d3b" }}>
                  Persona DID has {kidCandidates.length} authentication keys — pick one:
                </small>
                {kidCandidates.map((k) => (
                  <button
                    key={k}
                    onClick={() => setSigningKeyId(k)}
                    style={{
                      textAlign: "left",
                      ...mono,
                      background: signingKeyId === k ? "#dff0d8" : undefined,
                    }}
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
            {!kidDeriving && kidDeriveError && (
              <small style={{ color: "#c00" }}>
                Couldn&apos;t derive from DID: {kidDeriveError}. Enter key id manually.
              </small>
            )}
            <small style={{ color: "#888" }}>
              Must reference a key the VTA&apos;s keystore can resolve.
            </small>
          </label>
        </>
      )}

      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "#666" }}>Notes (optional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          onClick={() => void onSubmit(buildOutput())}
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
  injection,
  injectionWarning,
  onDismiss,
}: {
  sessionBlob: SessionBlobView;
  expiresAtMs: number;
  injection?: InjectCookiesResultView;
  injectionWarning?: string;
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

  function openBoundOrigin() {
    if (sessionBlob.bindOrigin) {
      void chrome.tabs.create({ url: sessionBlob.bindOrigin });
    }
  }

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
      {injection && (
        <div style={{ marginTop: 6, padding: 4, background: "#e6f4ea", borderRadius: 3 }}>
          🍪 Injected {injection.injected}/{injection.total} cookies into{" "}
          <code style={mono}>{injection.bindOrigin}</code>
        </div>
      )}
      {injectionWarning && (
        <div style={{ color: "#8a6300", fontSize: 10 }}>{injectionWarning}</div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        {sessionBlob.bindOrigin && injection && injection.injected > 0 && (
          <button onClick={openBoundOrigin} style={{ fontSize: 10 }}>
            Open site
          </button>
        )}
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
  // Context selection. Default is "vta-derived" — the wallet omits
  // `context` from the wire body and the VTA infers (single-context
  // grant → that context; super-admin + single-context VTA → that
  // context). Operators with multi-context VTAs flip to "override"
  // to specify a context explicitly.
  const [contextMode, setContextMode] = useState<"vta-derived" | "override">(
    "vta-derived",
  );
  const [contextOverride, setContextOverride] = useState("");
  const [createIfMissing, setCreateIfMissing] = useState(false);
  const [prep, setPrep] = useState<OnboardPrepareResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // When the VTA returns `provision/integration:context_required`
  // (multi-context VTA where inference can't auto-pick), we surface
  // the candidates as a picker so the operator can choose without
  // re-typing. The ephemeral grant is still valid — picking one
  // immediately retries Connect with that context.
  const [contextCandidates, setContextCandidates] = useState<string[] | null>(null);

  // The effective context to send on the wire. `undefined` means "let
  // the VTA infer". A trimmed non-empty string overrides.
  const effectiveContext =
    contextMode === "override" && contextOverride.trim().length > 0
      ? contextOverride.trim()
      : undefined;
  // Create-if-missing only applies when an override context is set.
  // Picking VTA-derived and asking to also create makes no sense (no
  // context name to create) and would force a super-admin grant the
  // operator doesn't need.
  const allowCreate = contextMode === "override" && createIfMissing;

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

  /** Connect with the currently-selected context, or with an explicit
   *  override (used by the recovery picker — it passes the candidate
   *  the operator just clicked, bypassing React state's async commit). */
  async function connect(forceContext?: string) {
    setBusy(true);
    setStatus(null);
    setContextCandidates(null);
    const ctx = forceContext ?? effectiveContext;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_CONNECT,
        ...(ctx ? { context: ctx } : {}),
        ...(allowCreate ? { createIfMissing: true } : {}),
      })) as RuntimeOnboardConnectResponse;
      if (!res.ok) {
        // Recoverable: VTA can't auto-pick a context. Surface the
        // candidates as a picker rather than bouncing the operator
        // back to a re-prepare cycle. The ephemeral grant is still
        // valid for its 1h TTL so picking immediately retries.
        if (
          res.code === "provision/integration:context_required" &&
          res.candidates &&
          res.candidates.length > 0
        ) {
          setContextCandidates(res.candidates);
          return;
        }
        throw new Error(res.error);
      }
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

  if (prep && contextCandidates) {
    // VTA returned context_required after the operator clicked Connect.
    // The ephemeral grant is still valid; the operator just needs to
    // pick one of these contexts and the wallet retries.
    return (
      <div style={box}>
        <h3 style={{ margin: 0 }}>Pick a context</h3>
        <small>
          This VTA has multiple contexts and couldn&apos;t auto-pick where to put your wallet&apos;s
          admin identity. Choose one:
        </small>
        <div style={{ display: "grid", gap: 4 }}>
          {contextCandidates.map((ctx) => (
            <button
              key={ctx}
              onClick={() => void connect(ctx)}
              disabled={busy}
              style={{ textAlign: "left", ...mono }}
            >
              {ctx}
            </button>
          ))}
        </div>
        <button onClick={() => setContextCandidates(null)} disabled={busy}>
          Cancel
        </button>
        {status && <small style={{ color: "#c00" }}>{status}</small>}
      </div>
    );
  }

  if (prep) {
    // When the operator chose to create the override context inline,
    // the ephemeral grant needs super-admin (not plain admin) — the
    // VTA's context-create gate refuses everything below. Rewrite
    // the printed command so the operator runs the right thing.
    const commandToShow = allowCreate
      ? prep.command.replace("--role admin", "--role super-admin")
      : prep.command;
    return (
      <div style={box}>
        <h3 style={{ margin: 0 }}>Grant this wallet</h3>
        <small>
          Context:{" "}
          {effectiveContext ? (
            <>
              <code style={mono}>{effectiveContext}</code>
              {allowCreate ? " (will be created inline)" : " (override)"}
            </>
          ) : (
            <em>VTA-derived</em>
          )}
        </small>
        <small>
          Run this once as an existing admin (grants a one-time ephemeral key the wallet rotates
          away on connect):
        </small>
        <code style={{ ...mono, background: "#f3f4f6", padding: 8, borderRadius: 6 }}>
          {commandToShow}
        </code>
        <button onClick={() => void navigator.clipboard.writeText(commandToShow)}>
          Copy command
        </button>
        {allowCreate && (
          <small style={{ color: "#8a6d3b" }}>
            Note: <code style={mono}>--role super-admin</code> is required because the wallet will
            ask the VTA to create the context inline.
          </small>
        )}
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
      <fieldset style={{ display: "grid", gap: 4, border: "1px solid #e5e7eb", padding: 8 }}>
        <legend style={{ fontSize: 11, padding: "0 4px" }}>Context</legend>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="radio"
            name="ctx-mode"
            checked={contextMode === "vta-derived"}
            onChange={() => {
              setContextMode("vta-derived");
              setCreateIfMissing(false);
            }}
          />
          Use VTA-derived context <small style={{ color: "#666" }}>(recommended)</small>
        </label>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="radio"
            name="ctx-mode"
            checked={contextMode === "override"}
            onChange={() => setContextMode("override")}
          />
          Specify context
        </label>
        {contextMode === "override" && (
          <div
            style={{ display: "grid", gap: 6, paddingLeft: 22, marginTop: 2 }}
          >
            <input
              placeholder="ctx_… (e.g. work, alpha)"
              value={contextOverride}
              onChange={(e) => setContextOverride(e.target.value)}
              style={mono}
            />
            <label style={{ fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={createIfMissing}
                onChange={(e) => setCreateIfMissing(e.target.checked)}
              />
              Create on the VTA if it doesn&apos;t exist (requires super-admin grant)
            </label>
          </div>
        )}
      </fieldset>
      <button
        onClick={() => void prepare()}
        disabled={
          !vtaDid.trim() ||
          busy ||
          // When overriding, require a non-empty name. VTA-derived
          // imposes no extra precondition.
          (contextMode === "override" && contextOverride.trim().length === 0)
        }
      >
        {busy ? "Resolving…" : "Prepare"}
      </button>
      {status && <small style={{ color: "#c00" }}>{status}</small>}
    </div>
  );
}

function Popup() {
  const connection = useConnectionStore((s) => s.connection);
  const clearConnection = useConnectionStore((s) => s.clearConnection);
  const [holderState, setHolderState] = useState<HolderStateInfo | null>(null);

  // Probe the persisted holder shape on mount. Three possible states:
  // - kind: "v4" → VTA-minted, normal path.
  // - kind: "v3" → pre-M2C self-derived did:peer. Wallet operations would
  //   throw `RequiresReonboardError` at first `loadHolder()` call — show
  //   a banner and force the user through OnboardView, which writes a
  //   fresh v4 and clears v3 on its way out.
  // - kind: "none" → fresh install; OnboardView handles it.
  //
  // The probe runs once on mount. After a successful onboard, the
  // popup's `holderState` is stale (still says "v3") but the
  // `connection` zustand slot IS updated — so we treat connection as
  // the authoritative "you have a holder" signal and override the
  // stale-v3 banner when it's set. Without this override, the
  // migration banner sticks after onboarding succeeds and the operator
  // sees OnboardView underneath, looping if they click Prepare again.
  useEffect(() => {
    void (async () => {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_HOLDER_STATE,
      })) as RuntimeHolderStateResponse;
      if (res.ok) setHolderState(res.result);
    })();
  }, []);

  // Re-probe holderState whenever connection transitions to set. The
  // mount-time snapshot was taken before the successful onboard, so
  // the holderState slot is stale (still "v3"); the connection slot
  // is fresh ("connected"). Re-reading after connection appears
  // lets the banner clear correctly without requiring a popup close
  // + reopen.
  useEffect(() => {
    if (!connection) return;
    void (async () => {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_HOLDER_STATE,
      })) as RuntimeHolderStateResponse;
      if (res.ok) setHolderState(res.result);
    })();
  }, [connection]);

  // Stale-connection case has to be checked BEFORE the
  // connection-takes-precedence guard: a connection pointing at a
  // holder that no longer exists in IndexedDB would yield a
  // ConnectedView that fails on every operation. Surface the broken
  // state and force re-onboarding instead.
  if (holderState?.kind === "none" && connection) {
    return (
      <div style={box}>
        <small style={{ color: "#c00" }}>
          Stale connection cleared — no holder identity is persisted. Onboard fresh.
        </small>
        <OnboardView />
      </div>
    );
  }

  // If we have a connection AND a real holder, show ConnectedView even
  // if the snapshot still says "v3" (the after-onboard stale case).
  // The connection slot is only set by `setConnection` after
  // `installVtaMintedHolder` has atomically written v4 + deleted v3,
  // so a set connection means a real v4 holder exists in storage
  // regardless of what the popup's React state remembers.
  if (connection) {
    return <ConnectedView />;
  }

  // v3 wallets without a connection: show the migration banner so the
  // operator re-onboards. `connection` is null here (caught by the
  // guard above when set), so the migration prompt is correct.
  if (holderState?.kind === "v3") {
    return (
      <div style={box}>
        <div
          style={{
            padding: 12,
            border: "1px solid #c80",
            background: "#fff7e6",
            borderRadius: 6,
            display: "grid",
            gap: 6,
          }}
        >
          <strong>Re-onboarding required</strong>
          <small>
            This wallet predates the VTA-minted identity migration. Your previous holder
            DID (<code style={mono}>{holderState.did}</code>) was generated locally by the
            wallet; this build expects the VTA to mint your long-term identity instead.
          </small>
          <small>
            <strong>What to expect:</strong> connecting to a VTA below will mint a fresh
            holder DID and replace the old one. Every relying party that recognised the
            old DID will need to be re-granted with the new one.
          </small>
          <button
            onClick={() => {
              // Clear any stale connection state so OnboardView starts from
              // a clean slate. v3 IndexedDB record stays until the operator
              // completes a successful onboarding (which atomically writes
              // v4 and deletes v3).
              clearConnection();
            }}
          >
            Dismiss banner
          </button>
        </div>
        <OnboardView />
      </div>
    );
  }

  // Default: no connection, no v3 record → fresh install or post-
  // migration mid-flow. Show OnboardView.
  return <OnboardView />;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
