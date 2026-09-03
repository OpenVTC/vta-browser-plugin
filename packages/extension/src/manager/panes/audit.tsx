// Audit — the agent's account of what happened, and the whole of each entry.
//
// **Truncation is rendered, never swallowed.** `AuditListResult.truncated` says
// the agent stopped early, and its own documentation is explicit about why that
// matters: an operator reading "nothing else occurred" off a partial page is
// exactly the failure an audit trail exists to prevent.
//
// ## Why a row opens
//
// A table row can only show what fits, and what does not fit is the part that
// answers "why". `AuditEnvelope.detail` is free-form per action, `target` and
// `actor` are full DID URLs that a column truncates, and `prevHash`/`entryHash`
// are the only evidence of chaining there is. A summary the operator cannot get
// behind is a summary they have to take on trust — from the surface whose whole
// purpose is not needing to.
//
// So the row expands to the entry as the agent sent it, `detail` included and
// unformatted beyond indentation. Nothing here reinterprets it: this pane's job
// is to hand over the record, not to explain it.
//
// ## What is deliberately not claimed
//
// Entries carry `prevHash`/`entryHash`. Verifying a chain needs the whole
// chain, and this is a page of it — so the console reports whether the links are
// *present* and never that they were checked. Against a live agent every entry
// came back with no hash at all, which is worth saying once, plainly, rather
// than repeating "no" down a column.

import { useCallback, useMemo, useState } from "react";
import { auditList, type AuditEnvelope } from "@openvtc/pnm-core/admin";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatInstant } from "../format.js";
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

/** One field of the opened entry. Absent values say so rather than vanishing —
 *  "the agent recorded no target" is information. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: c.muted, whiteSpace: "nowrap" }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0, wordBreak: "break-word" }}>{children}</dd>
    </>
  );
}

function Absent() {
  return <span style={{ color: c.faint }}>not recorded</span>;
}

function EntryDetail({ entry }: { entry: AuditEnvelope }) {
  const detail = useMemo(() => {
    if (!entry.detail || Object.keys(entry.detail).length === 0) return null;
    try {
      return JSON.stringify(entry.detail, null, 2);
    } catch {
      // A detail object the agent sent that will not serialise is itself worth
      // reporting; silently showing nothing would hide the interesting case.
      return "(this entry's detail could not be displayed)";
    }
  }, [entry.detail]);

  return (
    <div
      style={{
        background: c.raised,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-sm)",
        padding: "14px 16px",
        display: "grid",
        gap: 12,
      }}
    >
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          gap: "6px 18px",
          fontSize: t.sm,
          alignItems: "baseline",
        }}
      >
        <Field label="Event id">
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{entry.eventId}</span>
        </Field>
        <Field label="Recorded">{formatInstant(entry.recordedAt)}</Field>
        <Field label="Action">
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{entry.action}</span>
        </Field>
        <Field label="Outcome">
          <Outcome outcome={entry.outcome} />
        </Field>
        <Field label="Actor">
          {entry.actor ? (
            entry.actor.startsWith("did:") ? (
              <Did value={entry.actor} size={t.xs} />
            ) : (
              // Not every actor is a DID — a live agent records things like
              // `internal:webvh-rest-auth`. Rendering that through the DID
              // component would style a non-DID as one.
              <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{entry.actor}</span>
            )
          ) : (
            <Absent />
          )}
        </Field>
        <Field label="Target">
          {entry.target ? (
            entry.target.startsWith("did:") ? (
              <Did value={entry.target} size={t.xs} />
            ) : (
              <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{entry.target}</span>
            )
          ) : (
            <Absent />
          )}
        </Field>
        <Field label="Context">
          {entry.contextId ? (
            <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{entry.contextId}</span>
          ) : (
            <Absent />
          )}
        </Field>
        <Field label="Chain">
          {entry.entryHash ? (
            <div style={{ display: "grid", gap: 3 }}>
              <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
                this: {entry.entryHash}
              </span>
              <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all", color: c.muted }}>
                prev: {entry.prevHash ?? "—"}
              </span>
              <span style={{ color: c.faint, fontSize: t.xs }}>
                Present, not verified — checking a chain needs all of it.
              </span>
            </div>
          ) : (
            <span style={{ color: c.warn }}>
              This entry carries no hash, so nothing links it to the one before it.
            </span>
          )}
        </Field>
      </dl>

      {detail && (
        <div style={{ display: "grid", gap: 5 }}>
          <span style={{ fontSize: t.xs, color: c.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
            Detail, as the agent recorded it
          </span>
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              background: c.ground,
              border: `1px solid ${c.line}`,
              borderRadius: "var(--w-r-sm)",
              fontSize: t.xs,
              lineHeight: 1.5,
              overflowX: "auto",
              maxHeight: 320,
            }}
          >
            {detail}
          </pre>
        </div>
      )}
      {!detail && (
        <span style={{ fontSize: t.sm, color: c.faint }}>
          This entry carries no detail beyond the fields above.
        </span>
      )}
    </div>
  );
}

/** Compact cell for a value that may be a DID URL far wider than its column. */
function Truncated({ value }: { value: string }) {
  return (
    <span
      title={value}
      style={{
        fontFamily: font.mono,
        fontSize: t.xs,
        display: "block",
        maxWidth: 260,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </span>
  );
}

function Row({
  entry,
  open,
  onToggle,
}: {
  entry: AuditEnvelope;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: "pointer", background: open ? c.raised : "transparent" }}
      >
        {[
          <span key="x" style={{ color: c.faint, fontSize: t.xs }} aria-hidden>
            {open ? "▾" : "▸"}
          </span>,
          <span key="w" style={{ color: c.muted, whiteSpace: "nowrap" }}>
            {formatInstant(entry.recordedAt)}
          </span>,
          <span key="a" style={{ fontFamily: font.mono, fontSize: t.xs }}>
            {entry.action}
          </span>,
          entry.actor ? <Truncated key="ac" value={entry.actor} /> : <Absent key="ac" />,
          entry.target ? <Truncated key="tg" value={entry.target} /> : <Absent key="tg" />,
          <Outcome key="o" outcome={entry.outcome} />,
          <span key="c" style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>
            {entry.contextId ?? "—"}
          </span>,
        ].map((cell, i) => (
          <td
            key={i}
            style={{
              padding: "7px 12px 7px 0",
              borderBottom: open ? "none" : `1px solid ${c.lineSoft}`,
              verticalAlign: "top",
            }}
          >
            {cell}
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td
            colSpan={7}
            style={{ padding: "0 12px 14px 0", borderBottom: `1px solid ${c.lineSoft}` }}
          >
            <EntryDetail entry={entry} />
          </td>
        </tr>
      )}
    </>
  );
}

export function AuditPane({
  parties,
  contextId,
  contextHeading,
}: {
  parties: Parties;
  contextId: ContextSelection;
  /** How the selected context is named in the tree — so the heading and the
   *  navigation agree. See `contextLabel` in `format.ts`. */
  contextHeading?: string | undefined;
}) {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  // Applied filters, separate from the inputs: typing should not fire a request
  // per keystroke against an agent over a mediator.
  const [applied, setApplied] = useState({ action: "", actor: "" });
  const [pageSize, setPageSize] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useAsync(
    () =>
      auditList(managerSender, {
        ...parties,
        pageSize,
        ...(contextId ? { contextId } : {}),
        ...(applied.action ? { action: applied.action } : {}),
        ...(applied.actor ? { actor: applied.actor } : {}),
      }),
    [parties.holder.did, parties.service.did, contextId, applied.action, applied.actor, pageSize],
  );

  const apply = useCallback(() => {
    setPageSize(PAGE);
    setOpenId(null);
    setApplied({ action: action.trim(), actor: actor.trim() });
  }, [action, actor]);

  const entries = list.data?.entries ?? [];
  // Said once, as a note, rather than repeated down a column of "no". Against a
  // live agent this is every row, and a column that always reads the same
  // carries no information while costing the width a DID needed.
  const unchained = entries.length > 0 && entries.every((e) => !e.entryHash);

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextHeading ? `Audit for ${contextHeading}` : "Audit"}
        description="What your agent recorded. Select a row to see the whole entry, including the
          detail the agent attached to it."
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
            <span style={{ fontSize: t.xs, color: c.muted }}>ACTOR</span>
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

            {unchained && (
              <Note tone="warn">
                None of these entries carries a hash linking it to the one before it, so the
                trail cannot be checked for gaps or reordering. That is the agent's recording
                configuration, not something this console can establish from here.
              </Note>
            )}

            {entries.length === 0 ? (
              <div style={{ fontSize: t.sm, color: c.faint, padding: "10px 0", lineHeight: 1.55 }}>
                {applied.action || applied.actor
                  ? "Nothing matches those filters. Clear them to see the rest."
                  : "Your agent has recorded nothing here yet."}
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{ borderCollapse: "collapse", width: "100%", minWidth: 800, fontSize: t.sm }}
                >
                  <thead>
                    <tr>
                      {["", "When", "Action", "Actor", "Target", "Outcome", "Context"].map((h) => (
                        <th
                          key={h || "disclose"}
                          style={{
                            textAlign: "left",
                            padding: "6px 12px 6px 0",
                            borderBottom: `1px solid ${c.line}`,
                            color: c.faint,
                            fontSize: t.xs,
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                            fontWeight: 640,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <Row
                        key={e.eventId}
                        entry={e}
                        open={openId === e.eventId}
                        onToggle={() => setOpenId((cur) => (cur === e.eventId ? null : e.eventId))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
