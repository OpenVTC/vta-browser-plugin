/// <reference types="chrome" />
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { button } from "./theme.js";
import { providerRunsOn, syncProviderRegistration } from "./content-registration.js";
import { c, t } from "./theme.js";
import { encryptHolderSecretInPopup } from "./encrypt-holder.js";
import { readActiveVtaDid } from "./active-vta.js";
import { CopyButton, VaultPanel } from "./vault-panel.js";
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
  RUNTIME_UNLOCK_APPROVER,
  RUNTIME_UNLOCK_PRF,
  RUNTIME_WALLET_LOCK_STATE,
  MEDIATOR_REQUIRED,
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
import { IndexedDBKVStore, rewrapHolderV4Secret, didWebvhDomain } from "@openvtc/pnm-core";
import { getSettings, setSettings } from "./config.js";
import { WebAuthnPrfSecretWrap } from "./webauthn-prf-wrap.js";
import { PrfUnlockError, runPrfUnlockCeremony } from "./webauthn-prf-unlock.js";
import {
  HOST_PERMISSION_REQUIRED,
  displayHostFor,
  hasOriginPermission,
  requestOriginPermission,
} from "./host-permissions.js";

/** `chrome.storage.session` key holding the VTA DID of an onboarding that a
 *  host-permission dialog interrupted. Session-scoped: it must not outlive
 *  the browser session, and it is a UI breadcrumb, not wallet state. */
const PENDING_ONBOARD_DID_KEY = "pending-onboard-vta-did";

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
          background: "var(--w-raised)",
          border: "1px solid var(--w-line)",
          borderRadius: 6,
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span style={{ color: "var(--w-muted)" }}>
          VTA: <code style={mono}>{truncateDid(activeConnection.vtaDid)}</code>
          {vtaList.length > 1 && (
            <span style={{ color: "var(--w-muted)", marginLeft: 6 }}>
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
        background: "var(--w-raised)",
        border: "1px solid var(--w-line)",
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
                background: isActive ? "var(--w-ok-soft)" : "var(--w-surface)",
                border: `1px solid ${isActive ? "var(--w-ok)" : "var(--w-line)"}`,
                borderRadius: 4,
                display: "grid",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{ color: isActive ? "var(--w-ok)" : "var(--w-muted)", fontWeight: 600 }}
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
                  style={{ fontSize: 10, color: "var(--w-danger)" }}
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

  // Advertised transports in priority order (TSP > DIDComm > REST) — the same
  // order the offscreen VtaSession prefers.
  const transports = [
    connection.tspMediatorDid ? "TSP" : null,
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
            background: "var(--w-danger-soft)",
            border: "2px solid var(--w-danger)",
            borderRadius: 6,
            display: "grid",
            gap: 6,
          }}
        >
          <strong style={{ color: "var(--w-danger)", fontSize: 13 }}>
            ⚠ Wallet is NOT encrypted
          </strong>
          <small style={{ color: "var(--w-danger)" }}>
            Your wallet&apos;s long-term key is stored on this device <strong>without encryption</strong>.
            Anyone with access to your browser profile (malware, a stolen laptop, a backup leak)
            can read it. Encrypt now with your platform authenticator (Touch ID, Windows Hello,
            hardware key).
          </small>
          <button
            onClick={() => void encryptNow()}
            disabled={encryptNowBusy}
            style={{
              background: "var(--w-danger)",
              color: "var(--w-accent-ink)",
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
            <small style={{ color: "var(--w-danger)" }}>
              Couldn&apos;t encrypt: {encryptNowError}
            </small>
          )}
          <small style={{ color: "var(--w-danger)", fontSize: 10 }}>
            Heads up: if you lose this authenticator without first disabling encryption, the
            wallet becomes unrecoverable.
          </small>
        </div>
      )}

      <h3 style={{ margin: 0 }}>Connected ✓</h3>
      <div style={{ fontSize: 12, color: "var(--w-muted)" }}>
        Your wallet is authorized at this VTA.
      </div>

      <div style={{ fontSize: 12, color: "var(--w-muted)" }}>VTA</div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <code style={{ ...mono, flex: 1 }}>{connection.vtaDid}</code>
        <CopyButton text={connection.vtaDid} />
      </div>

      <div style={{ fontSize: 12, color: "var(--w-muted)" }}>Holder (your wallet DID)</div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <code style={{ ...mono, flex: 1 }}>{connection.holderDid}</code>
        <CopyButton text={connection.holderDid} />
      </div>

      <div style={{ fontSize: 12, color: "var(--w-muted)" }}>
        Role: <b>{connection.role}</b> &nbsp;·&nbsp; Transports: <b>{transports || "—"}</b>
      </div>

      {encryptOn && (
        <>
          <button onClick={() => void lockWallet()} disabled={lockBusy} style={{ marginTop: 8 }}>
            {lockBusy ? "Locking…" : "🔒 Lock wallet"}
          </button>
          {lockStatus && (
            <small style={{ color: lockStatus.startsWith("Error") ? "var(--w-danger)" : "var(--w-ok)" }}>
              {lockStatus}
            </small>
          )}
          <small style={{ color: "var(--w-muted)" }}>
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
      <small style={{ color: "var(--w-muted)" }}>
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

// ─── Onboarding ───
// Enter a VTA DID → wallet resolves transports + mints an ephemeral did:key →
// operator grants it with one printed command → wallet swaps the grant onto
// its long-term holder did:peer via `swap-acl`.

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

      // Same authenticator, same PRF output, so the approver can come up on
      // this ceremony instead of demanding a second identical one. It is a
      // separate *identity*, not a separate credential — asking twice taught
      // people to click through biometric prompts, which is the opposite of
      // what a per-approval gesture is for.
      //
      // Best-effort: an approver that fails to start is not a failed unlock,
      // and the Advanced page reports whether it is actually running.
      const vtaDid = await readActiveVtaDid();
      if (vtaDid) {
        try {
          await chrome.runtime.sendMessage({
            type: RUNTIME_UNLOCK_APPROVER,
            prfOutputB64u: base64url.encode(prfOutput),
            vtaDid,
          });
        } catch {
          /* no approver minted, or its mediator is unreachable */
        }
      }
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
      <small style={{ color: "var(--w-muted)" }}>
        Once unlocked, wallet operations work normally until you Lock or restart the browser.
      </small>
      <button onClick={() => void unlock()} disabled={busy}>
        {busy ? "Waiting for authenticator…" : "Unlock with authenticator"}
      </button>
      {error && <small style={{ color: "var(--w-danger)" }}>{error}</small>}
    </div>
  );
}

/**
 * Stand-in shown in the popup wherever onboarding used to render.
 *
 * Onboarding now lives in a full tab. Not for room — Chrome tears down the
 * action popup whenever a native dialog takes focus (crbug 40721470), and the
 * flow raises two: the host-permission grant and the WebAuthn PRF ceremony.
 * Run from here, the first Allow appeared to do nothing. A tab cannot be torn
 * down that way.
 */
function OpenSetup({ reason }: { reason: string }) {
  return (
    <div style={{ ...box, gap: 12 }}>
      <div>
        <h3 style={{ margin: "0 0 4px", fontSize: t.md }}>Set up your wallet</h3>
        <div style={{ fontSize: t.sm, color: c.muted, lineHeight: 1.55 }}>{reason}</div>
      </div>
      <button
        onClick={() => {
          void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#setup") });
          // The popup closes on its own once focus moves to the new tab; doing
          // it explicitly keeps the transition from looking like a stall.
          window.close();
        }}
        style={{ ...button("primary"), justifySelf: "start" }}
      >
        Open setup
      </button>
    </div>
  );
}

/**
 * "Enable on this site" — the way a user turns the wallet on where they are.
 *
 * With the provider registered only for granted origins, a site you have never
 * approved has no `window.vtaWallet` at all, so its sign-in button does
 * nothing and there is no page-side way to ask. This banner is that way, and
 * without it the whole permission model is a dead end rather than a tighter
 * one.
 *
 * Renders only on an http(s) tab that is not already enabled, so it stays out
 * of the way once a site is set up.
 */
function EnableOnThisSite() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || !/^https?:\/\//.test(tab.url)) return;
      if (await providerRunsOn(tab.url)) return;
      setOrigin(new URL(tab.url).origin);
      setTabId(tab.id ?? null);
    })();
  }, []);

  if (!origin) return null;

  async function enable() {
    setBusy(true);
    try {
      // First await in the handler: anything before it spends the user
      // gesture chrome.permissions.request needs.
      const granted = await requestOriginPermission(origin!);
      if (!granted) return;
      // Register here rather than relying on the background's onAdded
      // listener, so the reload below cannot beat it.
      await syncProviderRegistration();
      // Registration does not reach into pages that are already open.
      if (tabId !== null) await chrome.tabs.reload(tabId);
      window.close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        padding: "10px 12px",
        borderLeft: `2px solid ${c.accent}`,
        background: c.accentSoft,
      }}
    >
      <strong style={{ fontSize: t.sm }}>
        The wallet is off on {displayHostFor(origin)}
      </strong>
      <small style={{ color: c.muted, lineHeight: 1.5 }}>
        It only runs on sites you turn it on for. Enabling reloads the page so the site can
        see it.
      </small>
      <div>
        <button onClick={() => void enable()} disabled={busy} style={button("primary")}>
          {busy ? "Enabling…" : `Enable on ${displayHostFor(origin)}`}
        </button>
      </div>
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
    const tspChanged = (fresh.tspMediatorDid ?? null) !== (current.tspMediatorDid ?? null);
    if (!restChanged && !medChanged && !tspChanged) return;

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
      ...(fresh.tspMediatorDid ? { tspMediatorDid: fresh.tspMediatorDid } : {}),
    };
    console.info(
      "[pnm] VTA transports refreshed:",
      { tsp: !!fresh.tspMediatorDid, rest: !!fresh.restBaseUrl, didcomm: !!fresh.mediatorDid },
      "(was: tsp=" + !!current.tspMediatorDid + ", rest=" + !!current.restBaseUrl + ", didcomm=" + !!current.mediatorDid + ")",
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
        background: "var(--w-danger-soft)",
        border: "2px solid var(--w-danger)",
        borderRadius: 6,
        display: "grid",
        gap: 6,
        margin: "8px 12px 0",
      }}
    >
      <strong style={{ color: "var(--w-danger)", fontSize: 13 }}>
        ⚠ VTA advertises no transports
      </strong>
      <small style={{ color: "var(--w-danger)" }}>
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
        <small style={{ color: "var(--w-danger)" }}>
          Stale connection cleared — no holder identity is persisted. Onboard fresh.
        </small>
        <OpenSetup reason="Connect a trust agent to get started." />
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
    return <OpenSetup reason="Adding another trust agent opens the setup page." />;
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
        {/* Only shows on a site the wallet is off for, so it disappears once
            the site is set up. */}
        <EnableOnThisSite />
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
            border: "1px solid var(--w-warn)",
            background: "var(--w-warn-soft)",
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
        <OpenSetup reason="Connect a trust agent to get started." />
      </div>
    );
  }

  // Default: no connection, no v3 record → fresh install or post-
  // migration mid-flow. Show OnboardView.
  return <OpenSetup reason="Your wallet needs to be re-connected before it can be used." />;
}

function AffinidiFooter(): React.JSX.Element {
  return (
    <div
      style={{
        textAlign: "center",
        fontSize: 10,
        color: "var(--w-muted)",
        padding: "8px 0 6px",
        borderTop: "1px solid var(--w-raised)",
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
          color: "var(--w-accent)",
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
