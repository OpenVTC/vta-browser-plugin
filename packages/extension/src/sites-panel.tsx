/// <reference types="chrome" />

// The Sites screen — one table answering "what can this site do?".
//
// Two unrelated permissions used to live in two places, or nowhere:
//
//  - **Can act without asking** — the "Remember this site" consent trust in
//    `trusted-sites.ts`. Already listed on the options page.
//  - **Wallet can reach it** — the just-in-time host grant in
//    `host-permissions.ts`. Had no interface at all; `chrome://extensions` was
//    the only way to see or revoke one.
//
// They are opposite directions of the same relationship — one is what a site
// may ask of the wallet, the other is what the wallet may do to a site — so
// they belong in one row per site, revocable independently.

import { useCallback, useEffect, useState } from "react";
import { listTrustedSites, untrustOrigin } from "./trusted-sites.js";
import {
  listGrantedOrigins,
  hasBlanketAccess,
  revokeOriginPermission,
  displayHostFor,
} from "./host-permissions.js";
import { mergeSiteRows, relativeDay, type SiteRow } from "./sites-model.js";
import { c, t } from "./theme.js";
import { Button, Empty, Note, Panel, Pill } from "./ui.js";

export function SitesPanel() {
  const [rows, setRows] = useState<SiteRow[] | null>(null);
  const [blanket, setBlanket] = useState(false);
  const [busyHost, setBusyHost] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [trusted, granted, isBlanket] = await Promise.all([
      listTrustedSites(),
      listGrantedOrigins(),
      hasBlanketAccess(),
    ]);
    setRows(mergeSiteRows(trusted, granted, displayHostFor));
    setBlanket(isBlanket);
  }, []);

  useEffect(() => {
    void refresh();
    // Grants can change from anywhere — the popup's "Sign in to…" button, the
    // setup flow, or chrome://extensions in another tab. Without this the
    // screen quietly shows a stale answer to a security question.
    const onChanged = () => void refresh();
    chrome.permissions.onAdded.addListener(onChanged);
    chrome.permissions.onRemoved.addListener(onChanged);
    return () => {
      chrome.permissions.onAdded.removeListener(onChanged);
      chrome.permissions.onRemoved.removeListener(onChanged);
    };
  }, [refresh]);

  async function disconnect(row: SiteRow) {
    if (!row.trusted) return;
    setBusyHost(row.host);
    try {
      await untrustOrigin(row.trusted.origin);
      await refresh();
    } finally {
      setBusyHost(null);
    }
  }

  async function revokeAccess(row: SiteRow) {
    if (!row.grantedPattern) return;
    setBusyHost(row.host);
    try {
      await revokeOriginPermission(row.grantedPattern);
      await refresh();
    } finally {
      setBusyHost(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel
        title="Sites"
        description="Everything this wallet is allowed to do, per site. Revoking is safe — nothing breaks permanently, you'll just be asked again next time."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 10,
          }}
        >
          <Legend
            edge={c.accent}
            title="Can act without asking"
            body="You ticked “Remember this site”. It can sign you in and read vault entries with no prompt."
          />
          <Legend
            edge={c.ok}
            title="Wallet can reach it"
            body="You granted access to this host, so the wallet can make requests to it and run the page provider there."
          />
        </div>
      </Panel>

      {blanket && (
        <Note tone="warn">
          <strong>This wallet currently holds access to every site.</strong> Per-site grants
          below don&apos;t limit anything while that is true. Remove the blanket permission
          from <code>chrome://extensions</code> → Site access to get one-site-at-a-time control back.
        </Note>
      )}

      <Panel>
        {rows === null ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            No sites yet. They appear here once you connect to a trust agent or sign in to a
            site from your vault.
          </Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: t.sm }}>
              <thead>
                <tr>
                  <Th style={{ width: "42%" }}>Site</Th>
                  <Th>Can act without asking</Th>
                  <Th>Wallet can reach it</Th>
                  <Th style={{ textAlign: "right" }}>
                    <span style={{ position: "absolute", left: -9999 }}>Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.host}>
                    <Td>
                      <div style={{ fontFamily: "var(--w-mono)", wordBreak: "break-all" }}>
                        {row.host}
                      </div>
                      {row.trusted && (
                        <div style={{ fontSize: t.xs, color: c.muted, marginTop: 2 }}>
                          Connected {relativeDay(row.trusted.trustedAt)}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {row.trusted ? <Pill tone="accent">Yes</Pill> : <Pill tone="off">Not set</Pill>}
                    </Td>
                    <Td>
                      {row.grantedPattern ? (
                        <Pill tone="ok">Granted</Pill>
                      ) : (
                        <Pill tone="off">Not granted</Pill>
                      )}
                    </Td>
                    <Td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {row.trusted && (
                        <Button
                          kind="danger"
                          disabled={busyHost === row.host}
                          onClick={() => void disconnect(row)}
                          title={`Stop ${row.host} acting without a prompt`}
                        >
                          Disconnect
                        </Button>
                      )}
                      {row.grantedPattern && (
                        <Button
                          kind="danger"
                          disabled={busyHost === row.host}
                          onClick={() => void revokeAccess(row)}
                          title={`Stop the wallet reaching ${row.host}`}
                        >
                          Revoke access
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Legend({ edge, title, body }: { edge: string; title: string; body: string }) {
  return (
    <div
      style={{
        borderLeft: `2px solid ${edge}`,
        border: `1px solid ${c.line}`,
        borderLeftColor: edge,
        borderLeftWidth: 2,
        borderRadius: "var(--w-r-sm)",
        padding: "10px 13px",
        background: c.ground,
      }}
    >
      <div style={{ fontWeight: 620, fontSize: t.sm, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      style={{
        textAlign: "left",
        fontSize: "10.5px",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: c.faint,
        fontWeight: 650,
        padding: "0 12px 9px 0",
        borderBottom: `1px solid ${c.line}`,
        position: "relative",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
      style={{
        padding: "12px 12px 12px 0",
        borderBottom: `1px solid ${c.lineSoft}`,
        verticalAlign: "middle",
        ...style,
      }}
    >
      {children}
    </td>
  );
}
