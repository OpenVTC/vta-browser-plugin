/// <reference types="chrome" />

// VTA onboarding — the multi-step provisioning flow.
//
// Lifted out of popup.tsx so it can run in a full tab. It was not merely
// cramped there: Chrome tears down the action popup when a native dialog takes
// focus (crbug 40721470), and this flow raises two of them — the
// host-permission grant and the WebAuthn PRF ceremony. A tab is immune to that
// teardown, which is the whole reason for the move.
//
// The provisioning sequence itself is unchanged; only its container and its
// colours are.

import { useEffect, useState } from "react";
import { useConnectionStore } from "./store.js";
import { didWebvhDomain } from "@openvtc/pnm-core";
import {
  looksLikeAgentName,
  parseAgentName,
} from "./agent-name.js";
import {
  MEDIATOR_REQUIRED,
  ONBOARD_STAGES,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_PROGRESS,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_RESOLVE_AGENT_NAME,
  type OnboardPrepareResult,
  type OnboardStage,
  type RuntimeOnboardProgressMessage,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardPrepareResponse,
  type RuntimeResolveAgentNameResponse,
} from "./bridge-protocol.js";
import {
  displayHostFor,
  hasOriginPermission,
  requestOriginPermission,
} from "./host-permissions.js";
import { encryptHolderSecretInPopup } from "./encrypt-holder.js";
import { button, c, microLabel, t } from "./theme.js";

/** `chrome.storage.session` key holding the VTA DID of an onboarding that a
 *  host-permission dialog interrupted. Session-scoped: a UI breadcrumb that
 *  must not outlive the browser session. */
const PENDING_ONBOARD_DID_KEY = "pending-onboard-vta-did";

const box: React.CSSProperties = { padding: 12, display: "grid", gap: 8 };
const mono: React.CSSProperties = {
  fontFamily: "var(--w-mono)",
  fontSize: t.sm,
  wordBreak: "break-all",
};

export function OnboardView({
  onCancel,
  standalone = false,
}: {
  /** Show the component's own heading. False when embedded under the setup
   *  spine, whose step 1 already names this. */
  standalone?: boolean;
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
  // Whether the grant command has been copied. Collapses the command block
  // so the screen stops re-presenting a step the operator has finished.
  const [commandCopied, setCommandCopied] = useState(false);
  const [resolvingName, setResolvingName] = useState(false);
  /** Set when the operator typed a name rather than a DID, so the DID that was
   *  actually verified is shown — the name is a lookup key, the DID is the
   *  thing being connected to. */
  const [resolvedFrom, setResolvedFrom] = useState<{ name: string; did: string } | null>(null);
  // Which phase the offscreen connect is in. Null when not connecting.
  const [stage, setStage] = useState<OnboardStage | null>(null);

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
  // Set when the VTA published no mediator and onboarding needs one supplied.
  // Distinct from an error: it is a question with an answer that retries.
  const [needsMediator, setNeedsMediator] = useState(false);
  const [fallbackMediator, setFallbackMediator] = useState("");
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

  // Resume an onboarding that a permission dialog interrupted.
  //
  // Chrome may tear down the action popup when it shows the host-access
  // dialog (crbug 40721470), destroying this component mid-flight. `prepare`
  // stashes the DID before prompting, so on reopen we restore what was typed
  // and — if the grant went through — carry straight on. Without this the
  // operator sees an empty form and has to retype and re-click, which reads
  // as the first Allow having done nothing.
  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.session.get(PENDING_ONBOARD_DID_KEY);
      const pendingDid = stored[PENDING_ONBOARD_DID_KEY];
      if (typeof pendingDid !== "string" || !pendingDid) return;
      await chrome.storage.session.remove(PENDING_ONBOARD_DID_KEY);

      setVtaDid(pendingDid);
      const host = didWebvhDomain(pendingDid);
      // Only auto-continue when the grant actually landed. If the operator
      // declined, leave the restored DID in the box and say nothing — they
      // are looking at the form they were on, and re-clicking Prepare will
      // ask again.
      if (host && (await hasOriginPermission(host))) {
        void prepare(pendingDid);
      }
    })();
    // Mount only: this is a one-shot resume, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connect performs four round trips and can take many seconds. Without a
  // running commentary the button just says "Connecting…" and the operator
  // cannot tell a slow mediator from a dead one.
  useEffect(() => {
    const onMessage = (message: unknown) => {
      const m = message as Partial<RuntimeOnboardProgressMessage>;
      if (m?.type === RUNTIME_ONBOARD_PROGRESS && m.stage) setStage(m.stage);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  /** `didOverride` is passed by the resume path, which has the DID in hand
   *  before React state has committed. */
  async function prepare(didOverride?: string) {
    const typed = (didOverride ?? vtaDid).trim();
    setBusy(true);
    setStatus(null);
    // A fresh prepare may target a different VTA, so any mediator answered for
    // the previous one must not carry over silently.
    setNeedsMediator(false);
    setFallbackMediator("");
    // A new prepare mints a new ephemeral, so a previously copied command
    // is now the wrong one — re-expand rather than let it look done.
    setCommandCopied(false);
    setResolvedFrom(null);
    try {
      // Ask for the VTA's host up front, before any awaited work spends the
      // click's user gesture. The host comes out of the DID string itself
      // (`did:webvh:<scid>:<host>`), so no network round trip is needed to
      // learn what to ask for — which is the whole reason this can be an
      // optional permission rather than an install-time `<all_urls>` grant.
      //
      // vta-service applies an origin-allowlist CORS layer, so without the
      // grant every REST call is blocked by the browser. Non-webvh DIDs
      // (did:peer VTAs reached over DIDComm) have no host and need none.
      // One field takes either form. The spec is explicit that application
      // code should never make the user answer "is this a DID or a name?" —
      // classification is a local string test with no network.
      const asName = looksLikeAgentName(typed) ? parseAgentName(typed) : null;

      // Whichever form was typed, a host grant comes first: resolving a name
      // reads a cross-origin redirect's Location, and reaching a VTA is a
      // CORS-allowlisted request. Requested before any other await so the
      // click's user gesture is still live.
      const grantHost = asName ? asName.authority : didWebvhDomain(typed);
      if (grantHost && !(await requestOriginPermission(grantHost))) {
        setStatus(
          `The wallet needs access to ${displayHostFor(grantHost)} to look this up. ` +
            `Click Continue again and approve the prompt.`,
        );
        return;
      }

      let did = typed;
      if (asName) {
        setResolvingName(true);
        try {
          const res = (await chrome.runtime.sendMessage({
            type: RUNTIME_RESOLVE_AGENT_NAME,
            name: typed,
          })) as RuntimeResolveAgentNameResponse;
          if (!res.ok) {
            // The message already names both halves of the binding, which is
            // the whole point of the spec's error wording — show it verbatim
            // rather than replacing it with something vaguer.
            setStatus(res.error);
            return;
          }
          did = res.result.did;
          setResolvedFrom({ name: res.result.name.replace(/^https?:\/\//, ""), did });
        } finally {
          setResolvingName(false);
        }
      }

      const vtaHost = didWebvhDomain(did);
      if (vtaHost && vtaHost !== grantHost) {
        // A name can resolve to a DID on a different host than the name's own
        // (`names.example/@alice` → `did:webvh:…:agent.example`), so the DID's
        // host may still need granting.
        if (!(await requestOriginPermission(vtaHost))) {
          setStatus(
            `The wallet needs access to ${displayHostFor(vtaHost)} to reach this agent. ` +
              `Click Continue again and approve the prompt.`,
          );
          return;
        }
      }

      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_PREPARE,
        vtaDid: did,
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
    const mediatorOverride = fallbackMediator.trim();
    // Seed the first phase locally. The offscreen document's own report for
    // it may not arrive before the round trip starts, and an empty checklist
    // under a "Connecting…" button is the very gap this closes.
    setStage("resolving-agent");
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_CONNECT,
        ...(ctx ? { context: ctx } : {}),
        ...(allowCreate ? { createIfMissing: true } : {}),
        // Only sent when the operator has answered the mediator prompt; the
        // VTA's own published mediator wins over this whenever there is one.
        ...(mediatorOverride ? { mediatorDid: mediatorOverride } : {}),
      })) as RuntimeOnboardConnectResponse;
      if (!res.ok) {
        // Recoverable: this VTA publishes no mediator (a bare did:peer has no
        // document to resolve). Ask for one rather than dead-ending — the
        // ephemeral grant is still valid, so answering retries immediately.
        if (res.code === MEDIATOR_REQUIRED) {
          setNeedsMediator(true);
          setStatus(null);
          return;
        }
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
      const connected = {
        vtaDid: vtaDid.trim(),
        holderDid: res.result.holderDid,
        role: res.result.role,
        ...(prep?.restBaseUrl ? { restBaseUrl: prep.restBaseUrl } : {}),
        ...(prep?.mediatorDid ? { mediatorDid: prep.mediatorDid } : {}),
        connectedAt: Date.now(),
        secretEncrypted: res.result.secretEncrypted,
      };
      // Embedded in the setup spine, the lock is step 3 and owns that prompt.
      // Showing this component's own encrypt screen as well asked the same
      // question twice in a row, in two different visual languages. Commit
      // and let the spine advance to locking.
      if (!standalone && !onCancel) {
        finalizeConnection(connected);
        return;
      }
      setPendingConnect(connected);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  /** Copy the grant command and mark the step done. Shared by the command
   *  block and its button so both click targets behave identically. */
  function copyCommand() {
    if (!prep) return;
    const cmd = allowCreate ? prep.command.replace("--role admin", "--role super-admin") : prep.command;
    void navigator.clipboard.writeText(cmd);
    setCommandCopied(true);
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
        <small style={{ color: "var(--w-muted)" }}>
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
              background: "var(--w-accent)",
              color: "var(--w-accent-ink)",
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
              color: "var(--w-accent)",
              background: "var(--w-accent-soft)",
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
        <small style={{ color: "var(--w-warn)" }}>
          Heads up: if you lose access to this authenticator without first disabling encryption,
          the wallet becomes unrecoverable — the seed is bound to that authenticator&apos;s PRF
          output and can&apos;t be retrieved from the browser alone.
        </small>
        {encryptError && (
          <small style={{ color: "var(--w-danger)" }}>
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
              color: "var(--w-muted)",
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
        <button onClick={() => setContextCandidates(null)} disabled={busy} style={button()}>
          Cancel
        </button>
        {status && <small style={{ color: "var(--w-danger)" }}>{status}</small>}
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
        {/* Once the command has been copied it collapses to a single line.
            Leaving the block and its Copy button in place made the screen
            shift under the operator after they had already run it, which
            reads as "you still need to copy this" — the opposite of true.
            The command stays one click away, because a failed paste is a
            real thing. */}
        {commandCopied ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              fontSize: t.sm,
              color: c.muted,
            }}
          >
            <span style={{ color: c.ok, fontWeight: 620 }}>✓ Command copied</span>
            <span>Run it as an existing admin, then continue below.</span>
            <button onClick={() => setCommandCopied(false)} style={button("quiet")}>
              Show again
            </button>
          </div>
        ) : (
          <>
            <small>
              Run this once as an existing admin (grants a one-time ephemeral key the wallet
              rotates away on connect):
            </small>
            {/* The whole block is the click target, not just the button —
                a command you are meant to copy should behave like one. */}
            <button
              onClick={copyCommand}
              title="Copy to clipboard"
              style={{
                ...mono,
                display: "block",
                width: "100%",
                textAlign: "left",
                background: c.accentSoft,
                border: `1px solid ${c.accent}`,
                padding: "10px 12px",
                borderRadius: "var(--w-r-sm)",
                cursor: "pointer",
                color: c.text,
              }}
            >
              {commandToShow}
            </button>
            <div>
              <button onClick={copyCommand} style={button("primary")}>
                Copy command
              </button>
            </div>
          </>
        )}
        {allowCreate && (
          <small style={{ color: "var(--w-warn)" }}>
            Note: <code style={mono}>--role super-admin</code> is required because the wallet will
            ask the VTA to create the context inline.
          </small>
        )}
        <small>
          Transport:{" "}
          {prep.mediatorDid ? "DIDComm (authcrypt)" : prep.restBaseUrl ? "REST" : "none"}
        </small>
        {needsMediator && (
          <div
            style={{
              display: "grid",
              gap: 6,
              padding: 10,
              borderLeft: `2px solid ${c.warn}`,
              background: c.warnSoft,
              borderRadius: "0 var(--w-r-sm) var(--w-r-sm) 0",
            }}
          >
            <strong style={{ fontSize: t.sm }}>This VTA doesn&apos;t publish a mediator</strong>
            <small style={{ color: c.muted, lineHeight: 1.5 }}>
              Onboarding routes through a mediator, and this VTA&apos;s record doesn&apos;t name
              one. Enter the mediator it uses — whoever operates the VTA will have given you the
              address.
            </small>
            <input
              placeholder="did:webvh:…"
              value={fallbackMediator}
              onChange={(e) => setFallbackMediator(e.target.value)}
              style={mono}
              aria-label="Mediator DID"
            />
          </div>
        )}
        {/* Emphasis follows the sequence rather than sitting on both buttons
            at once. Until the command is copied, connecting is premature —
            the grant does not exist yet — so Copy holds the primary style and
            this stays quiet. Once copied, it takes over. Two primaries would
            have meant neither read as the next thing to do. */}
        <button
          onClick={() => void connect()}
          disabled={busy || (needsMediator && fallbackMediator.trim() === "")}
          style={{
            ...button(commandCopied ? "primary" : "default"),
            ...(busy || (needsMediator && fallbackMediator.trim() === "")
              ? { opacity: 0.5, cursor: "default" }
              : {}),
          }}
        >
          {busy
            ? "Connecting…"
            : needsMediator
              ? "Connect via this mediator"
              : "I've run it — Connect"}
        </button>
        <button onClick={() => setPrep(null)} disabled={busy} style={button()}>
          Cancel
        </button>
        {stage && <ConnectProgress stage={stage} />}
        {status && <small style={{ color: c.danger }}>{status}</small>}
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
            color: "var(--w-accent)",
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
      {/* No heading when embedded in the setup spine — step 1 already says
          "Your trust agent", and repeating it as "Connect to a VTA" made the
          page read as two competing asks. */}
      {(onCancel || standalone) && (
        <h3 style={{ margin: 0, fontSize: t.md }}>
          {onCancel ? "Add another trust agent" : "Connect to a VTA"}
        </h3>
      )}
      <label style={{ display: "grid", gap: 5 }}>
        <span style={{ fontSize: t.sm, fontWeight: 600 }}>Agent address</span>
        <span style={{ fontSize: t.xs, color: c.muted }}>
          A name like <code>webvh.storm.ws/@glenn-vta</code>, or the full <code>did:webvh:…</code>
        </span>
        <input
          placeholder="webvh.storm.ws/@your-agent"
          value={vtaDid}
          onChange={(e) => setVtaDid(e.target.value)}
          style={{ ...mono, width: "100%" }}
        />
        {/* Classification is a local string test, so this updates as you type
            with no network. */}
        {vtaDid.trim() !== "" && (
          <span style={{ fontSize: t.xs, color: c.faint }}>
            {looksLikeAgentName(vtaDid)
              ? parseAgentName(vtaDid)
                ? "Reads as an agent name — the wallet will look up the DID behind it."
                : "Looks like a name but isn't valid. Expected host/@name."
              : vtaDid.trim().startsWith("did:")
                ? "Reads as a DID."
                : "Expected an agent name (host/@name) or a DID."}
          </span>
        )}
      </label>

      {/* The DID is what gets stored and connected to; a name is only a lookup
          key and can be re-pointed by its domain at any time. Showing both
          makes the substitution visible rather than silent. */}
      {resolvedFrom && (
        <div
          style={{
            display: "grid",
            gap: 3,
            padding: "9px 12px",
            borderLeft: `2px solid ${c.ok}`,
            background: c.okSoft,
            borderRadius: "0 var(--w-r-sm) var(--w-r-sm) 0",
          }}
        >
          <span style={{ fontSize: t.sm, fontWeight: 620 }}>
            {resolvedFrom.name} is confirmed
          </span>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            That DID&apos;s own record claims this name. Connecting to:
          </span>
          <code style={{ ...mono, fontSize: t.xs }}>{resolvedFrom.did}</code>
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        <span style={{ ...microLabel }}>Workspace</span>
        <label style={{ fontSize: t.sm, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="radio"
            name="ctx-mode"
            checked={contextMode === "vta-derived"}
            onChange={() => {
              setContextMode("vta-derived");
              setCreateIfMissing(false);
            }}
            style={{ width: "auto", padding: 0 }}
          />
          Let the agent choose{" "}
          <span style={{ color: c.muted }}>— right unless you&apos;re told otherwise</span>
        </label>
        <label style={{ fontSize: t.sm, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="radio"
            name="ctx-mode"
            checked={contextMode === "override"}
            onChange={() => setContextMode("override")}
            style={{ width: "auto", padding: 0 }}
          />
          Name one myself
        </label>
        {contextMode === "override" && (
          <div
            style={{ display: "grid", gap: 6, paddingLeft: 22, marginTop: 2 }}
          >
            <input
              placeholder="ctx_… (e.g. work, alpha)"
              value={contextOverride}
              onChange={(e) => setContextOverride(e.target.value)}
              style={{ ...mono, width: "100%" }}
            />
            <label style={{ fontSize: t.xs, display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={createIfMissing}
                onChange={(e) => setCreateIfMissing(e.target.checked)}
                style={{ width: "auto", padding: 0 }}
              />
              Create it on the agent if it doesn&apos;t exist (needs a super-admin grant)
            </label>
          </div>
        )}
      </div>

      <div>
        <button
          onClick={() => void prepare()}
          disabled={
            !vtaDid.trim() ||
            busy ||
            // When overriding, require a non-empty name. VTA-derived
            // imposes no extra precondition.
            (contextMode === "override" && contextOverride.trim().length === 0)
          }
          style={{
            ...button("primary"),
            ...(!vtaDid.trim() ||
            busy ||
            (contextMode === "override" && contextOverride.trim().length === 0)
              ? { opacity: 0.5, cursor: "default" }
              : {}),
          }}
        >
          {resolvingName ? "Looking up the name…" : busy ? "Resolving…" : "Continue"}
        </button>
      </div>
      {status && <small style={{ color: c.danger }}>{status}</small>}
    </div>
  );
}

/**
 * Ordered checklist of what connecting is actually doing.
 *
 * Every step is shown from the start, not revealed one at a time: seeing
 * what remains is most of the reassurance a progress display gives. Steps
 * before the current one are ticked, the current one is named as in-progress,
 * and later ones sit greyed. No percentage and no bar — the phases have no
 * knowable duration, and a bar that stalls at 60% is worse than a list.
 */
function ConnectProgress({ stage }: { stage: OnboardStage }) {
  const LABEL: Record<OnboardStage, string> = {
    "resolving-agent": "Looking up your agent",
    "connecting-mediator": "Opening a secure channel",
    "provisioning": "Asking the agent for your identity",
    "installing-identity": "Saving it to this browser",
  };
  const current = ONBOARD_STAGES.indexOf(stage);

  return (
    <div
      style={{
        display: "grid",
        gap: 7,
        padding: "11px 13px",
        background: c.accentSoft,
        borderRadius: "var(--w-r-sm)",
      }}
      aria-live="polite"
    >
      {ONBOARD_STAGES.map((s, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <div
            key={s}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: t.sm,
              color: done ? c.muted : now ? c.text : c.faint,
              fontWeight: now ? 620 : 400,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14,
                textAlign: "center",
                color: done ? c.ok : now ? c.accent : c.faint,
              }}
            >
              {done ? "✓" : now ? "○" : "·"}
            </span>
            {LABEL[s]}
            {now && <span style={{ color: c.muted, fontWeight: 400 }}>…</span>}
          </div>
        );
      })}
    </div>
  );
}
