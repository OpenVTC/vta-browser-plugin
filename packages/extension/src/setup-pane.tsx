/// <reference types="chrome" />

// First-run setup — the four steps, in dependency order.
//
// Order is the substance here, not decoration. The agent's address comes
// first because everything else is derived from it: resolving a `did:webvh`
// yields the mediator, so the common path never asks a question the wallet
// could answer itself. Previously the mediator was a blank field on a
// different screen, which is why the README had to warn "set your mediator
// DID before doing anything else" as install step 5.
//
// The steps are a progress spine around `OnboardView`, which owns the actual
// provisioning. They report state rather than gate it — a wizard that blocks
// step 3 until step 2 "completes" would strand anyone whose agent is
// half-configured, and this flow already has enough ways to be interrupted.

import { useCallback, useEffect, useState } from "react";
import { useActiveConnection } from "./store.js";
import { getSettings, setSettings } from "./config.js";
import { readActiveHolderDid } from "./active-vta.js";
import { encryptHolderSecretInPopup } from "./encrypt-holder.js";
import { OnboardView } from "./onboard-view.js";
import { useAgentNames } from "./use-agent-names.js";
import {
  displayHostFor,
  hasOriginPermission,
  requestOriginPermission,
} from "./host-permissions.js";
import { didWebvhDomain } from "@openvtc/pnm-core";
import {
  activeTransport,
  isObserved,
  transportSummary,
  unavailableTransports,
} from "./transports.js";
import { useTransportHealth } from "./use-transport-health.js";
import { c, t } from "./theme.js";
import { Button, Did, DidNamed, Note, Panel, Pill } from "./ui.js";

type StepState = "done" | "now" | "pending";

function Step({
  n,
  state,
  title,
  children,
  last = false,
}: {
  n: number;
  state: StepState;
  title: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  const bullet: React.CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    fontSize: t.xs,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    border: `1px solid ${c.line}`,
    background: c.raised,
    color: c.faint,
    position: "relative",
    zIndex: 1,
    ...(state === "done" ? { background: c.ok, borderColor: c.ok, color: c.ground } : {}),
    ...(state === "now" ? { background: c.accent, borderColor: c.accent, color: c.accentInk } : {}),
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "26px 1fr",
        gap: "0 14px",
        paddingBottom: last ? 0 : 22,
        position: "relative",
      }}
    >
      {/* Connector, drawn behind the bullets so the spine reads continuous. */}
      {!last && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 12.5,
            top: 26,
            bottom: 0,
            width: 1,
            background: c.line,
          }}
        />
      )}
      <span style={bullet}>{state === "done" ? "✓" : n}</span>
      <div style={{ display: "grid", gap: 7, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 620,
            fontSize: t.base,
            color: state === "pending" ? c.faint : c.text,
            paddingTop: 3,
          }}
        >
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

export function SetupPane() {
  const connection = useActiveConnection();
  const [inbox, setInbox] = useState("");
  const [savedInbox, setSavedInbox] = useState("");
  const [encrypted, setEncrypted] = useState(false);
  const [holderDid, setHolderDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Routing stays closed by default — see the note in step 4.
  const [routingOpen, setRoutingOpen] = useState(false);
  const [preferTsp, setPreferTsp] = useState(true);
  // Whether the wallet may still reach its agent. Grants can vanish without
  // the wallet doing anything — switching Chrome's Site access to "On
  // specific sites" clears them — and the failure that follows is an opaque
  // CORS error deep in a later call, so it is checked up front.
  const [agentReachable, setAgentReachable] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const s = await getSettings();
    setInbox(s.mediatorDid);
    setSavedInbox(s.mediatorDid);
    setEncrypted(s.encryptHolderSecret === true);
    // preferTsp defaults on; only an explicit false pins away from TSP.
    setPreferTsp(s.preferTsp !== false);
    setHolderDid((await readActiveHolderDid()) ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load, connection?.vtaDid]);

  const agentHost = connection ? didWebvhDomain(connection.vtaDid) : undefined;

  const checkReach = useCallback(async () => {
    if (!agentHost) {
      setAgentReachable(null);
      return;
    }
    setAgentReachable(await hasOriginPermission(agentHost));
  }, [agentHost]);

  useEffect(() => {
    void checkReach();
    // Re-check when a grant lands or is withdrawn anywhere — including from
    // chrome://extensions in another tab.
    const onChange = () => void checkReach();
    chrome.permissions.onAdded.addListener(onChange);
    chrome.permissions.onRemoved.addListener(onChange);
    return () => {
      chrome.permissions.onAdded.removeListener(onChange);
      chrome.permissions.onRemoved.removeListener(onChange);
    };
  }, [checkReach]);

  async function grantAgentAccess() {
    if (!agentHost) return;
    // First await: anything before it spends the click's user gesture.
    await requestOriginPermission(agentHost);
    await checkReach();
  }


  const connected = Boolean(connection);
  const agentMediator = connection?.mediatorDid;
  // Both the agent and its mediator get looked up: the mediator is a hosted
  // identity too and usually claims its own name (`…/@mediator`).
  const agentNames = useAgentNames([connection?.vtaDid, agentMediator]);
  const { health: transportHealth } = useTransportHealth(connection?.vtaDid);
  const transport = connection ? activeTransport(connection, preferTsp, transportHealth) : undefined;
  const observed = isObserved(transportHealth);
  const broken = connection ? unavailableTransports(connection, transportHealth) : [];

  async function turnOnLock() {
    if (!connection) return;
    setBusy(true);
    setStatus(null);
    try {
      await encryptHolderSecretInPopup(connection.vtaDid);
      await load();
      setStatus("Wallet locked. You'll be asked for your passkey once per browser session.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveInbox() {
    setBusy(true);
    setStatus(null);
    try {
      await setSettings({ mediatorDid: inbox.trim() });
      setSavedInbox(inbox.trim());
      setRoutingOpen(false);
      setHolderDid((await readActiveHolderDid()) ?? "");
      setStatus("Saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const inboxChanged = inbox.trim() !== savedInbox;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel
        title={connected ? "Your wallet is set up" : "Set up your wallet"}
        description={
          connected
            ? "Everything below is already done. Come back here to turn the passkey lock on or off."
            : "Four steps. The order matters — each one depends on the last."
        }
      >
        <div style={{ display: "grid", marginTop: 4 }}>
          <Step n={1} state={connected ? "done" : "now"} title="Your trust agent">
            {connection ? (
              <>
                <div style={{ fontSize: t.sm, color: c.muted }}>
                  The service that issues and manages your credentials.
                </div>
                {agentReachable === false && agentHost && (
                  <Note tone="danger">
                    <strong>
                      The wallet can&apos;t reach {displayHostFor(agentHost)} right now.
                    </strong>{" "}
                    Access to that site was withdrawn — most often by switching Chrome&apos;s
                    Site access to &ldquo;On specific sites&rdquo;. Your wallet and its
                    credentials are untouched; it just cannot talk to your agent until you
                    allow it again.
                    <div style={{ marginTop: 8 }}>
                      <Button kind="primary" onClick={() => void grantAgentAccess()}>
                        Allow access to {displayHostFor(agentHost)}
                      </Button>
                    </div>
                  </Note>
                )}
                <DidNamed
                  value={connection.vtaDid}
                  verified
                  {...(agentNames[connection.vtaDid] ? { agentName: agentNames[connection.vtaDid] } : {})}
                />
              </>
            ) : (
              <div style={{ fontSize: t.sm, color: c.muted, maxWidth: "78ch" }}>
                Paste your agent&apos;s address below. Chrome will ask permission for its host —
                the wallet reaches only hosts you approve, one at a time.
              </div>
            )}
          </Step>

          <Step
            n={2}
            state={connected ? "done" : "pending"}
            title="How to reach it"
          >
            {connected ? (
              agentMediator ? (
                <>
                  <div style={{ fontSize: t.sm, color: c.muted }}>
                    Read from the agent&apos;s own record — nothing to enter.
                    {transport && (
                      <>
                        {" "}Messages{" "}
                        {/* "travel" once a session has actually been built;
                            "should travel" before that, because until then
                            this is read off the agent's DID document and the
                            document only says what is offered, not what
                            works. */}
                        {observed ? "travel" : "should travel"} over{" "}
                        <strong style={{ color: c.text }}>{transport}</strong>.
                      </>
                    )}
                  </div>
                  {/* The reason a transport is missing, in the one place
                      someone looks when messages are not getting through.
                      This used to be a `console.warn` on a page no ordinary
                      user opens, which is how a dark inbox went unnoticed. */}
                  {broken.map((t2) => (
                    <div
                      key={t2}
                      style={{
                        fontSize: t.sm,
                        color: c.muted,
                        borderLeft: `2px solid ${c.warn}`,
                        paddingLeft: 8,
                      }}
                    >
                      <strong style={{ color: c.text }}>{t2} unavailable.</strong>{" "}
                      {transportHealth[t2]?.detail ?? "The channel could not be opened."}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <DidNamed
                      value={agentMediator}
                      verified
                      {...(agentNames[agentMediator] ? { agentName: agentNames[agentMediator] } : {})}
                      suffix={<Pill tone="ok">Resolved</Pill>}
                    />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: t.sm, color: c.muted }}>
                  Reached over REST — this agent publishes no mediator.
                </div>
              )
            ) : (
              <div style={{ fontSize: t.sm, color: c.faint, maxWidth: "78ch" }}>
                Usually automatic. If your agent doesn&apos;t publish a mediator, you&apos;ll be
                asked for one.
              </div>
            )}
          </Step>

          <Step
            n={3}
            state={!connected ? "pending" : encrypted ? "done" : "now"}
            title="Lock your wallet with a passkey"
          >
            <div style={{ fontSize: t.sm, color: connected ? c.muted : c.faint, maxWidth: "78ch" }}>
              Locks the wallet behind Touch ID, Windows Hello, or a security key. Without it,
              anyone who can use this browser can use your wallet.
            </div>
            {connected && !encrypted && (
              <>
                {/* Written for someone who has never met the word
                    "authenticator". The earlier copy said the wallet "cannot
                    be recovered", which is untrue and scary enough that people
                    skip the lock — the actual bad outcome. State the real
                    consequence plainly instead. */}
                <Note tone="accent">
                  <strong>If you lose your passkey:</strong> you won&apos;t be able to unlock this
                  wallet any more. Nothing important is lost — your credentials are kept by your
                  trust agent, not in this browser. You&apos;d set the wallet up again and
                  reconnect, and the sites you use would need reconnecting too.
                </Note>
                <div>
                  <Button kind="primary" disabled={busy} onClick={() => void turnOnLock()}>
                    {busy ? "Working…" : "Turn on"}
                  </Button>
                </div>
              </>
            )}
            {encrypted && <Pill tone="ok">On</Pill>}
          </Step>

          <Step
            n={4}
            state={connected ? "done" : "pending"}
            title="Message routing"
            last
          >
            {/* Presented as done-and-closed, not as a question. It was a
                blank-looking field labelled "Your inbox", which invited
                editing — and editing it re-mints the wallet identity. The
                only people who should touch it are running more than one
                mediator, and they know it. */}
            <div style={{ fontSize: t.sm, color: connected ? c.muted : c.faint, maxWidth: "78ch" }}>
              Set up automatically from your agent. One relay carries messages in both
              directions, which is what almost every deployment wants.
            </div>
            {connected && (
              <>
                {holderDid && (
                  <div style={{ fontSize: t.xs, color: c.muted, marginTop: 2 }}>
                    Your wallet address: <Did value={holderDid} size={t.xs} />
                  </div>
                )}
                {!routingOpen ? (
                  <div>
                    <Button kind="quiet" onClick={() => setRoutingOpen(true)}>
                      Change routing (advanced)
                    </Button>
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
                    <Note tone="danger">
                      <strong>Don&apos;t change this unless you run a multi-mediator setup and
                      know exactly why you need to.</strong> Your inbox address is baked into
                      your wallet identity: changing it mints a brand-new one, and every site
                      and agent that knows your current address stops recognising you until you
                      re-register the new one. There is no undo.
                    </Note>
                    <input
                      value={inbox}
                      onChange={(e) => setInbox(e.target.value)}
                      placeholder="did:webvh:…"
                      aria-label="Inbox mediator DID"
                      style={{ fontFamily: "var(--w-mono)", fontSize: t.sm, width: "100%" }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button
                        kind={inboxChanged ? "danger" : "default"}
                        disabled={busy || !inboxChanged}
                        onClick={() => void saveInbox()}
                      >
                        {busy ? "Working…" : "Change inbox & re-mint identity"}
                      </Button>
                      <Button
                        kind="quiet"
                        onClick={() => {
                          setInbox(savedInbox);
                          setRoutingOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Step>
        </div>

        {status && (
          <div style={{ fontSize: t.sm, color: status.includes("fail") ? c.danger : c.ok }}>
            {status}
          </div>
        )}
      </Panel>

      {/* The provisioning flow itself. Rendered below the spine when there is
          no connection yet, and behind an explicit action afterwards so a
          working wallet doesn't present "connect" as the obvious next move. */}
      {!connected ? (
        <Panel>
          <OnboardView />
        </Panel>
      ) : (
        <AddAnother />
      )}
    </div>
  );
}

/** Adding a second VTA is a real workflow but not the default one, so it sits
 *  behind a disclosure rather than competing with the setup spine. */
function AddAnother() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div>
        <Button kind="quiet" onClick={() => setOpen(true)}>
          + Connect another trust agent
        </Button>
      </div>
    );
  }
  return (
    <Panel>
      <OnboardView onCancel={() => setOpen(false)} standalone />
    </Panel>
  );
}
