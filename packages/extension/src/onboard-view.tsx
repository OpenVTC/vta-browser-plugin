/// <reference types="chrome" />

// VTA onboarding — the multi-step provisioning flow.
//
// Lifted out of popup.tsx so it can run in a full tab. It was not merely
// cramped there: Chrome tears down the action popup when a native dialog takes
// focus (crbug 40721470), and this flow raises two of them — the
// host-permission grant and the WebAuthn PRF ceremony. A tab is immune to that
// teardown, which is the whole reason for the move.
//
// ## The two questions this asks, and why they are two
//
// **What will this wallet do here** decides the ACL entry the agent writes:
// `"context"` — a party inside one context — or `"unrestricted"`, the shape an
// ACL reads as a super-admin, which is what the management console needs to
// administer the agent at all.
//
// **Where does it keep its settings** decides the context the admin DID is
// minted in and the wallet's own configuration lives in. It is asked in *both*
// cases, and that is the point: an unrestricted wallet reaches every context
// and still keeps its state in exactly one. Expressing scope by leaving the
// context blank would have left the console with nowhere to put it.
//
// Neither is a preference the wallet can infer. The agent used to be allowed
// to pick the context (`payload.context` omitted, inference rules run) and its
// reply did not have to say which it picked, so a wallet could finish
// onboarding without knowing where its own configuration had landed. Both are
// now always named, which also makes `provision/integration:contextRequired`
// unreachable — inference never runs — and the picker that used to recover
// from it is gone rather than kept for a case that cannot arise.
//
// ## Why the order differs between the two
//
// The grant command has to match the scope, and only the operator can run it:
//
//   * `"unrestricted"` → `pnm acl create … --role admin` with **no**
//     `--contexts`. The command needs no context, so the home context is
//     chosen *after* the grant, from the list the now-authorised ephemeral can
//     actually read (`vta/contexts/list`). A picker of real contexts beats a
//     slug typed from memory.
//   * `"context"` → the command carries `--contexts <id>`, so the context has
//     to be known *before* it is printed. It is asked as a text field, which
//     is not a downgrade: the operator is about to type the same string into
//     their own terminal.
//
// The provisioning sequence itself is otherwise unchanged.

import { useEffect, useState } from "react";
import { useConnectionStore } from "./store.js";
import { didWebvhDomain, type AdminScope } from "@openvtc/pnm-core";
import {
  looksLikeAgentName,
  parseAgentName,
} from "./agent-name.js";
import {
  MEDIATOR_REQUIRED,
  ONBOARD_STAGES,
  RUNTIME_ONBOARD_CONNECT,
  RUNTIME_ONBOARD_CONTEXTS,
  RUNTIME_ONBOARD_PROGRESS,
  RUNTIME_ONBOARD_PREPARE,
  RUNTIME_RESOLVE_AGENT_NAME,
  type ContextRecordView,
  type OnboardPrepareResult,
  type OnboardStage,
  type RuntimeOnboardProgressMessage,
  type RuntimeOnboardConnectResponse,
  type RuntimeOnboardContextsResponse,
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
  // What this wallet is being set up to do at the agent. Defaults to the
  // narrower answer: a wallet that turns out to need the whole agent can be
  // set up again, where one that was silently granted it cannot be un-granted
  // without an operator noticing there was something to notice.
  const [adminScope, setAdminScope] = useState<AdminScope>("context");
  // The home context. For a context-scoped grant it is typed before the
  // command (the command needs it); for an unrestricted one it is picked
  // afterwards, from `contexts` below.
  const [homeContext, setHomeContext] = useState("");
  const [createIfMissing, setCreateIfMissing] = useState(false);
  const [prep, setPrep] = useState<OnboardPrepareResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The agent's own contexts, read as the granted ephemeral after `prepare`.
  // `null` while unasked or unavailable — distinct from `[]`, which is an
  // agent that answered and holds none. The unrestricted path shows a picker
  // when this is a non-empty list and a text field otherwise, because an agent
  // that cannot list its contexts can still provision into one that is named.
  const [contexts, setContexts] = useState<ContextRecordView[] | null>(null);
  const [contextsError, setContextsError] = useState<string | null>(null);
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
    /** What the agent said it did, carried through to the stored connection
     *  unchanged. Never the ask — see `OnboardConnectResult`. */
    homeContext: string;
    agentScope: AdminScope;
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

  const effectiveContext = homeContext.trim();
  // Creating a context inline needs an unrestricted grant — the agent's
  // context-create gate refuses everything below — so it is only offered
  // where the grant already is one. A context-scoped operator who needs a new
  // context makes it themselves, which is the same ceremony they used to make
  // the one they are scoping to.
  const allowCreate = adminScope === "unrestricted" && createIfMissing;
  /** The home context must be known before the grant command can be printed
   *  for a context-scoped wallet, because the command carries it. An
   *  unrestricted grant names no context, so the question waits until the
   *  ephemeral can read the real list. */
  const contextNeededBeforeGrant = adminScope === "context";

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
        adminScope,
        // Only carried for the scope whose command names it. Sending it for an
        // unrestricted grant would be sending a value the command must not
        // contain, which is the "too narrow" failure in `grant-command.ts`.
        ...(contextNeededBeforeGrant && effectiveContext ? { context: effectiveContext } : {}),
      })) as RuntimeOnboardPrepareResponse;
      if (!res.ok) throw new Error(res.error);
      setPrep(res.result);
      // The ephemeral now exists but is not yet granted, so this will fail
      // until the operator runs the command. Asked again from the grant
      // screen's Refresh, which is where the answer is actually needed.
      if (adminScope === "unrestricted") void loadContexts();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Ask the agent which contexts this grant can reach.
   *
   *  Speaks as the ephemeral, so it only answers once the operator has run the
   *  grant command — before that the agent refuses it, which is why the
   *  failure is shown as a hint next to Refresh rather than as an error. A
   *  wallet can still be onboarded with the list unavailable: the picker falls
   *  back to a text field, and the agent is the one that decides either way. */
  async function loadContexts() {
    setContextsError(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_CONTEXTS,
      })) as RuntimeOnboardContextsResponse;
      if (!res.ok) {
        setContextsError(res.error);
        return;
      }
      setContexts(res.result.contexts);
      // Pre-select only when there is no ambiguity to resolve. With several,
      // choosing for the operator would make the most consequential field on
      // the screen the one they never looked at.
      if (res.result.contexts.length === 1 && !homeContext) {
        setHomeContext(res.result.contexts[0]!.id);
      }
    } catch (e) {
      setContextsError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Connect with the chosen home context.
   *
   *  `forceContext` exists for the picker, which passes the context the
   *  operator just clicked rather than waiting for React state to commit. */
  async function connect(forceContext?: string) {
    setBusy(true);
    setStatus(null);
    const ctx = forceContext ?? effectiveContext;
    if (!ctx) {
      // Unreachable from the UI, which disables the button — but the wire
      // member is required and a silent omission would put the agent back in
      // charge of choosing, which is the whole thing this flow ended.
      setBusy(false);
      setStatus("Pick where this wallet should keep its settings first.");
      return;
    }
    const mediatorOverride = fallbackMediator.trim();
    // Seed the first phase locally. The offscreen document's own report for
    // it may not arrive before the round trip starts, and an empty checklist
    // under a "Connecting…" button is the very gap this closes.
    setStage("resolving-agent");
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_ONBOARD_CONNECT,
        context: ctx,
        adminScope,
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
        // No `contextRequired` branch. The wallet always names its context,
        // so the agent's inference rules never run and that refusal cannot
        // arrive — a recovery path for it would be code no test could reach
        // and no deployment could produce.
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
        // Straight from the agent's reply. Not `ctx` and not `adminScope`:
        // those are what we asked for, and an agent that ignored an
        // `unrestricted` ask replies success either way.
        homeContext: res.result.context,
        agentScope: res.result.adminScope,
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
    // Copied verbatim. This used to rewrite `--role admin` into `--role
    // super-admin` when the operator asked to create a context inline — a
    // role `pnm acl create` does not have, so the command it printed could
    // not run. The scope is now expressed the way the CLI expresses it
    // (`--contexts`, present or absent) and decided once, in
    // `grant-command.ts`, where a test can see it.
    void navigator.clipboard.writeText(prep.command);
    setCommandCopied(true);
  }

  // Finalize the pending connection: commit to zustand → ConnectedView.
  function finalizeConnection(pc: PendingConnect) {
    setConnection({
      vtaDid: pc.vtaDid,
      holderDid: pc.holderDid,
      role: pc.role,
      homeContext: pc.homeContext,
      agentScope: pc.agentScope,
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

  if (prep) {
    const commandToShow = prep.command;
    return (
      <div style={box}>
        <h3 style={{ margin: 0 }}>Grant this wallet</h3>
        <small>
          {adminScope === "unrestricted" ? (
            <>
              This grants the wallet <strong>the whole agent</strong> — it will be able to
              administer every context, including ones made later.
            </>
          ) : (
            <>
              This grants the wallet <strong>one context</strong>:{" "}
              <code style={mono}>{effectiveContext}</code>. It won&apos;t be able to see the
              others.
            </>
          )}
        </small>
        {adminScope === "unrestricted" && (
          <small style={{ color: c.muted }}>
            You&apos;ll need to be running this as someone who already has the whole agent —
            an admin scoped to one context can&apos;t hand out more than they hold.
          </small>
        )}
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
        {/* The home context, for the scope that could not be asked earlier.
            The grant is run by now, so the ephemeral can read the agent's
            real context list — a picker of what exists, rather than a slug
            typed from memory into the most consequential field here. */}
        {adminScope === "unrestricted" && (
          <div
            style={{
              display: "grid",
              gap: 7,
              padding: 11,
              borderLeft: `2px solid ${c.accent}`,
              background: c.accentSoft,
              borderRadius: "0 var(--w-r-sm) var(--w-r-sm) 0",
            }}
          >
            <strong style={{ fontSize: t.sm }}>Where should this wallet keep its settings?</strong>
            <small style={{ color: c.muted, lineHeight: 1.5 }}>
              Even managing the whole agent, the wallet&apos;s own identity and settings live in
              one context. Everything it stores for itself goes here.
            </small>
            {contexts && contexts.length > 0 ? (
              <div style={{ display: "grid", gap: 4 }}>
                {contexts.map((ctx) => (
                  <button
                    key={ctx.id}
                    onClick={() => setHomeContext(ctx.id)}
                    style={{
                      textAlign: "left",
                      ...(homeContext === ctx.id
                        ? { borderColor: c.accent, background: c.raised }
                        : {}),
                    }}
                  >
                    <span style={mono}>{ctx.id}</span>
                    {ctx.name && ctx.name !== ctx.id && (
                      <span style={{ color: c.muted }}> — {ctx.name}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <>
                {/* Reachable two ways, and the copy has to cover both: the
                    grant has not been run yet (the agent refuses a listing
                    from an unauthorised ephemeral), or the agent answered and
                    holds nothing this grant can reach. Typing still works in
                    both — with "create it" ticked, the second becomes the
                    first context. */}
                <input
                  placeholder="ctx_… (e.g. work, alpha)"
                  value={homeContext}
                  onChange={(e) => setHomeContext(e.target.value)}
                  aria-label="Home context"
                  style={{ ...mono, width: "100%" }}
                />
                <small style={{ color: c.muted }}>
                  {contexts?.length === 0
                    ? "This agent has no contexts yet — name one and tick below to create it."
                    : "Run the command above first, then Refresh to pick from the agent's own list."}
                </small>
              </>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={() => void loadContexts()} style={button("quiet")}>
                Refresh list
              </button>
              <label style={{ fontSize: t.xs, display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={createIfMissing}
                  onChange={(e) => setCreateIfMissing(e.target.checked)}
                  style={{ width: "auto", padding: 0 }}
                />
                Create it if it doesn&apos;t exist
              </label>
            </div>
            {contextsError && (
              <small style={{ color: c.muted }}>
                Couldn&apos;t read the agent&apos;s contexts: {contextsError}
              </small>
            )}
          </div>
        )}
        {/* Emphasis follows the sequence rather than sitting on both buttons
            at once. Until the command is copied, connecting is premature —
            the grant does not exist yet — so Copy holds the primary style and
            this stays quiet. Once copied, it takes over. Two primaries would
            have meant neither read as the next thing to do. */}
        <button
          onClick={() => void connect()}
          disabled={
            busy ||
            !effectiveContext ||
            (needsMediator && fallbackMediator.trim() === "")
          }
          style={{
            ...button(commandCopied ? "primary" : "default"),
            ...(busy ||
            !effectiveContext ||
            (needsMediator && fallbackMediator.trim() === "")
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
          aria-label="Agent address"
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
        <span style={{ ...microLabel }}>What this wallet will do</span>
        {/* Two answers, and they are not a preference — they decide the ACL
            entry the agent writes and therefore the grant command below.
            Named for what the person gets, not for the ACL shape: an operator
            reading "unrestricted scope" has to already know what an empty
            context list means. */}
        <label style={{ fontSize: t.sm, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="radio"
            name="admin-scope"
            checked={adminScope === "context"}
            onChange={() => {
              setAdminScope("context");
              setCreateIfMissing(false);
            }}
            style={{ width: "auto", padding: 0, marginTop: 3 }}
          />
          <span>
            Work inside one context
            <span style={{ color: c.muted }}>
              {" "}— act as yourself in a single context. It can&apos;t see the others.
            </span>
          </span>
        </label>
        <label style={{ fontSize: t.sm, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="radio"
            name="admin-scope"
            checked={adminScope === "unrestricted"}
            onChange={() => setAdminScope("unrestricted")}
            style={{ width: "auto", padding: 0, marginTop: 3 }}
          />
          <span>
            Manage the whole agent
            <span style={{ color: c.muted }}>
              {" "}— administer every context from the management console. Needs someone who
              already has the whole agent to grant it.
            </span>
          </span>
        </label>

        {/* Asked here only for the scope whose grant command carries it.
            The other half asks after the grant, from the agent's real list —
            see the header comment on why the order differs. */}
        {contextNeededBeforeGrant ? (
          <label style={{ display: "grid", gap: 5, marginTop: 4 }}>
            <span style={{ fontSize: t.sm, fontWeight: 600 }}>Which context?</span>
            <span style={{ fontSize: t.xs, color: c.muted }}>
              Where this wallet acts, and where it keeps its own settings. You&apos;ll name the
              same one in the command on the next screen.
            </span>
            <input
              placeholder="ctx_… (e.g. work, alpha)"
              value={homeContext}
              onChange={(e) => setHomeContext(e.target.value)}
              aria-label="Home context"
              style={{ ...mono, width: "100%" }}
            />
          </label>
        ) : (
          <small style={{ color: c.faint, marginTop: 2 }}>
            You&apos;ll pick where the wallet keeps its own settings on the next screen, from
            this agent&apos;s own list of contexts.
          </small>
        )}
      </div>

      <div>
        <button
          onClick={() => void prepare()}
          // A context-scoped grant cannot be prepared without its context:
          // the command would come out naming none, which is the
          // whole-agent grant. `grantCommand` refuses it too — this is so
          // the operator sees why rather than an error after a click.
          disabled={
            !vtaDid.trim() || busy || (contextNeededBeforeGrant && !effectiveContext)
          }
          style={{
            ...button("primary"),
            ...(!vtaDid.trim() || busy || (contextNeededBeforeGrant && !effectiveContext)
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
