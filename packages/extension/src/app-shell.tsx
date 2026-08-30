/// <reference types="chrome" />

// The full-page wallet shell: rail navigation over four panes.
//
// Replaces a single flat scroll of every setting the wallet has. The split is
// by what the user came to do, not by which subsystem owns the value:
//
//   Setup     — get working, and the few things you revisit
//   Vault     — credentials and sessions
//   Sites     — what each site is allowed to do
//   Advanced  — transport, executors, push, approver identity
//
// Routing is on `location.hash` so the pane is linkable: `onInstalled` opens
// `options.html#setup` on a fresh install, and the popup deep-links here
// rather than trying to host multi-step flows in a container Chrome tears
// down (crbug 40721470).

import { useCallback, useEffect, useState } from "react";
import { useActiveConnection } from "./store.js";
import { SetupPane } from "./setup-pane.js";
import { NetworkPane } from "./network-pane.js";
import { SitesPanel } from "./sites-panel.js";
import { getSettings } from "./config.js";
import { activeTransport } from "./transports.js";
import { useTransportHealth } from "./use-transport-health.js";
import { c, t } from "./theme.js";
import { Button, Note, Pill } from "./ui.js";
import { unlockWalletAndApprover } from "./unlock-wallet.js";
import { sendToBackground } from "./send-message.js";
import {
  RUNTIME_APPROVER_STATE,
  RUNTIME_WALLET_LOCK_STATE,
  type RuntimeApproverStateResponse,
  type RuntimeWalletLockStateResponse,
} from "./bridge-protocol.js";
import { PrfUnlockError } from "./webauthn-prf-unlock.js";

/**
 * Unlock prompt for the full-page wallet.
 *
 * Settings render straight from storage, so a locked wallet looked entirely
 * alive here — right up until an operation failed for no visible reason. The
 * popup was the only place that could unlock, which is not where someone
 * already working in options thinks to look.
 */
function LockBanner() {
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await sendToBackground<RuntimeWalletLockStateResponse>({
        type: RUNTIME_WALLET_LOCK_STATE,
      });
      setLocked(res.ok ? res.result.encrypted && !res.result.unlocked : false);
    } catch {
      // The background not answering is its own problem; don't claim a lock
      // state we could not read.
      setLocked(false);
    }
  }, []);

  useEffect(() => {
    void check();
    // The offscreen AES cache can be dropped whenever MV3 evicts it, so this
    // is re-read rather than latched.
    const id = setInterval(() => void check(), 5000);
    return () => clearInterval(id);
  }, [check]);

  if (!locked) return null;

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      await unlockWalletAndApprover();
      await check();
    } catch (e) {
      setError(
        e instanceof PrfUnlockError && e.reason === "cancelled"
          ? "Cancelled. Click Unlock to try again."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <Note tone="warn">
        <strong>Your wallet is locked.</strong> Settings are readable, but anything that uses
        your identity — the vault, connecting, approving — will fail until you unlock with your
        passkey.
        <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
          <Button kind="primary" disabled={busy} onClick={() => void unlock()}>
            {busy ? "Waiting for your passkey…" : "Unlock"}
          </Button>
          {error && <span style={{ fontSize: t.sm, color: c.danger }}>{error}</span>}
        </div>
      </Note>
    </div>
  );
}

export type PaneId = "setup" | "network" | "vault" | "sites" | "advanced";

/** Nav icons as inline SVG rather than unicode glyphs. The geometric
 *  characters (◆ ▤ ⬡ ⚙) render at wildly different weights and baselines
 *  across fonts, so the rail read as four unrelated marks. */
const ICON: Record<PaneId, string> = {
  // Shield — the wallet's own identity and its setup.
  setup: "M7 1.5 12 3.6v3.5c0 2.5-2 4.4-5 5.4-3-1-5-2.9-5-5.4V3.6z",
  // Three linked nodes — the trust graph.
  network: "M2.6 7h3.2m2.4 0h3.2",
  // Stacked rows — a list of credentials.
  vault: "M2 3h10v2.4H2zm0 4.3h10v2.4H2zm0 4.3h10V14H2z",
  // Globe meridians — sites out on the web.
  sites: "M7 1.2a5.8 5.8 0 100 11.6A5.8 5.8 0 007 1.2zm0 1.2c1 0 2.1 1.9 2.1 4.6S8 11.6 7 11.6 4.9 9.7 4.9 7 6 2.4 7 2.4zM1.6 7h10.8",
  // Sliders — settings you adjust rather than a literal gear.
  advanced: "M2 4h5m2.6 0H12M2 10h2.6M7.2 10H12",
};

const PANES: { id: PaneId; label: string }[] = [
  { id: "setup", label: "Setup" },
  { id: "network", label: "Network" },
  { id: "vault", label: "Vault" },
  { id: "sites", label: "Sites" },
  { id: "advanced", label: "Advanced" },
];

function NavIcon({ pane, active }: { pane: PaneId; active: boolean }) {
  // `sites` and `advanced` are line drawings; the others are solid shapes.
  const stroked = pane === "sites" || pane === "advanced" || pane === "network";
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={{ flex: "none" }}>
      <path
        d={ICON[pane]}
        fill={stroked ? "none" : active ? c.accent : c.faint}
        stroke={stroked ? (active ? c.accent : c.faint) : "none"}
        strokeWidth={stroked ? 1.3 : 0}
        strokeLinecap="round"
      />
      {pane === "network" && (
        <>
          <circle cx="1.6" cy="7" r="1.4" fill={active ? c.accent : c.faint} stroke="none" />
          <circle cx="7" cy="7" r="1.4" fill={active ? c.accent : c.faint} stroke="none" />
          <circle cx="12.4" cy="7" r="1.4" fill={active ? c.accent : c.faint} stroke="none" />
        </>
      )}
      {pane === "advanced" && (
        <>
          <circle cx="8.2" cy="4" r="1.5" fill="none" stroke={active ? c.accent : c.faint} strokeWidth="1.3" />
          <circle cx="5.8" cy="10" r="1.5" fill="none" stroke={active ? c.accent : c.faint} strokeWidth="1.3" />
        </>
      )}
    </svg>
  );
}

function paneFromHash(): PaneId {
  const raw = location.hash.replace(/^#/, "");
  return PANES.some((p) => p.id === raw) ? (raw as PaneId) : "setup";
}

export function AppShell({ advanced, vault }: { advanced: React.ReactNode; vault: React.ReactNode }) {
  const [pane, setPane] = useState<PaneId>(paneFromHash);
  const connection = useActiveConnection();
  const [preferTsp, setPreferTsp] = useState(true);
  const { health: transportHealth, sessions } = useTransportHealth(connection?.vtaDid);
  // The wallet's own listening session, not just any warm one: an outbound
  // channel to the agent's mediator says nothing about whether requests can
  // arrive. Absent (no session at all) reads the same as closed, which is
  // right — both mean nothing is listening.
  const inbox = sessions.find((s) => s.isInbox)?.state ?? "closed";
  const [approver, setApprover] = useState<{ minted: boolean; running: boolean }>({
    minted: false,
    running: false,
  });

  useEffect(() => {
    void getSettings().then((s) => setPreferTsp(s.preferTsp !== false));
  }, []);

  useEffect(() => {
    // Re-read rather than latch: the approver's session is in-memory in the
    // offscreen document, which MV3 can evict at any moment.
    const read = async () => {
      const res = await sendToBackground<RuntimeApproverStateResponse>({
        type: RUNTIME_APPROVER_STATE,
      }).catch(() => null);
      if (res?.ok) setApprover({ minted: res.result.minted, running: res.result.running });
    };
    void read();
    const id = setInterval(() => void read(), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Back/forward and external deep links both arrive as hashchange.
    const onHash = () => setPane(paneFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function go(id: PaneId) {
    location.hash = id;
    setPane(id);
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "208px minmax(0, 1fr)",
        alignItems: "start",
        gap: 28,
      }}
    >
      <nav
        aria-label="Wallet sections"
        style={{
          position: "sticky",
          top: 28,
          display: "grid",
          gap: 3,
          alignContent: "start",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 8px 16px" }}>
          <Mark />
          <span style={{ fontWeight: 640, letterSpacing: "-0.01em" }}>VTA Wallet</span>
        </div>

        {PANES.map((p) => {
          const on = p.id === pane;
          return (
            <button
              key={p.id}
              onClick={() => go(p.id)}
              aria-current={on ? "page" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 9px",
                borderRadius: "var(--w-r-sm)",
                border: "1px solid transparent",
                background: on ? c.accentSoft : "transparent",
                color: on ? c.text : c.muted,
                fontWeight: on ? 600 : 400,
                fontSize: t.base,
                textAlign: "left",
                cursor: "pointer",
                width: "100%",
              }}
            >
              <NavIcon pane={p.id} active={on} />
              {p.label}
            </button>
          );
        })}

        {/* Both roles, always visible. The wallet's whole authority model is
            that these are two identities with different powers; showing only
            one of them made the split something you had to go and look for.
            Transport is named because "which protocol is this actually
            using?" is the first question when something misbehaves. */}
        <div
          style={{
            marginTop: 14,
            padding: "12px 8px 0",
            borderTop: `1px solid ${c.line}`,
            display: "grid",
            gap: 12,
          }}
        >
          <RoleStatus
            label="Operating"
            pill={connection ? <Pill tone="ok">Connected</Pill> : <Pill tone="off">Not connected</Pill>}
            note={
              connection
                ? (() => {
                    const tr = activeTransport(connection, preferTsp, transportHealth);
                    return tr ? `over ${tr}` : "no usable transport";
                  })()
                : "no agent yet"
            }
            warn={Boolean(connection) && !activeTransport(connection!, preferTsp, transportHealth)}
          />
          {/* The inbox, on its own row, because "connected" and "can be
              reached" are different states and only the second one decides
              whether an approval request ever arrives. A wallet that has
              fallen back to REST looks entirely healthy on the row above
              while nothing can be pushed to it at all (R7.2). */}
          <RoleStatus
            label="Inbox"
            pill={
              !connection ? (
                <Pill tone="off">—</Pill>
              ) : inbox === "live" ? (
                <Pill tone="ok">Live</Pill>
              ) : inbox === "connecting" ? (
                <Pill tone="warn">Connecting</Pill>
              ) : (
                <Pill tone="warn">Offline</Pill>
              )
            }
            note={
              !connection
                ? "no agent yet"
                : inbox === "live"
                  ? "can receive requests"
                  : inbox === "connecting"
                    ? "opening a mediator session"
                    : "nothing can reach this wallet"
            }
            warn={Boolean(connection) && inbox !== "live" && inbox !== "connecting"}
          />
          <RoleStatus
            label="Approval"
            pill={
              !approver.minted ? (
                <Pill tone="off">Not set up</Pill>
              ) : approver.running ? (
                <Pill tone="ok">Listening</Pill>
              ) : (
                <Pill tone="off">Ready</Pill>
              )
            }
            note={
              !approver.minted
                ? "no approver identity"
                : approver.running
                  ? "can receive remote requests"
                  : "prompts for this browser only"
            }
          />
        </div>
      </nav>

      <main style={{ minWidth: 0 }}>
        <LockBanner />
        {pane === "setup" && <SetupPane />}
        {pane === "network" && <NetworkPane />}
        {pane === "vault" && vault}
        {pane === "sites" && <SitesPanel />}
        {pane === "advanced" && advanced}
      </main>
    </div>
  );
}

/** One role's state: a pill for the state itself, a line for what it means.
 *  The note matters more than it looks — "Ready" and "Listening" differ only
 *  in whether approvals proposed on *another* device can reach you, which no
 *  single word conveys. */
function RoleStatus({
  label,
  pill,
  note,
  warn = false,
}: {
  label: string;
  pill: React.ReactNode;
  note: string;
  warn?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "start" }}>
      <span
        style={{
          fontSize: t.xs,
          textTransform: "uppercase",
          letterSpacing: "0.09em",
          fontWeight: 650,
          color: c.faint,
        }}
      >
        {label}
      </span>
      {pill}
      <span style={{ fontSize: t.xs, color: warn ? c.warn : c.muted, lineHeight: 1.4 }}>
        {note}
      </span>
    </div>
  );
}

function Mark() {
  return (
    <span
      aria-hidden
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: c.accent,
        display: "grid",
        placeItems: "center",
        flex: "none",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          d="M6 1 L10.5 3v3.2c0 2.3-1.9 4-4.5 4.8C3.4 10.2 1.5 8.5 1.5 6.2V3z"
          fill="var(--w-accent-ink)"
        />
      </svg>
    </span>
  );
}
