/// <reference types="chrome" />
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useActiveConnection,
  useConnectionStore,
  useLockStateStore,
  type Connection,
} from "./store.js";
import {
  RUNTIME_CREATE_CONTEXT,
  RUNTIME_DERIVE_SIGNING_KEY_ID,
  RUNTIME_HOLDER_STATE,
  RUNTIME_LIST_CONTEXTS,
  RUNTIME_LIST_DIDS,
  RUNTIME_FORGET_HOLDER_RECORD,
  RUNTIME_LOCK_WALLET,
  RUNTIME_REFRESH_VTA_TRANSPORTS,
  RUNTIME_UNLOCK_PRF,
  RUNTIME_WALLET_LOCK_STATE,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_INJECT_COOKIES,
  RUNTIME_VAULT_DELETE,
  RUNTIME_VAULT_LIST,
  RUNTIME_VAULT_PROXY_LOGIN,
  RUNTIME_VAULT_RELEASE,
  RUNTIME_VAULT_UPSERT,
  type ContextRecordView,
  type DidRecordView,
  type HolderStateInfo,
  type InjectCookiesResultView,
  type OnboardPrepareResult,
  type RuntimeCreateContextResponse,
  type RuntimeDeriveSigningKeyIdResponse,
  type RuntimeHolderStateResponse,
  type RuntimeInjectCookiesResponse,
  type RuntimeListContextsResponse,
  type RuntimeListDidsResponse,
  type RuntimeOnboardConnectResponse,
  type RuntimeForgetHolderRecordResponse,
  type RuntimeOnboardPrepareResponse,
  type RuntimeRefreshVtaTransportsResponse,
  type RuntimeUnlockPrfResponse,
  type RuntimeWalletLockStateResponse,
  type RuntimeVaultDeleteResponse,
  type RuntimeVaultListResponse,
  type RuntimeVaultProxyLoginResponse,
  type RuntimeVaultReleaseResponse,
  type RuntimeVaultUpsertResponse,
  type SessionBlobView,
  type VaultEntryView,
  type VaultSecretView,
} from "./bridge-protocol.js";
import { base64url } from "@openvtc/vti-didcomm-js";
import { IndexedDBKVStore, rewrapHolderV4Secret } from "@openvtc/pnm-core";
import { getSettings, setSettings } from "./config.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import { PrfUnlockError, runPrfUnlockCeremony } from "./webauthn-prf-unlock.js";

const box: React.CSSProperties = { padding: 12, display: "grid", gap: 8 };
const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  wordBreak: "break-all",
  // A flex child defaults to `min-width: auto`, so a long unbroken DID
  // refuses to shrink and pushes siblings (the copy button) off-screen.
  // `minWidth: 0` lets it shrink so `break-all` can wrap it instead.
  minWidth: 0,
  maxWidth: "100%",
};

// Run the encrypt-at-rest enrollment in this (visible, gestured) popup
// context AND relay the resulting PRF output to offscreen so its sibling
// `cachedKey` lands seeded too. Without the relay, the next holder-
// touching op in offscreen would throw `WalletLockedError` and force a
// redundant unlock ceremony — popup's cache is warm, offscreen's isn't,
// they live in separate module scopes.
//
// Used by both the post-onboard encrypt prompt and the in-session
// "wallet not encrypted" warning banner — same enrol-rewrap-relay
// shape from both entry points.
async function encryptHolderSecretInPopup(vtaDid: string): Promise<void> {
  // Step 1: re-wrap the persisted secret behind the PRF AES key. Runs
  // the WebAuthn enrollment ceremony as a side effect. After this, the
  // popup's module-scope `cachedKey` is warm AND the IndexedDB record
  // is encrypted at rest. Multi-VTA: `vtaDid` selects which VTA's
  // record gets the rewrap; every other VTA's record on this device
  // is untouched.
  await rewrapHolderV4Secret(new IndexedDBKVStore(), {
    vtaDid,
    toWrap: new WebAuthnPrfSecretWrap(chrome.runtime.id),
  });
  // Step 2: persist the setting so future cold starts dispatch on
  // PRF-wrap. Critical that this lands BEFORE the relay — if the relay
  // fails, the wallet's still in a consistent state (record + flag
  // both say PRF), and the operator just sees UnlockView on next op.
  // The original order (relay → setSettings) left a window where a
  // failed relay would leave the record encrypted but the flag
  // plaintext, which breaks loadHolder() on cold start.
  await setSettings({ encryptHolderSecret: true });
  // Step 3: relay the raw PRF output to offscreen so its `cachedKey`
  // is seeded alongside the popup's. Drained one-shot from the wrap
  // module to avoid stale-value reuse on a later call. Failure here is
  // recoverable — the next offscreen op throws `WalletLockedError`,
  // popup renders UnlockView, operator runs the read-side ceremony.
  const prfOutput = WebAuthnPrfSecretWrap.consumeLastEnrolledPrfOutput();
  if (prfOutput) {
    const res = (await chrome.runtime.sendMessage({
      type: RUNTIME_UNLOCK_PRF,
      prfOutputB64u: base64url.encode(prfOutput),
    })) as RuntimeUnlockPrfResponse;
    if (!res.ok) {
      throw new Error(`offscreen unlock relay failed: ${res.error}`);
    }
  }
}

// ─── Multi-VTA switcher ───
// Renders at the top of ConnectedView. Shows the active VTA and any
// other VTAs onboarded on this device, with switch + forget actions
// per entry. Collapsed by default (just shows the active VTA's
// truncated DID); expands to the full list on click.
//
// The forget flow calls the bridge to delete the IndexedDB holder
// record AND removes the entry from the connection store. The
// operator still needs to revoke the wallet's ACL entry on the VTA
// side separately (`pnm acl delete`); we surface that as a hint.
function VtaSwitcher({
  onRequestAddVta,
}: {
  /** Caller (Popup wrapper) flips into "+ Add VTA" mode so OnboardView
   *  renders over the top of the current ConnectedView. The wrapper
   *  resets this when a new VTA becomes active. */
  onRequestAddVta: () => void;
}): React.JSX.Element {
  const activeConnection = useActiveConnection()!;
  const allVtas = useConnectionStore((s) => s.connections.vtas);
  const activateVta = useConnectionStore((s) => s.activateVta);
  const forgetVta = useConnectionStore((s) => s.forgetVta);
  const [expanded, setExpanded] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);

  const vtaList = Object.values(allVtas).sort((a, b) =>
    a.vtaDid.localeCompare(b.vtaDid),
  );

  async function handleForget(vtaDid: string) {
    if (
      !confirm(
        `Forget VTA ${vtaDid}?\n\n` +
          `This removes the wallet identity for this VTA from this device. The VTA's ACL ` +
          `entry for your wallet stays — revoke it separately on the VTA side ` +
          `(\`pnm acl delete --did <holder>\`) if you don't want the wallet to be able to ` +
          `re-onboard.\n\nProceed?`,
      )
    ) {
      return;
    }
    setForgetting(vtaDid);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_FORGET_HOLDER_RECORD,
        vtaDid,
      })) as RuntimeForgetHolderRecordResponse;
      if (!res.ok) {
        alert(`Couldn't delete the wallet identity for ${vtaDid}: ${res.error}`);
        return;
      }
      forgetVta(vtaDid);
    } finally {
      setForgetting(null);
    }
  }

  if (!expanded) {
    return (
      <div
        style={{
          padding: "6px 10px",
          background: "#f8f8f8",
          border: "1px solid #ddd",
          borderRadius: 6,
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span style={{ color: "#555" }}>
          VTA: <code style={mono}>{truncateDid(activeConnection.vtaDid)}</code>
          {vtaList.length > 1 && (
            <span style={{ color: "#888", marginLeft: 6 }}>
              ({vtaList.length} configured)
            </span>
          )}
        </span>
        <button
          onClick={() => setExpanded(true)}
          style={{ fontSize: 10, padding: "2px 8px" }}
          title={
            vtaList.length > 1
              ? "Switch between VTAs or add a new one"
              : "Add another VTA"
          }
        >
          {vtaList.length > 1 ? "Switch / manage" : "+ Add VTA"}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 8,
        background: "#f8f8f8",
        border: "1px solid #ddd",
        borderRadius: 6,
        display: "grid",
        gap: 6,
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 12 }}>VTAs on this device</strong>
        <button
          onClick={() => setExpanded(false)}
          style={{ fontSize: 10, padding: "2px 6px" }}
        >
          Collapse
        </button>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
        {vtaList.map((c) => {
          const isActive = c.vtaDid === activeConnection.vtaDid;
          return (
            <li
              key={c.vtaDid}
              style={{
                padding: 6,
                background: isActive ? "#eef5e8" : "#fff",
                border: `1px solid ${isActive ? "#80c684" : "#e0e0e0"}`,
                borderRadius: 4,
                display: "grid",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{ color: isActive ? "#206c20" : "#666", fontWeight: 600 }}
                  title={isActive ? "Currently active" : "Click Switch to activate"}
                >
                  {isActive ? "●" : "○"}
                </span>
                <code style={{ ...mono, flex: 1 }}>{c.vtaDid}</code>
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {!isActive && (
                  <button
                    onClick={() => {
                      activateVta(c.vtaDid);
                      setExpanded(false);
                    }}
                    style={{ fontSize: 10 }}
                  >
                    Switch
                  </button>
                )}
                <button
                  onClick={() => void handleForget(c.vtaDid)}
                  disabled={forgetting === c.vtaDid}
                  style={{ fontSize: 10, color: "#c00" }}
                  title="Delete this wallet identity from this device"
                >
                  {forgetting === c.vtaDid ? "Forgetting…" : "Forget"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        onClick={() => {
          setExpanded(false);
          onRequestAddVta();
        }}
        style={{ fontSize: 11 }}
      >
        + Add another VTA
      </button>
    </div>
  );
}

function truncateDid(did: string): string {
  if (did.length <= 36) return did;
  return `${did.slice(0, 20)}…${did.slice(-12)}`;
}

// ─── Connected state ───
// Shown when the wallet has completed the onboarding swap for a VTA.
// Persisted via zustand so the state survives the popup closing.
function ConnectedView({
  onRequestAddVta,
}: {
  /** Forwarded to `VtaSwitcher`'s "+ Add VTA" button. The Popup
   *  wrapper owns the addingVta flag — passes a setter down. */
  onRequestAddVta: () => void;
}) {
  const connection = useActiveConnection()!;
  const clearConnection = useConnectionStore((s) => s.clearConnection);
  const lockState = useLockStateStore((s) => s.state);
  const setLockState = useLockStateStore((s) => s.setLockState);
  const [encryptOn, setEncryptOn] = useState(false);
  const [lockStatus, setLockStatus] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  // In-session encrypt-now flow driven by the plaintext warning banner.
  // Distinct from the post-onboard prompt's busy/error state — the
  // banner can fire any time the operator opens the popup on an
  // unencrypted wallet, including long after onboarding.
  const [encryptNowBusy, setEncryptNowBusy] = useState(false);
  const [encryptNowError, setEncryptNowError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setEncryptOn(Boolean(s.encryptHolderSecret));
    })();
  }, []);

  async function encryptNow(): Promise<void> {
    setEncryptNowBusy(true);
    setEncryptNowError(null);
    try {
      await encryptHolderSecretInPopup(connection.vtaDid);
      // Reflect the new state immediately — banner disappears,
      // ConnectedView re-renders with the Lock button visible.
      setEncryptOn(true);
      setLockState({ encrypted: true, unlocked: true });
    } catch (e) {
      setEncryptNowError(e instanceof Error ? e.message : String(e));
    } finally {
      setEncryptNowBusy(false);
    }
  }

  async function lockWallet(): Promise<void> {
    setLockBusy(true);
    setLockStatus(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: RUNTIME_LOCK_WALLET });
      if (!res?.ok) throw new Error(res?.error ?? "lock failed");
      // Flip the shared lock-state slot to `unlocked: false`. The
      // Popup wrapper observes this and unmounts us in favour of
      // UnlockView — without this, ConnectedView would stay
      // rendered with a now-invalid cached state and the next
      // wallet operation would hang on an invisible WebAuthn
      // prompt from offscreen.
      if (encryptOn) {
        setLockState({ encrypted: true, unlocked: false });
      }
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

  // The plaintext-warning banner fires whenever the offscreen probe
  // confirms `encrypted: false` — wallet identity is stored on this
  // device with no PRF wrap, and an exfiltrated browser profile can
  // read the long-term key. We only render after `lockState !== null`
  // to avoid a flash before the probe lands; rendering on `null`
  // would briefly flag every wallet (including encrypted ones) until
  // the probe completes.
  const showPlaintextWarning = lockState !== null && lockState.encrypted === false;

  return (
    <div style={box}>
      <VtaSwitcher onRequestAddVta={onRequestAddVta} />

      {showPlaintextWarning && (
        <div
          style={{
            padding: 10,
            background: "#fff1f0",
            border: "2px solid #c81e1e",
            borderRadius: 6,
            display: "grid",
            gap: 6,
          }}
        >
          <strong style={{ color: "#c81e1e", fontSize: 13 }}>
            ⚠ Wallet is NOT encrypted
          </strong>
          <small style={{ color: "#7a1313" }}>
            Your wallet&apos;s long-term key is stored on this device <strong>without encryption</strong>.
            Anyone with access to your browser profile (malware, a stolen laptop, a backup leak)
            can read it. Encrypt now with your platform authenticator (Touch ID, Windows Hello,
            hardware key).
          </small>
          <button
            onClick={() => void encryptNow()}
            disabled={encryptNowBusy}
            style={{
              background: "#c81e1e",
              color: "#fff",
              border: "none",
              padding: "8px 14px",
              borderRadius: 4,
              fontWeight: 600,
              fontSize: 12,
              cursor: encryptNowBusy ? "default" : "pointer",
            }}
          >
            {encryptNowBusy ? "Encrypting…" : "🔐 Encrypt now"}
          </button>
          {encryptNowError && (
            <small style={{ color: "#7a1313" }}>
              Couldn&apos;t encrypt: {encryptNowError}
            </small>
          )}
          <small style={{ color: "#7a1313", fontSize: 10 }}>
            Heads up: if you lose this authenticator without first disabling encryption, the
            wallet becomes unrecoverable.
          </small>
        </div>
      )}

      <h3 style={{ margin: 0 }}>Connected ✓</h3>
      <div style={{ fontSize: 12, color: "#555" }}>
        Your wallet is authorized at this VTA.
      </div>

      <div style={{ fontSize: 12, color: "#777" }}>VTA</div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <code style={{ ...mono, flex: 1 }}>{connection.vtaDid}</code>
        <CopyButton text={connection.vtaDid} />
      </div>

      <div style={{ fontSize: 12, color: "#777" }}>Holder (your wallet DID)</div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <code style={{ ...mono, flex: 1 }}>{connection.holderDid}</code>
        <CopyButton text={connection.holderDid} />
      </div>

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
                  {(e.secretKind === "didSelfIssued" ||
                    e.secretKind === "password") && (
                    <button
                      onClick={() => void useEntry(e)}
                      disabled={busy}
                      style={{ fontSize: 11 }}
                      title={
                        e.secretKind === "didSelfIssued"
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
// pattern for them; for now the canonical schema + the @openvtc/pnm-core
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
  const [loginConfigEnabled, setLoginConfigEnabled] = useState(false);
  const [loginUrl, setLoginUrl] = useState("");
  const [loginFormat, setLoginFormat] = useState<"json" | "formUrlencoded">("json");

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
          onChange={(e) => setKind(e.target.value as "password" | "didSelfIssued")}
          style={{ fontSize: 11 }}
        >
          <option value="password">password</option>
          <option value="didSelfIssued">did-self-issued</option>
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
                    setLoginFormat(e.target.value as "json" | "formUrlencoded")
                  }
                  style={{ fontSize: 11 }}
                >
                  <option value="json">JSON</option>
                  <option value="formUrlencoded">form-urlencoded</option>
                </select>
              </label>
            </>
          )}
        </>
      )}

      {kind === "didSelfIssued" && (
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
            {personaDidsLoading ? (
              <small style={{ color: "#888" }}>Loading DIDs for “{contextId}”…</small>
            ) : personaDidsError ? (
              <small style={{ color: "#c00" }}>Couldn&apos;t list DIDs: {personaDidsError}</small>
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
              <small style={{ color: "#c00" }}>
                {contextId === NEW_CONTEXT
                  ? "Pick a context above to see its DIDs."
                  : `Context “${contextId}” has no DIDs — mint one on the VTA first.`}
              </small>
            )}
            <small style={{ color: "#888" }}>
              The entry signs id_tokens as this persona; the VTA holds its signing key.
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
        : kind === "oauthTokens"
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

// ─── Onboarding ───
// Enter a VTA DID → wallet resolves transports + mints an ephemeral did:key →
// operator grants it with one printed command → wallet swaps the grant onto
// its long-term holder did:peer via `swap-acl`.
function OnboardView({
  onCancel,
}: {
  /** When set, OnboardView renders a "← Back" link at the top that
   *  the operator can click to back out of "+ Add VTA" mode without
   *  completing onboarding. Omitted on fresh-install OnboardView (no
   *  existing connection to go back to). */
  onCancel?: () => void;
} = {}) {
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

  // Between "onboard succeeded" and "ConnectedView renders" we
  // optionally show an Encrypt-your-wallet prompt. Offscreen can't
  // run WebAuthn (it's hidden), so the seed lands plaintext after
  // onboarding; the popup (visible, has fresh user gesture from the
  // operator's clicks through the prompt) is the right place to run
  // the WebAuthn-PRF ceremony and re-wrap the record in place. The
  // setConnection call is deferred until the operator either
  // encrypts or skips — that way the Popup wrapper's `connection`
  // check doesn't transition to ConnectedView prematurely.
  interface PendingConnect {
    vtaDid: string;
    holderDid: string;
    role: string;
    restBaseUrl?: string;
    mediatorDid?: string;
    connectedAt: number;
    secretEncrypted: boolean;
  }
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null);
  const [encryptBusy, setEncryptBusy] = useState(false);
  const [encryptError, setEncryptError] = useState<string | null>(null);

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
      // Stash the connection info but don't commit to ConnectedView
      // yet. The next screen offers to encrypt the just-installed
      // holder identity in the popup's visible context — running the
      // WebAuthn ceremony here works (popup is focused, the operator
      // is right there) where the same call from offscreen hangs.
      // If the offscreen path ever DOES return `secretEncrypted: true`
      // (a future popup-driven install pipeline), the prompt screen
      // detects that and transitions through automatically.
      setPrep(null);
      setPendingConnect({
        vtaDid: vtaDid.trim(),
        holderDid: res.result.holderDid,
        role: res.result.role,
        ...(prep?.restBaseUrl ? { restBaseUrl: prep.restBaseUrl } : {}),
        ...(prep?.mediatorDid ? { mediatorDid: prep.mediatorDid } : {}),
        connectedAt: Date.now(),
        secretEncrypted: res.result.secretEncrypted,
      });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Finalize the pending connection: commit to zustand → ConnectedView.
  function finalizeConnection(pc: PendingConnect) {
    setConnection({
      vtaDid: pc.vtaDid,
      holderDid: pc.holderDid,
      role: pc.role,
      ...(pc.restBaseUrl ? { restBaseUrl: pc.restBaseUrl } : {}),
      ...(pc.mediatorDid ? { mediatorDid: pc.mediatorDid } : {}),
      connectedAt: pc.connectedAt,
    });
    setPendingConnect(null);
    setEncryptError(null);
  }

  // Run the WebAuthn-PRF ceremony in the popup's visible context and
  // re-wrap the just-installed v4 holder secret under the PRF-derived
  // AES key. The popup is the right context: offscreen is hidden and
  // hangs WebAuthn; the popup is visible and has a live user gesture
  // from the button click that triggered this handler.
  async function encryptAndFinalize(pc: PendingConnect) {
    setEncryptBusy(true);
    setEncryptError(null);
    try {
      await encryptHolderSecretInPopup(pc.vtaDid);
      finalizeConnection({ ...pc, secretEncrypted: true });
    } catch (e) {
      setEncryptError(e instanceof Error ? e.message : String(e));
    } finally {
      setEncryptBusy(false);
    }
  }

  if (pendingConnect) {
    // If offscreen managed to encrypt on its own (future popup-driven
    // install pipeline), skip the prompt — the work is already done.
    if (pendingConnect.secretEncrypted) {
      finalizeConnection(pendingConnect);
      return null;
    }
    return (
      <div style={box}>
        <h3 style={{ margin: 0 }}>Wallet onboarded ✓</h3>
        <small>
          Your wallet&apos;s long-term identity is now <code style={mono}>{pendingConnect.holderDid}</code>.
        </small>
        <small style={{ color: "#666" }}>
          It&apos;s currently stored on this device <strong>without encryption</strong>. Anyone with
          access to your browser profile can read the key. Encrypt it with your platform
          authenticator (Touch ID, Windows Hello, hardware key) so an exfiltrated profile
          can&apos;t recover it.
        </small>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 0",
          }}
        >
          <button
            onClick={() => void encryptAndFinalize(pendingConnect)}
            disabled={encryptBusy}
            style={{
              background: "#2563eb",
              color: "#fff",
              border: "none",
              padding: "10px 16px",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              cursor: encryptBusy ? "default" : "pointer",
              flex: 1,
            }}
          >
            {encryptBusy ? "Encrypting…" : "🔐 Encrypt with authenticator"}
          </button>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "#2563eb",
              background: "#dbeafe",
              padding: "2px 6px",
              borderRadius: 3,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
            title="Recommended for any wallet you'll use for more than testing"
          >
            Recommended
          </span>
        </div>
        <small style={{ color: "#8a6d3b" }}>
          Heads up: if you lose access to this authenticator without first disabling encryption,
          the wallet becomes unrecoverable — the seed is bound to that authenticator&apos;s PRF
          output and can&apos;t be retrieved from the browser alone.
        </small>
        {encryptError && (
          <small style={{ color: "#c00" }}>
            Couldn&apos;t encrypt: {encryptError}. You can retry below, or skip and enable later.
          </small>
        )}
        <div style={{ textAlign: "center", marginTop: 4 }}>
          <button
            onClick={() => finalizeConnection(pendingConnect)}
            disabled={encryptBusy}
            style={{
              background: "transparent",
              border: "none",
              color: "#888",
              fontSize: 11,
              textDecoration: "underline",
              cursor: encryptBusy ? "default" : "pointer",
              padding: 0,
            }}
          >
            Skip for now (leave wallet unencrypted)
          </button>
        </div>
      </div>
    );
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
      {onCancel && (
        <button
          onClick={onCancel}
          style={{
            background: "transparent",
            border: "none",
            color: "#2563eb",
            fontSize: 11,
            cursor: "pointer",
            padding: 0,
            textAlign: "left",
            justifySelf: "start",
          }}
        >
          ← Back to current VTA
        </button>
      )}
      <h3 style={{ margin: 0 }}>
        {onCancel ? "Add another VTA" : "Connect to a VTA"}
      </h3>
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

// ─── Unlock view ───
// Shown when an encrypted-at-rest wallet's AES cache is empty in
// offscreen — e.g. after a browser restart, a service-worker eviction,
// or an operator-initiated Lock. The visible popup is the only context
// that can run `navigator.credentials.get` (offscreen is hidden and
// hangs WebAuthn). The popup runs the ceremony, extracts the PRF
// output, and relays the bytes to offscreen which seeds its cache.
// After this, every subsequent operation that hits `loadHolder()` in
// offscreen finds the cached key and completes without prompting.
function UnlockView(): React.JSX.Element {
  const setLockState = useLockStateStore((s) => s.setLockState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const { prfOutput } = await runPrfUnlockCeremony(chrome.runtime.id);
      // Encode for the bridge — chrome.runtime.sendMessage's JSON
      // serialisation mangles Uint8Array (becomes a plain object on
      // the receiving side). base64url-no-pad survives the
      // round-trip; offscreen decodes back at the boundary.
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_UNLOCK_PRF,
        prfOutputB64u: base64url.encode(prfOutput),
      })) as RuntimeUnlockPrfResponse;
      if (!res.ok) throw new Error(res.error);
      setLockState({ encrypted: true, unlocked: true });
    } catch (e) {
      // `PrfUnlockError.reason === "cancelled"` is the operator
      // dismissing the system dialog — surface it kindly (no
      // scary error, just let them retry). Other reasons (no
      // enrolment, no PRF output, unexpected) need the full
      // message.
      if (e instanceof PrfUnlockError && e.reason === "cancelled") {
        setError("Cancelled. Tap the button to try again.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={box}>
      <h3 style={{ margin: 0 }}>Unlock wallet</h3>
      <small>
        This wallet&apos;s identity is encrypted on this device. Tap your authenticator (Touch ID,
        Windows Hello, hardware key) to unlock for this session.
      </small>
      <small style={{ color: "#666" }}>
        Once unlocked, wallet operations work normally until you Lock or restart the browser.
      </small>
      <button onClick={() => void unlock()} disabled={busy}>
        {busy ? "Waiting for authenticator…" : "Unlock with authenticator"}
      </button>
      {error && <small style={{ color: "#c00" }}>{error}</small>}
    </div>
  );
}

function Popup() {
  const connection = useActiveConnection();
  const setConnection = useConnectionStore((s) => s.setConnection);
  const clearConnection = useConnectionStore((s) => s.clearConnection);
  const [holderState, setHolderState] = useState<HolderStateInfo | null>(null);
  // Set to `true` when the operator clicks "+ Add VTA" inside the
  // VtaSwitcher. Forces OnboardView to render even though an active
  // connection exists. Auto-resets when the new VTA becomes active
  // (see the useEffect below) so the operator lands in ConnectedView
  // for the freshly-added VTA without an extra click.
  const [addingVta, setAddingVta] = useState(false);
  // Set to `true` when the most recent transport probe found the VTA
  // advertising neither REST nor DIDComm — operator action required.
  // Distinct from a benign transport flip (e.g. REST disabled, DIDComm
  // still up) which we just silently reflect in the persisted
  // connection.
  const [vtaNoTransports, setVtaNoTransports] = useState(false);
  // Lock state for encrypted-at-rest wallets. Lives in a non-
  // persisted zustand store so ConnectedView's Lock handler can flip
  // it back to `unlocked: false` after running RUNTIME_LOCK_WALLET,
  // forcing Popup to re-render with UnlockView instead of a now-
  // useless ConnectedView. `encrypted: false` means PRF wrapping
  // isn't in use → the unlock branch never renders.
  const lockState = useLockStateStore((s) => s.state);
  const setLockState = useLockStateStore((s) => s.setLockState);
  const probeLockState = async () => {
    // Pass the active vtaDid (when set) so the lock-state response
    // reflects whether THE active record needs unlocking. Without a
    // vtaDid, the offscreen returns the aggregate ("any v4 record")
    // which is fine for the on-mount probe before connection is known
    // but misleading once we know which VTA we're operating against.
    const res = (await chrome.runtime.sendMessage({
      type: RUNTIME_WALLET_LOCK_STATE,
      ...(connection ? { vtaDid: connection.vtaDid } : {}),
    })) as RuntimeWalletLockStateResponse;
    if (res.ok) setLockState(res.result);
  };

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
      await probeLockState();
    })();
  }, []);

  // Re-probe holderState + lockState whenever connection transitions
  // to set. The mount-time snapshot was taken before the successful
  // onboard, so both slots are stale (holderState still "v3";
  // lockState still reflects the pre-onboard wallet). Re-reading
  // after connection appears lets the migration banner clear AND the
  // plaintext-warning banner correctly reflect whether the just-
  // completed onboard chose to encrypt.
  //
  // Also re-resolve the VTA's currently-advertised transports. The
  // persisted connection caches `restBaseUrl` + `mediatorDid` from
  // onboard time; a VTA that later disabled one transport via
  // `pnm services {rest,didcomm} disable` leaves that cached endpoint
  // pointing at a dead path. Refreshing on connection-change keeps the
  // cache aligned without forcing the operator to re-onboard.
  useEffect(() => {
    if (!connection) return;
    void (async () => {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_HOLDER_STATE,
      })) as RuntimeHolderStateResponse;
      if (res.ok) setHolderState(res.result);
      await probeLockState();
      await refreshVtaTransports(connection);
    })();
    // probeLockState + refreshVtaTransports are stable closures over
    // setLockState / setConnection / setVtaNoTransports; including
    // them in deps would re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  // Compare freshly-resolved VTA transports against the persisted
  // connection. On drift, update the connection so subsequent
  // background→offscreen calls use the right endpoint. On a zero-
  // transport response (VTA disabled both REST and DIDComm), surface
  // a critical banner — the operator's only safe move is to wait for
  // the VTA to re-enable one, or to revert via the offline `vta`
  // services CLI.
  async function refreshVtaTransports(current: Connection): Promise<void> {
    const res = (await chrome.runtime.sendMessage({
      type: RUNTIME_REFRESH_VTA_TRANSPORTS,
      vtaDid: current.vtaDid,
    })) as RuntimeRefreshVtaTransportsResponse;
    if (!res.ok) {
      // Resolution failure (network, DID-doc fetch error). Don't touch
      // the cached transports — falling back to whatever's persisted
      // is safer than wiping them on a transient resolver error.
      console.warn("[pnm] VTA transport refresh failed:", res.error);
      return;
    }
    const fresh = res.result;
    setVtaNoTransports(!fresh.restBaseUrl && !fresh.mediatorDid);

    // Drift check — only re-set the store when values actually
    // changed, to avoid spurious re-renders + storage writes.
    const restChanged = (fresh.restBaseUrl ?? null) !== (current.restBaseUrl ?? null);
    const medChanged = (fresh.mediatorDid ?? null) !== (current.mediatorDid ?? null);
    if (!restChanged && !medChanged) return;

    // Rebuild the connection without unset transports — JS spread keeps
    // the old value if the new field is absent; building fresh lets us
    // CLEAR a transport the VTA stopped advertising.
    const updated: Connection = {
      vtaDid: current.vtaDid,
      holderDid: current.holderDid,
      role: current.role,
      connectedAt: current.connectedAt,
      ...(fresh.restBaseUrl ? { restBaseUrl: fresh.restBaseUrl } : {}),
      ...(fresh.mediatorDid ? { mediatorDid: fresh.mediatorDid } : {}),
    };
    console.info(
      "[pnm] VTA transports refreshed:",
      { rest: !!fresh.restBaseUrl, didcomm: !!fresh.mediatorDid },
      "(was: rest=" + !!current.restBaseUrl + ", didcomm=" + !!current.mediatorDid + ")",
    );
    setConnection(updated);
  }

  // Banner injected ABOVE whichever connected/locked view renders when
  // the most recent transport probe found no advertised transports on
  // the VTA. Without this, the operator sees ConnectedView (looks fine
  // on the surface) but every op fails with a generic network error.
  const noTransportsBanner = vtaNoTransports && connection && (
    <div
      style={{
        padding: 10,
        background: "#fff1f0",
        border: "2px solid #c81e1e",
        borderRadius: 6,
        display: "grid",
        gap: 6,
        margin: "8px 12px 0",
      }}
    >
      <strong style={{ color: "#c81e1e", fontSize: 13 }}>
        ⚠ VTA advertises no transports
      </strong>
      <small style={{ color: "#7a1313" }}>
        <code style={mono}>{connection.vtaDid}</code> currently advertises neither{" "}
        <code>#vta-rest</code> nor <code>#vta-didcomm</code>. Wallet operations will fail until
        the VTA re-enables at least one transport (<code>vta services {`{rest,didcomm}`} enable</code>).
      </small>
    </div>
  );

  // Auto-reset `addingVta` when the active VTA changes (or appears
  // for the first time). The onboarding flow ends by calling
  // setConnection with the new VTA, which becomes active; that's the
  // signal that "+ Add VTA" mode is done. Without this, the operator
  // would stay on OnboardView after the onboard succeeds.
  const prevActiveDidRef = useRef<string | undefined>(connection?.vtaDid);
  useEffect(() => {
    if (connection?.vtaDid && connection.vtaDid !== prevActiveDidRef.current) {
      setAddingVta(false);
    }
    prevActiveDidRef.current = connection?.vtaDid;
  }, [connection?.vtaDid]);

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

  // "+ Add VTA" override: the operator chose to onboard a new VTA on
  // top of an existing one. Show OnboardView regardless of connection
  // / lock state. Checked BEFORE the lock guard so adding a new VTA
  // doesn't require unlocking the existing active one — the new
  // wallet's record can be created fresh; the encrypt step (if
  // chosen) shares the device's PRF credential, which means the
  // Touch ID prompt during enrolment ALSO unlocks the cache.
  if (addingVta) {
    return <OnboardView onCancel={() => setAddingVta(false)} />;
  }

  // Wallet is encrypted at rest AND offscreen doesn't yet have the
  // AES key cached → render UnlockView before letting the operator
  // reach ConnectedView. Otherwise the first operation they try
  // (Load entries, Login, anything that hits `loadHolder()` in
  // offscreen) would trigger an invisible `navigator.credentials.get`
  // from the hidden offscreen page and hang forever waiting for a
  // user gesture that can never arrive. The unlock-relay runs the
  // ceremony in the popup (visible, gesture from button click) +
  // ships the PRF output to offscreen which seeds the cache.
  if (lockState?.encrypted && !lockState.unlocked) {
    return (
      <>
        {noTransportsBanner}
        <UnlockView />
      </>
    );
  }

  // If we have a connection AND a real holder, show ConnectedView even
  // if the snapshot still says "v3" (the after-onboard stale case).
  // The connection slot is only set by `setConnection` after
  // `installVtaMintedHolder` has atomically written v4 + deleted v3,
  // so a set connection means a real v4 holder exists in storage
  // regardless of what the popup's React state remembers.
  if (connection) {
    return (
      <>
        {noTransportsBanner}
        <ConnectedView onRequestAddVta={() => setAddingVta(true)} />
      </>
    );
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

function AffinidiFooter(): React.JSX.Element {
  return (
    <div
      style={{
        textAlign: "center",
        fontSize: 10,
        color: "#9ca3af",
        padding: "8px 0 6px",
        borderTop: "1px solid #f0f0f0",
        marginTop: 4,
        letterSpacing: 0.2,
      }}
    >
      Built by{" "}
      <a
        href="https://www.affinidi.com"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "#6366f1",
          textDecoration: "none",
          fontWeight: 500,
        }}
      >
        Affinidi
      </a>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
      <AffinidiFooter />
    </StrictMode>,
  );
}
