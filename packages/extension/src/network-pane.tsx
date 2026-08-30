/// <reference types="chrome" />

// The Network pane — the trust graph plus the facts you'd otherwise gather
// from four screens and a service-worker console.
//
// This exists for the moment something is wrong. Everything on it is a live
// reading, and where a value is unknown it says so rather than omitting the
// row: "approver: none" and a missing approver line look identical on screen
// but mean different things to someone debugging.

import { useEffect, useState } from "react";
import { useActiveConnection } from "./store.js";
import { getSettings } from "./config.js";
import { readActiveHolderDid, readActiveVtaDid } from "./active-vta.js";
import { approverDid, IndexedDBKVStore } from "@openvtc/pnm-core";
import { listTrustedSites, type TrustedSiteRecord } from "./trusted-sites.js";
import { identityUsage, mergeRpRows, siteTitle } from "./network-model.js";
import { displayHostFor } from "./host-permissions.js";
import {
  RUNTIME_VAULT_LIST,
  type RuntimeVaultListResponse,
  type VaultEntryView,
} from "./bridge-protocol.js";
import { useAgentNames } from "./use-agent-names.js";
import {
  activeTransport,
  advertisedTransports,
  isObserved,
  unavailableTransports,
} from "./transports.js";
import { useTransportHealth } from "./use-transport-health.js";
import { TrustGraph, displayLabel, type GraphEdge, type GraphNode } from "./trust-graph.js";
import { c, t } from "./theme.js";
import { SignInFlow } from "./signin-flow.js";
import { DtteFlow } from "./dtte-flow.js";
import { Did, Empty, Panel, Pill } from "./ui.js";
import { DiagnosticsPanel } from "./diagnostics-panel.js";

export function NetworkPane() {
  const connection = useActiveConnection();
  const [holderDid, setHolderDid] = useState("");
  const [approver, setApprover] = useState<string | null>(null);
  const [preferTsp, setPreferTsp] = useState(true);
  const [encrypted, setEncrypted] = useState(false);
  const [sites, setSites] = useState<TrustedSiteRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<VaultEntryView[]>([]);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setPreferTsp(s.preferTsp !== false);
      setEncrypted(Boolean(s.encryptHolderSecret));
      setHolderDid((await readActiveHolderDid()) ?? "");
      setSites(await listTrustedSites());
      const activeVta = await readActiveVtaDid();
      if (activeVta) setApprover(await approverDid(new IndexedDBKVStore(), activeVta));

      // Vault entries, not just trusted sites: an entry is what actually
      // determines which identity a given site sees. A locked wallet or an
      // unreachable agent makes this fail, which is fine — the graph then
      // falls back to trusted sites and says the DID is unknown.
      try {
        const res = (await chrome.runtime.sendMessage({
          type: RUNTIME_VAULT_LIST,
        })) as RuntimeVaultListResponse;
        if (res.ok) setEntries(res.result.entries);
      } catch {
        /* leave entries empty; the RP nodes degrade to origin-only */
      }
    })();
  }, [connection?.vtaDid]);

  const mediator = connection?.mediatorDid ?? connection?.tspMediatorDid;
  const names = useAgentNames([
    connection?.vtaDid,
    mediator,
    approver ?? undefined,
    // Relying parties are hosted identities too, and so are the personas we
    // present to them.
    ...sites.slice(0, 3).map((s) => s.rpDid),
    ...entries.slice(0, 6).map((e) => e.principalDid),
  ]);
  const { health: transportHealth } = useTransportHealth(connection?.vtaDid);
  const transport = connection ? activeTransport(connection, preferTsp, transportHealth) : undefined;

  if (!connection) {
    return (
      <Panel title="Network" description="A picture of who your wallet talks to.">
        <Empty>Nothing to draw yet — connect a trust agent under Setup first.</Empty>
      </Panel>
    );
  }

  // Build the graph. A REST-only connection genuinely has no mediator hop, so
  // the node is omitted rather than drawn empty — the diagram should show the
  // topology that exists, not a template with a gap in it.
  const nodes: GraphNode[] = [
    {
      id: "self",
      role: "Operating identity",
      label: "Your wallet",
      ...(holderDid ? { did: holderDid } : {}),
      detail: encrypted ? "locked with a passkey" : "not locked",
      tone: "self",
      facts: [
        { label: "Wallet address", value: holderDid || "not minted yet" },
        {
          label: "Shown to sites?",
          value: "no — each site sees its own identity from your vault, never this address",
        },
        { label: "Passkey lock", value: encrypted ? "on" : "off" },
        { label: "Extension version", value: chrome.runtime.getManifest().version },
        { label: "Talks to", value: "your agent, its mediator, and pages you visit" },
        {
          label: "What it does",
          value: "requests and operates — it can ask your agent to act, but cannot approve",
        },
        {
          label: "Paired with",
          value: "your approval identity, which can approve but never requests",
        },
      ],
    },
    {
      id: "agent",
      role: "Trust agent",
      ...(displayLabel(connection.vtaDid, names) ? { label: displayLabel(connection.vtaDid, names)! } : {}),
      did: connection.vtaDid,
      detail: `role: ${connection.role}`,
      tone: "agent",
      facts: [
        { label: "DID", value: connection.vtaDid },
        { label: "Your role", value: connection.role },
        {
          // Two facts, because they are two different claims and conflating
          // them is what made this pane assert a transport that was dead.
          label: isObserved(transportHealth) ? "Transport in use" : "Transport expected",
          value: transport ?? "none usable",
        },
        { label: "Advertises", value: advertisedTransports(connection).join(", ") || "nothing" },
        ...(unavailableTransports(connection, transportHealth).length > 0
          ? [
              {
                label: "Unavailable",
                value: unavailableTransports(connection, transportHealth)
                  .map((t2) => `${t2} — ${transportHealth[t2]?.detail ?? "could not be opened"}`)
                  .join(" "),
              },
            ]
          : []),
        { label: "REST endpoint", value: connection.restBaseUrl ?? "not advertised" },
        { label: "Connected", value: new Date(connection.connectedAt).toLocaleString() },
      ],
    },
  ];
  const edges: GraphEdge[] = [];
  // Rows are computed, not fixed. The approver row only exists when there is
  // an approver; hardcoding it left a band of empty canvas above the core on
  // every wallet that hasn't created one — which is most of them.
  const APPROVER_ROW = 8;
  const CORE_ROW = approver ? 116 : 8;
  const RP_ROW = CORE_ROW + 138;
  const positions: Record<string, { col: number; row: number }> = {
    self: { col: 0, row: CORE_ROW },
    agent: { col: 2, row: CORE_ROW },
  };

  if (mediator) {
    nodes.push({
      id: "mediator",
      role: "Mediator",
      ...(displayLabel(mediator, names) ? { label: displayLabel(mediator, names)! } : {}),
      did: mediator,
      detail: "relays messages both ways",
      tone: "mediator",
      facts: [
        { label: "Carries", value: transport ?? "nothing right now" },
        {
          label: "Also your inbox",
          value: "relying parties send confirm requests to you through it",
        },
      ],
    });
    positions["mediator"] = { col: 1, row: CORE_ROW };
    edges.push({ from: "self", to: "mediator", label: "inbox" });
    edges.push({ from: "mediator", to: "agent", ...(transport ? { label: transport } : {}) });
  } else {
    positions["agent"] = { col: 1, row: CORE_ROW };
    edges.push({ from: "self", to: "agent", ...(transport ? { label: transport } : {}) });
  }

  if (approver) {
    nodes.push({
      id: "approver",
      role: "Approval identity",
      ...(displayLabel(approver, names) ? { label: displayLabel(approver, names)! } : { label: "Separate identity" }),
      did: approver,
      detail: "signs approvals, per gesture",
      tone: "approver",
      facts: [
        { label: "DID", value: approver },
        {
          label: "What it does",
          value: "approves only — it never requests anything, so a stolen request cannot approve itself",
        },
        {
          label: "Paired with",
          value: "your operating identity above, which requests but cannot approve",
        },
        {
          label: "Stored",
          value: "in this browser, encrypted with your passkey — unlike your logins, which live at the agent",
        },
        { label: "Key release", value: "your authenticator, once per approval" },
        {
          label: "Receives",
          value: "approval requests from your agent, routed through your inbox mediator",
        },
        { label: "Register it", value: "must be in the agent's approver set and ACL to count" },
      ],
    });
    // Browser side, not agent side. It is minted into this browser's
    // IndexedDB under a passkey wrap; drawing it beside the agent implied its
    // key lives there, which is the opposite of the point — a hijacked agent
    // cannot approve on your behalf precisely because this key is local.
    positions["approver"] = { col: 0, row: APPROVER_ROW };
    // Requests originate at the agent and reach the approver through the
    // wallet's own inbox mediator, so the arrow points inward, not outward.
    edges.push({
      from: mediator ? "mediator" : "agent",
      to: "approver",
      label: "approval requests",
      dashed: true,
    });
  }

  // Sites, merged from vault entries and trust records. See network-model.ts
  // for why the merge keys on host rather than the raw origin string.
  const rpRows = mergeRpRows(entries, sites, displayHostFor);

  // Scaling: the core (wallet, mediator, agent, approver) is fixed size and
  // stays legible however much else exists. Sites are the unbounded set, so
  // they get a budget; the remainder collapses into one selectable node.
  const RP_BUDGET = 4;
  // Counted across every row, not just the drawn ones — reuse you cannot see
  // still correlates you.
  const identityCounts = identityUsage(rpRows);
  const shownRps = rpRows.slice(0, RP_BUDGET);
  const overflowRps = rpRows.slice(RP_BUDGET);

  // Columns say where things live, which is the more useful thing for a
  // diagram to encode than reading order:
  //
  //   col 0 — sites, directly under the browser, because a site talks to the
  //           browser and to nothing else here;
  //   col 2 — login entries, directly under the trust agent, because that is
  //           literally where they are stored (`doVaultList` lists them from
  //           the agent, not from this browser).
  //
  // The previous arrangement put entries under the browser, implying the
  // credentials live locally — the exact misconception the passkey copy
  // exists to correct — and put sites under the mediator, implying a
  // relationship that does not exist.
  const siteMembers: string[] = [];
  const loginMembers: string[] = [];

  shownRps.forEach((row, i) => {
    const y = RP_ROW + i * 100;
    const siteId = `rp-${i}`;
    const title = siteTitle(row, displayHostFor);
    // A DID-only target has no host, so siteTitle hands back the DID; resolve
    // it to an agent name when the document claims one.
    const siteLabel =
      row.rpDid && title === row.rpDid ? (displayLabel(row.rpDid, names) ?? title) : title;

    if (row.entry) {
      const eid = `${siteId}-entry`;
      const persona = row.principalDid ? displayLabel(row.principalDid, names) : undefined;
      nodes.push({
        id: eid,
        role: "Login entry",
        label: row.entry.label || row.entry.id,
        ...(row.principalDid ? { did: row.principalDid } : {}),
        detail: persona ? `you appear as ${persona}` : row.entry.secretKind,
        tone: "entry",
        facts: [
          { label: "Entry", value: row.entry.label || row.entry.id },
          { label: "Sign-in method", value: row.entry.secretKind },
          { label: "Workspace", value: row.entry.contextId },
          { label: "Identity presented", value: row.principalDid ?? "none attached" },
          { label: "Last used", value: row.entry.lastUsedAt ?? "not yet" },
          {
            label: "Stored",
            value: "in your trust agent, not in this browser — a new browser sees it too",
          },
        ],
      });
      positions[eid] = { col: 2, row: y };
      loginMembers.push(eid);
      edges.push({ from: eid, to: siteId, label: "signs you in to" });
    }

    nodes.push({
      id: siteId,
      role: "Site",
      label: siteLabel,
      ...(row.rpDid ? { did: row.rpDid } : {}),
      detail: row.trusted ? "acts without asking" : "prompts every time",
      tone: "rp",
      facts: [
        { label: "Site", value: row.origin ?? "reached by DID, not a URL" },
        { label: "Its own identity", value: row.rpDid ?? "none recorded" },
        {
          label: "You appear as",
          value: row.principalDid ?? "nothing yet — no login entry names an identity",
        },
        {
          label: "Identity reuse",
          value: (() => {
            if (!row.principalDid) return "no identity attached yet";
            const n = identityCounts.get(row.principalDid) ?? 1;
            return n > 1
              ? `also used on ${n - 1} other site${n > 2 ? "s" : ""} — those sites could work out you are the same person`
              : "used only here, so this site cannot be correlated with the others";
          })(),
        },
        {
          label: "Acts without asking",
          value: row.trusted
            ? `yes, since ${new Date(row.trusted.trustedAt).toLocaleDateString()}`
            : "no — it prompts every time",
        },
        {
          label: "Never contacts",
          value: "your trust agent — it verifies you by resolving your DID document",
        },
      ],
    });
    positions[siteId] = { col: 0, row: y };
    siteMembers.push(siteId);
  });

  if (overflowRps.length > 0) {
    const id = "rp-more";
    nodes.push({
      id,
      role: "More sites",
      label: `+${overflowRps.length} more`,
      detail: "select to list them",
      tone: "rp",
      facts: [
        {
          label: "Not drawn",
          value: `showing the ${RP_BUDGET} most recently used so the shape stays readable`,
        },
        ...overflowRps.map((r) => ({
          label: siteTitle(r, displayHostFor),
          value: r.principalDid ?? r.origin ?? "no identity attached",
        })),
      ],
    });
    positions[id] = { col: 0, row: RP_ROW + shownRps.length * 100 };
    siteMembers.push(id);
  }

  // Two frames. The shared paths attach to the sites frame rather than to one
  // member, because "in the page" and "confirm requests" are how every site
  // reaches the wallet, not properties of the first one.
  const groups = [
    ...(siteMembers.length > 0
      ? [{ id: "rp-group", label: "Sites you sign in to", members: siteMembers }]
      : []),
    ...(loginMembers.length > 0
      ? [{ id: "login-group", label: "Your logins, kept by your agent", members: loginMembers }]
      : []),
  ];

  if (siteMembers.length > 0) {
    edges.push({ from: "rp-group", to: "self", label: "in the page" });
    if (mediator) {
      edges.push({ from: "rp-group", to: "mediator", label: "confirm requests", dashed: true });
    }
  }
  // Draw the storage relationship rather than only captioning it: this is the
  // answer to "where are my credentials?", and it is the reassurance the
  // passkey-loss copy depends on being true.
  if (loginMembers.length > 0) {
    edges.push({ from: "agent", to: "login-group", label: "stores your logins", dashed: true });
  }

  const selectedNode = nodes.find((n) => n.id === selected);
  const rpCount = Math.max(shownRps.length + (overflowRps.length ? 1 : 0), loginMembers.length);
  const height = rpCount > 0 ? RP_ROW + rpCount * 100 + 16 : CORE_ROW + 100;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Panel
        title="Network"
        description="Everything your wallet is currently wired to, and how messages travel. Useful when something isn't working and you need to see which hop is missing."
      >
        <TrustGraph
          nodes={nodes}
          edges={edges}
          positions={positions}
          groups={groups}
          height={height}
          {...(selected ? { selectedId: selected } : {})}
          onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
        />
        <div style={{ fontSize: t.xs, color: c.faint }}>
          Select any box for its details.
        </div>
        <div style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.55, maxWidth: "78ch" }}>
          Two identities live in this browser and neither can do the other&apos;s job: the
          operating identity asks your agent to act, the approval identity signs off on it. A
          compromised browser session can request things and still not approve them. Sites sit
          under the browser because that is the only thing they talk to; your logins sit under
          the agent because that is where they are kept.
        </div>
        {overflowRps.length > 0 && (
          <div style={{ fontSize: t.xs, color: c.faint }}>
            {shownRps.length} most recently used of {rpRows.length} sites shown. The full list
            lives under Vault and Sites.
          </div>
        )}
      </Panel>

      {selectedNode && (
        <Panel title={selectedNode.role}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: t.md }}>{selectedNode.label ?? "—"}</strong>
            {selectedNode.did && <Did value={selectedNode.did} size={t.xs} />}
          </div>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "8px 18px",
              margin: 0,
              fontSize: t.sm,
            }}
          >
            {(selectedNode.facts ?? []).map((f) => (
              <Row key={f.label} label={f.label}>
                <span style={{ fontFamily: f.value.startsWith("did:") ? "var(--w-mono)" : undefined }}>
                  {f.value}
                </span>
              </Row>
            ))}
          </dl>
        </Panel>
      )}

      <SignInFlow />

      <DtteFlow />

      <DiagnosticsPanel vtaDid={connection.vtaDid} />

      <Panel title="Details" description="The same facts as text, for pasting into a bug report.">
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 18px", margin: 0, fontSize: t.sm }}>
          <Row label={isObserved(transportHealth) ? "Transport in use" : "Transport expected"}>
            {transport ? (
              <Pill tone={isObserved(transportHealth) ? "ok" : "off"}>{transport}</Pill>
            ) : (
              <Pill tone="warn">none usable</Pill>
            )}
          </Row>
          <Row label="Advertised">
            {advertisedTransports(connection).join(", ") || "none"}
          </Row>
          {/* The panel exists to be pasted into a bug report, and the reason a
              transport is down is the one line that report actually needs —
              it is usually fixed by whoever runs the mediator, not by the
              person reading this. */}
          {unavailableTransports(connection, transportHealth).map((t2) => (
            <Row key={t2} label={`${t2} unavailable`}>
              {transportHealth[t2]?.detail ?? "could not be opened"}
              {transportHealth[t2]?.code ? ` (${transportHealth[t2]!.code})` : ""}
            </Row>
          ))}
          <Row label="Prefer TSP">{preferTsp ? "on" : "off"}</Row>
          <Row label="Wallet locked">{encrypted ? "yes" : "no"}</Row>
          <Row label="Your wallet address">
            {holderDid ? <Did value={holderDid} size={t.xs} /> : "—"}
          </Row>
          <Row label="Trust agent">
            <Did value={connection.vtaDid} size={t.xs} />
          </Row>
          <Row label="Mediator">
            {mediator ? <Did value={mediator} size={t.xs} /> : "none — reached directly"}
          </Row>
          <Row label="Approver identity">
            {approver ? <Did value={approver} size={t.xs} /> : "none created"}
          </Row>
          <Row label="Connected since">
            {new Date(connection.connectedAt).toLocaleString()}
          </Row>
          <Row label="Extension version">{chrome.runtime.getManifest().version}</Row>
        </dl>
      </Panel>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: c.muted, whiteSpace: "nowrap" }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0, wordBreak: "break-word" }}>{children}</dd>
    </>
  );
}
