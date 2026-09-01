// Audit — the agent's account of what happened.
//
// **Truncation is rendered, never swallowed.** `AuditListResult.truncated` says
// the agent stopped early, and its own documentation is explicit about why that
// matters: an operator reading "nothing else occurred" off a partial page is
// exactly the failure an audit trail exists to prevent. A list that silently
// dropped the flag would be worse than no audit view at all, because it looks
// authoritative.
//
// Entries are hash-chained (`prevHash`/`entryHash`). This pane shows that the
// chain is there but does **not** claim to have verified it — checking a chain
// requires the whole chain, and this is a page of it. Saying "verified" over a
// page would be a claim nothing here can support.

import { useCallback, useState } from "react";
import { auditList, type AuditEnvelope } from "@openvtc/pnm-core/admin";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import type { Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";

const PAGE = 50;

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

function Outcome({ outcome }: { outcome: string | undefined }) {
  if (!outcome) return <span style={{ color: c.faint }}>—</span>;
  const ok = /^(ok|success|allow|allowed|granted)$/i.test(outcome);
  const bad = /^(deny|denied|error|fail|failed|refused|rejected)$/i.test(outcome);
  return <Pill tone={ok ? "ok" : bad ? "danger" : "off"}>{outcome}</Pill>;
}

export function AuditPane({
  parties,
  contextId,
}: {
  parties: Parties;
  contextId: ContextSelection;
}) {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  // Applied filters, separate from the inputs: typing should not fire a request
  // per keystroke against an agent over a mediator.
  const [applied, setApplied] = useState({ action: "", actor: "" });
  const [pageSize, setPageSize] = useState(PAGE);

  const list = useAsync(
    () =>
      auditList(managerSender, {
        ...parties,
        pageSize,
        ...(contextId ? { contextId } : {}),
        ...(applied.action ? { action: applied.action } : {}),
        ...(applied.actor ? { actor: applied.actor } : {}),
      }),
    [
      parties.holder.did,
      parties.service.did,
      contextId,
      applied.action,
      applied.actor,
      pageSize,
    ],
  );

  const apply = useCallback(() => {
    setPageSize(PAGE);
    setApplied({ action: action.trim(), actor: actor.trim() });
  }, [action, actor]);

  const columns: Column<AuditEnvelope>[] = [
    {
      key: "when",
      header: "When",
      render: (e) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
          {new Date(e.recordedAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (e) => <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{e.action}</span>,
    },
    {
      key: "actor",
      header: "Actor",
      render: (e) =>
        e.actor ? <Did value={e.actor} size={t.xs} /> : <span style={{ color: c.faint }}>—</span>,
    },
    {
      key: "target",
      header: "Target",
      render: (e) =>
        e.target ? (
          <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
            {e.target}
          </span>
        ) : (
          <span style={{ color: c.faint }}>—</span>
        ),
    },
    { key: "outcome", header: "Outcome", render: (e) => <Outcome outcome={e.outcome} /> },
    {
      key: "context",
      header: "Context",
      render: (e) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>
          {e.contextId ?? "—"}
        </span>
      ),
    },
    {
      key: "chain",
      header: "Chained",
      render: (e) =>
        e.entryHash ? (
          <span
            style={{ color: c.muted, fontSize: t.xs }}
            title="This entry carries a hash linking it to the previous one. Verifying the chain
              needs all of it, which this page is not — so no claim is made here."
          >
            yes
          </span>
        ) : (
          <span style={{ color: c.warn, fontSize: t.xs }}>no</span>
        ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextId ? `Audit for ${contextId}` : "Audit"}
        description="What your agent recorded. Entries are hash-chained to each other; this page
          shows that the links are present, and does not claim to have checked them — that needs
          the whole chain, not a page of it."
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>ACTION</span>
            <input
              style={fieldStyle}
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="acl/grant"
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 300px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>ACTOR DID</span>
            <input
              style={{ ...fieldStyle, fontFamily: font.mono }}
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </label>
          <div style={{ paddingBottom: 1 }}>
            <Button onClick={apply}>Apply filters</Button>
          </div>
        </div>

        {list.error && <LoadError what="the audit trail" error={list.error} />}
        {list.loading && !list.data && <Loading what="the audit trail" />}

        {list.data && (
          <>
            {/* Before the table, not after. A warning under a long list is a
                warning nobody reads. */}
            {list.data.truncated && (
              <Note tone="warn">
                <strong>This is not the whole record.</strong> Your agent stopped early, so
                anything you conclude from what is below — including that something did
                <em> not</em> happen — may be wrong.{" "}
                <button
                  onClick={() => setPageSize((n) => n + PAGE)}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    color: c.accent,
                    cursor: "pointer",
                    font: "inherit",
                    textDecoration: "underline",
                  }}
                >
                  Load more
                </button>
                , or narrow the filters.
              </Note>
            )}
            <Table
              columns={columns}
              rows={list.data.entries}
              rowKey={(e) => e.eventId}
              empty={
                applied.action || applied.actor
                  ? "Nothing matches those filters. Clear them to see the rest."
                  : "Your agent has recorded nothing here yet."
              }
            />
          </>
        )}
      </Panel>
    </div>
  );
}
