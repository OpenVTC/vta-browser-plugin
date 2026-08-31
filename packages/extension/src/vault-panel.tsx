/// <reference types="chrome" />

// The credential vault — listing, adding, releasing and using entries.
//
// Moved out of popup.tsx so the full-page wallet can host it too. The popup
// keeps it as a quick-action surface (list an entry, use it); the Vault pane
// in the app shell is where entries are actually managed. One implementation,
// two containers — a second copy would drift, and this code handles release
// secrets and session blobs where drift is a security problem, not a cosmetic
// one.

import { useEffect, useRef, useState } from "react";
import { base64url } from "@openvtc/vti-didcomm-js";
import {
  RUNTIME_CREATE_CONTEXT,
  RUNTIME_DERIVE_SIGNING_KEY_ID,
  RUNTIME_LIST_CONTEXTS,
  RUNTIME_LIST_DIDS,
  RUNTIME_VAULT_DELETE,
  RUNTIME_VAULT_LIST,
  RUNTIME_VAULT_PROXY_LOGIN,
  RUNTIME_VAULT_RELEASE,
  RUNTIME_VAULT_UPSERT,
  type ContextRecordView,
  type DidRecordView,
  type RuntimeCreateContextResponse,
  type RuntimeDeriveSigningKeyIdResponse,
  type RuntimeListContextsResponse,
  type RuntimeListDidsResponse,
  type RuntimeVaultDeleteResponse,
  type RuntimeVaultListResponse,
  type RuntimeVaultProxyLoginResponse,
  type RuntimeVaultReleaseResponse,
  type RuntimeVaultUpsertResponse,
  type SessionBlobView,
  type VaultEntryView,
  type VaultSecretView,
} from "./bridge-protocol.js";
import { useActiveConnection } from "./store.js";
import { c, t } from "./theme.js";

const box: React.CSSProperties = { padding: 12, display: "grid", gap: 8 };
const mono: React.CSSProperties = {
  fontFamily: "var(--w-mono)",
  fontSize: t.sm,
  wordBreak: "break-all",
};

export function VaultPanel() {
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

  // M2B.3 — proxy-login (the "Use" button). The VTA mints a SIOP
  // id_token on the holder's behalf and returns it inside a SessionBlob
  // as an `Authorization` header; the long-term key never leaves the
  // VTA. The popup holds the blob in memory only for the server-declared
  // TTL and shows a redacted preview so the user can confirm the session
  // was minted; full integration (header injection via
  // declarativeNetRequest) lands in a follow-up.
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

      // Nothing is written to the browser here, or anywhere else in this
      // flow: the wallet holds no `cookies` permission, and the offscreen
      // handler discards any cookie jar the VTA returns. The session is
      // shown, and it is the user's to copy — it is never installed.
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
    <div style={{ marginTop: 12, padding: 8, background: "var(--w-raised)", borderRadius: 6 }}>
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
          <label style={{ color: "var(--w-muted)" }}>Context: </label>
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
        <small style={{ color: "var(--w-danger)", display: "block", marginTop: 6 }}>{error}</small>
      )}
      {entries && entries.length === 0 && (
        <div style={{ marginTop: 6 }}>
          <small style={{ color: "var(--w-muted)", display: "block" }}>
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
                borderTop: "1px solid var(--w-line)",
                display: "grid",
                gap: 2,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{e.label}</div>
              <div style={{ fontSize: 11, color: "var(--w-muted)" }}>
                <SecretKindBadge kind={e.secretKind} />
                {" · "}
                <span style={mono}>{summariseTargets(e.targets)}</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--w-muted)" }}>
                <ContextChip ctx={e.contextId} />
                {e.lastUsedAt && <> · last used {formatDate(e.lastUsedAt)}</>}
                {e.breachedAt && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--w-danger)" }}>⚠ breached</span>
                  </>
                )}
              </div>
              {e.principalDid && (
                <div
                  style={{ fontSize: 10, color: "var(--w-muted)" }}
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
                  onDismiss={() => setUsedSession(null)}
                />
              ) : (
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {/* SIOP entries only. Password entries used to offer this
                      too, driving the VTA's password-POST login and writing
                      the resulting cookies into the jar; that legacy path is
                      gone, so a password entry is browser-fill only and its
                      action is Reveal. */}
                  {e.secretKind === "didSelfIssued" && (
                    <button
                      onClick={() => void useEntry(e)}
                      disabled={busy}
                      style={{ fontSize: 11 }}
                      title="VTA mints a SIOP id_token on your behalf — long-term key never leaves the VTA"
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
                    style={{ fontSize: 11, color: "var(--w-danger)" }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
          {truncated && (
            <li style={{ padding: "6px 0", fontSize: 11, color: "var(--w-muted)" }}>
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
// pattern for them; for now the canonical schema + the @openvtc/pnm-core
// vaultUpsertRest helper accept all eight kinds.
// ─── Add-entry form (M2A.6 password / M2B.4 did-self-issued) ───
// The form owns the kind-specific shape: it decides which targets[]
// entry to construct, builds the cleartext secret, and emits a single
// ready-to-send object to the parent. The parent just hands that off
// to RUNTIME_VAULT_UPSERT — no per-kind branching in the dispatcher.
//
// Currently supports `password` and `did-self-issued`. Passkey / OAuth /
// DIDComm-peer / SSH / custom follow when there's an end-to-end flow that
// exercises them.
//
// A password entry is browser-fill only. It deliberately offers no
// `loginConfig`, which is what told the VTA to POST the credentials at a
// third-party login form and hand back the resulting cookie jar — the
// wallet no longer writes cookies, so an entry configured that way would
// mint a session it could not use.

type AddEntryOutput = {
  label: string;
  contextId: string;
  targets: VaultEntryView["targets"];
  secretKind: "password" | "didSelfIssued";
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
  const [kind, setKind] = useState<"password" | "didSelfIssued">("password");
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

  // did-self-issued fields
  const [rpDid, setRpDid] = useState("");
  const [principalDid, setPrincipalDid] = useState("");
  const [signingKeyId, setSigningKeyId] = useState("");
  // Persona-DID dropdown: the VTA's hosted DIDs in the selected context,
  // fetched per-context. These are the personas the entry can act AS —
  // the VTA can mint a SIOP id_token as any of them.
  const [personaDids, setPersonaDids] = useState<DidRecordView[] | null>(null);
  const [personaDidsLoading, setPersonaDidsLoading] = useState(false);
  const [personaDidsError, setPersonaDidsError] = useState<string | null>(null);
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

  // Load the VTA's hosted DIDs for the selected context whenever the
  // did-self-issued form is active and the context changes. These
  // populate the Persona-DID dropdown — the personas the entry can act
  // AS (the VTA holds their signing keys, so it can mint a SIOP id_token
  // as any of them). Reset the persona + derived key on every context
  // switch so a stale pick can't leak across contexts.
  useEffect(() => {
    if (kind !== "didSelfIssued") return;
    setPersonaDids(null);
    setPrincipalDid("");
    setSigningKeyId("");
    setKidCandidates([]);
    setKidDeriveError(null);
    if (!contextId || contextId === NEW_CONTEXT) {
      setPersonaDidsError(null);
      return;
    }
    let cancelled = false;
    setPersonaDidsLoading(true);
    setPersonaDidsError(null);
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: RUNTIME_LIST_DIDS,
          contextId,
        })) as RuntimeListDidsResponse;
        if (cancelled) return;
        if (!res.ok) {
          setPersonaDidsError(res.error);
          return;
        }
        setPersonaDids(res.result.dids);
        // Unambiguous single DID — auto-select and derive its key.
        if (res.result.dids.length === 1) {
          const only = res.result.dids[0]!.did;
          setPrincipalDid(only);
          void deriveSigningKidFor(only);
        }
      } finally {
        if (!cancelled) setPersonaDidsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // deriveSigningKidFor is a stable hoisted declaration; pin to the
    // inputs that actually change to avoid a re-fetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, contextId]);

  const passwordValid =
    label.trim() && contextId.trim() && origin.trim() && password.length > 0;
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
      };
      return {
        label,
        contextId,
        targets: [{ kind: "webOrigin" as const, origin }],
        secretKind: "password",
        secret,
      };
    }
    const secret: VaultSecretView = {
      kind: "didSelfIssued",
      did: principalDid.trim(),
      signingKeyId: signingKeyId.trim(),
      ...(notes ? { secureNotes: notes } : {}),
    };
    return {
      label,
      contextId,
      targets: [{ kind: "did" as const, did: rpDid.trim() }],
      secretKind: "didSelfIssued",
      secret,
    };
  }

  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        background: "var(--w-surface)",
        border: "1px solid var(--w-line)",
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
        <span style={{ color: "var(--w-muted)" }}>Secret kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "password" | "didSelfIssued")}
          style={{ fontSize: 11 }}
        >
          <option value="password">password</option>
          <option value="didSelfIssued">did-self-issued</option>
        </select>
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "var(--w-muted)" }}>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={kind === "password" ? "Work GitHub" : "Work persona"}
        />
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "var(--w-muted)" }}>Context</span>
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
          <small style={{ color: "var(--w-danger)" }}>
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
            borderLeft: "2px solid var(--w-line)",
          }}
        >
          <small style={{ color: "var(--w-muted)" }}>
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
            <small style={{ color: "var(--w-danger)" }}>{createContextError}</small>
          )}
        </div>
      )}

      {kind === "password" && (
        <>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--w-muted)" }}>Site origin</span>
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder="https://github.com"
              style={mono}
            />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--w-muted)" }}>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--w-muted)" }}>Password</span>
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
        </>
      )}

      {kind === "didSelfIssued" && (
        <>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--w-muted)" }}>Relying party DID (target)</span>
            <input
              value={rpDid}
              onChange={(e) => setRpDid(e.target.value)}
              placeholder="did:webvh:…"
              style={mono}
            />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--w-muted)" }}>Persona DID (iss / sub)</span>
            {personaDidsLoading ? (
              <small style={{ color: "var(--w-muted)" }}>Loading DIDs for “{contextId}”…</small>
            ) : personaDidsError ? (
              <small style={{ color: "var(--w-danger)" }}>Couldn&apos;t list DIDs: {personaDidsError}</small>
            ) : personaDids && personaDids.length > 0 ? (
              <select
                value={principalDid}
                onChange={(e) => {
                  const did = e.target.value;
                  setPrincipalDid(did);
                  // Reset derived key state, then re-derive for the pick.
                  setSigningKeyId("");
                  setKidCandidates([]);
                  setKidDeriveError(null);
                  if (did) void deriveSigningKidFor(did);
                }}
                style={mono}
              >
                <option value="">— select a DID —</option>
                {personaDids.map((d) => (
                  <option key={d.did} value={d.did}>
                    {d.did}
                  </option>
                ))}
              </select>
            ) : (
              <small style={{ color: "var(--w-danger)" }}>
                {contextId === NEW_CONTEXT
                  ? "Pick a context above to see its DIDs."
                  : `Context “${contextId}” has no DIDs — mint one on the VTA first.`}
              </small>
            )}
            <small style={{ color: "var(--w-muted)" }}>
              The entry signs id_tokens as this persona; the VTA holds its signing key.
            </small>
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--w-muted)" }}>
              Signing key id{" "}
              <em style={{ color: "var(--w-muted)" }}>(optional — auto-derived from DID)</em>
            </span>
            <input
              value={signingKeyId}
              onChange={(e) => setSigningKeyId(e.target.value)}
              placeholder="did:webvh:…#key-0"
              style={mono}
            />
            {kidDeriving && (
              <small style={{ color: "var(--w-muted)" }}>Resolving DID to derive key id…</small>
            )}
            {!kidDeriving && kidCandidates.length === 1 && signingKeyId === kidCandidates[0] && (
              <small style={{ color: "var(--w-ok)" }}>Auto-derived from persona DID.</small>
            )}
            {!kidDeriving && kidCandidates.length > 1 && (
              <div style={{ display: "grid", gap: 4 }}>
                <small style={{ color: "var(--w-warn)" }}>
                  Persona DID has {kidCandidates.length} authentication keys — pick one:
                </small>
                {kidCandidates.map((k) => (
                  <button
                    key={k}
                    onClick={() => setSigningKeyId(k)}
                    style={{
                      textAlign: "left",
                      ...mono,
                      background: signingKeyId === k ? "var(--w-ok-soft)" : undefined,
                    }}
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
            {!kidDeriving && kidDeriveError && (
              <small style={{ color: "var(--w-danger)" }}>
                Couldn&apos;t derive from DID: {kidDeriveError}. Enter key id manually.
              </small>
            )}
            <small style={{ color: "var(--w-muted)" }}>
              Must reference a key the VTA&apos;s keystore can resolve.
            </small>
          </label>
        </>
      )}

      <label style={{ display: "grid", gap: 2 }}>
        <span style={{ color: "var(--w-muted)" }}>Notes (optional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {/* Pinned to the bottom of the scrollport, not left at the end of the
          form. A did-self-issued entry is eight fields tall and the popup's
          viewport is capped near 600px, so Save sat below the fold — and the
          only way to reach it was to scroll a document that Chromium will
          sometimes refuse to scroll after a native <select> menu has been
          used, until an unrelated click restores it. That is the browser's
          bug and not ours to fix, but a form whose last step is only ever
          reachable by scrolling is ours: the actions now travel with the
          viewport, so the flow can always be completed (or abandoned)
          wherever the form happens to be scrolled to. Sticky costs nothing
          when the form already fits — it only engages once it doesn't. */}
      <div
        style={{
          display: "flex",
          gap: 6,
          position: "sticky",
          bottom: 0,
          // Negative side/bottom margins span the container's 8px padding so
          // scrolled content passes *behind* the bar rather than through the
          // gap beside it.
          margin: "4px -8px -8px",
          padding: 8,
          background: "var(--w-surface)",
          borderTop: "1px solid var(--w-line-soft)",
          // Follow the container's rounding, or the bar squares off the two
          // bottom corners it now sits over.
          borderRadius: "0 0 3px 3px",
        }}
      >
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
        background: "var(--w-warn-soft)",
        border: "1px solid var(--w-warn)",
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
              <span style={{ color: "var(--w-muted)" }}>Username:</span>{" "}
              <code style={mono}>{secret.username}</code>
              <CopyButton text={secret.username} />
            </div>
          )}
          {secret.password && (
            <div>
              <span style={{ color: "var(--w-muted)" }}>Password:</span>{" "}
              <code style={mono}>{secret.password}</code>
              <CopyButton text={secret.password} />
            </div>
          )}
          {secret.secureNotes && (
            <div>
              <span style={{ color: "var(--w-muted)" }}>Notes:</span>{" "}
              <span>{secret.secureNotes}</span>
            </div>
          )}
        </>
      )}
      {secret.kind !== "password" && (
        <div style={{ color: "var(--w-muted)" }}>
          Cleartext displayed for kind <code>{secret.kind}</code>. M2A.6 renders only
          password entries; other kinds show below as raw JSON until per-kind UI lands.
          <pre style={{ ...mono, background: "var(--w-raised)", padding: 4, overflow: "auto" }}>
            {JSON.stringify(secret, null, 2)}
          </pre>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--w-muted)" }}>
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
//
// It also never *installs* the session. An earlier version had a "Sign in
// to <site>" button that wrote the blob's cookie jar into the browser via
// `chrome.cookies.set`; that path, the `cookies` permission behind it, and
// the scope checks guarding it are all gone. Read-only display is the
// whole contract now, which is why there is nothing here to scope-check.
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
        background: "var(--w-ok-soft)",
        border: "1px solid var(--w-ok)",
        borderRadius: 4,
        display: "grid",
        gap: 4,
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong style={{ color: "var(--w-ok)" }}>✓ Session ready</strong>
        <span style={{ color: "var(--w-muted)", fontSize: 10 }}>
          expires in {secondsLeft}s
        </span>
      </div>
      {sessionBlob.bindOrigin && (
        <div>
          <span style={{ color: "var(--w-muted)" }}>Bound origin:</span>{" "}
          <code style={mono}>{sessionBlob.bindOrigin}</code>
        </div>
      )}
      <div>
        <span style={{ color: "var(--w-muted)" }}>Session id:</span>{" "}
        <code style={mono}>{sessionBlob.sessionId.slice(0, 12)}…</code>
      </div>
      <div style={{ color: "var(--w-muted)", fontSize: 10 }}>
        {headerCount} header{headerCount === 1 ? "" : "s"}
        {sessionBlob.refreshHint && <> · refresh: {sessionBlob.refreshHint}</>}
      </div>
      {authHeader && (
        <div>
          <span style={{ color: "var(--w-muted)" }}>{authHeader.name}:</span>{" "}
          <code style={mono} title="redacted preview — copy below for full value">
            {redactBearer(authHeader.value)}
          </code>
          <CopyButton text={authHeader.value} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        {/* Opens the site, and only that. Nothing of this session is
            installed into the browser on the way — the user carries the
            token across by copying it. */}
        {sessionBlob.bindOrigin && (
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

export function CopyButton({ text }: { text: string }): React.JSX.Element {
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

export function ContextChip({ ctx }: { ctx: string }): React.JSX.Element {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0 4px",
        background: "var(--w-accent-soft)",
        color: "var(--w-accent)",
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
      ? "var(--w-ok)"
      : kind === "passkey"
        ? "var(--w-accent)"
        : kind === "oauthTokens"
          ? "var(--w-warn)"
          : "var(--w-muted)";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        background: colour,
        color: "var(--w-accent-ink)",
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
    case "webOrigin":
      return first.origin + rest;
    case "did":
      return first.did + rest;
    case "iosApp":
      return `ios:${first.bundleId}${rest}`;
    case "androidApp":
      return `android:${first.packageName}${rest}`;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}
