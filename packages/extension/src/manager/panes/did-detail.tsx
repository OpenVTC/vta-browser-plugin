// One DID, opened.
//
// **The log is the whole point of this panel.** A `did:webvh` is not a document,
// it is a *history*: the current document is whatever the last entry put into
// effect, and the only thing a verifier can check it against is the chain of
// entries that led there. The list showed a count of those entries and no way to
// read one, which is the same shape as reporting an unreadable context as an
// empty one — a number with nothing behind it.
//
// `includeLog` is opt-in at the agent for a good reason: the log is the DID's
// whole history and can be large. So it is fetched when a row is opened, never
// with the listing. **Its absence in a response means it was not asked for and
// never that the DID has no history** — which is why a missing log here is drawn
// as a refusal to read rather than as an empty list.
//
// Everything on screen is copyable, because the reason to open this panel at all
// is usually to take something out of it: a version id to cite, an entry to
// replay, the whole log to hand to someone verifying.

import { useEffect, useState } from "react";
import { webvhDidGet, type WebvhDidRecord } from "@openvtc/pnm-core/webvh";
import { CopyButton, Did, Note, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { formatDate } from "../format.js";
import { parseDidLog, servicesOf, methodsOf, type LogEntry } from "../did-log.js";
import type { Parties } from "../use-vta.js";

const mono: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: t.xs,
  wordBreak: "break-all",
};

const pre: React.CSSProperties = {
  margin: 0,
  padding: 10,
  background: c.ground,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontFamily: font.mono,
  fontSize: t.xs,
  lineHeight: 1.55,
  // The log's lines are single JSON documents with no break points. Wrapping
  // them is the only way a 4KB entry is readable in a table cell, and the
  // container scrolls vertically rather than the page sideways.
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 280,
  overflowY: "auto",
};

export function DidDetail({
  parties,
  record,
}: {
  parties: Parties;
  record: WebvhDidRecord;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setLog(null);
    setError(null);
    webvhDidGet(managerSender, { ...parties, did: record.did, includeLog: true }).then(
      (res) => {
        if (!live) return;
        // Said apart from an error, because they are different facts. The agent
        // answered; what it did not do is include a log, and a panel that drew
        // that as "no entries" would claim this DID has no history.
        setLog(res.log ?? "");
        if (res.log === undefined) {
          setError("Your agent answered without the log, though it was asked for.");
        }
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [parties, record.did]);

  const entries = log ? parseDidLog(log) : [];

  return (
    <div style={{ display: "grid", gap: 14, padding: "10px 0 2px", minWidth: 0 }}>
      <div style={{ display: "grid", gap: 7 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <Did value={record.did} />
          <CopyButton value={record.did} title={`Copy ${record.did}`} />
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: t.xs, color: c.muted }}>
          <span>
            SCID <span style={mono}>{record.scid}</span>
          </span>
          {record.mnemonic && (
            <span>
              hosted as <span style={mono}>{record.mnemonic}</span>
            </span>
          )}
          <span>created {formatDate(record.createdAt)}</span>
        </div>
      </div>

      {error && <LoadError what="this DID's log" error={error} />}
      {log === null && !error && <Loading what="this DID's log" />}

      {log !== null && log !== "" && (
        <div style={{ display: "grid", gap: 9, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: t.sm }}>
              {entries.length} log {entries.length === 1 ? "entry" : "entries"}
            </strong>
            <CopyButton value={log} label="Copy the whole log" title={`Copy the log of ${record.did}`} />
            {/* Said where the count is, because the two disagree only when the
                agent's record is stale — and a reader comparing them is the
                only way anyone would find out. */}
            {entries.length !== record.logEntryCount && (
              <span style={{ fontSize: t.xs, color: c.warn }}>
                Your agent&apos;s record says {record.logEntryCount}.
              </span>
            )}
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            {entries.map((entry) => (
              <LogEntryRow
                key={entry.index}
                entry={entry}
                open={open === entry.index}
                onToggle={() => setOpen(open === entry.index ? null : entry.index)}
              />
            ))}
          </div>
        </div>
      )}

      {log === "" && !error && (
        <Note tone="warn">
          Your agent returned an empty log for this DID. A published <code>did:webvh</code> always
          has at least the entry that created it, so this is a record that has lost its history
          rather than a DID without one.
        </Note>
      )}
    </div>
  );
}

/**
 * One entry, closed until it is opened.
 *
 * Closed it draws what identifies the entry and what it changed; opened it adds
 * the raw line. The raw line is the thing worth copying — it is what a verifier
 * replays — and it is also 2–4KB of base64, so every entry showing one at once
 * would bury the history in its own signatures.
 */
function LogEntryRow({
  entry,
  open,
  onToggle,
}: {
  entry: LogEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const services = servicesOf(entry);
  const methods = methodsOf(entry);
  const params = entry.parameters ?? {};

  return (
    <div
      style={{
        border: `1px solid ${open ? c.accent : c.line}`,
        borderRadius: "var(--w-r-sm)",
        background: c.surface,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 11px", flexWrap: "wrap" }}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          style={{
            border: "none",
            background: "transparent",
            color: c.text,
            cursor: "pointer",
            padding: 0,
            fontSize: t.sm,
            fontWeight: 640,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span style={{ color: c.faint }}>{entry.index}</span>
          <span style={mono}>{entry.versionId ?? "(no versionId)"}</span>
        </button>
        {entry.versionTime && (
          <span style={{ fontSize: t.xs, color: c.muted, whiteSpace: "nowrap" }}>
            {formatDate(entry.versionTime)}
          </span>
        )}
        {/* An unsigned entry is worth noticing: the log's whole guarantee is
            that each entry is signed by a key the previous one authorised. */}
        {entry.proofCount === 0 ? (
          <Pill tone="danger">unsigned</Pill>
        ) : (
          <span style={{ fontSize: t.xs, color: c.muted }}>
            {entry.proofCount} proof{entry.proofCount === 1 ? "" : "s"}
          </span>
        )}
        {entry.problem && <Pill tone="danger">unreadable</Pill>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 7 }}>
          <CopyButton
            value={entry.raw}
            label="Copy entry"
            title={`Copy log entry ${entry.index}`}
          />
        </span>
      </div>

      {open && (
        <div style={{ display: "grid", gap: 10, padding: "0 11px 11px", minWidth: 0 }}>
          {entry.problem && (
            <Note tone="warn">
              {entry.problem} It is shown below exactly as your agent sent it — an entry this
              console cannot read is still part of the DID&apos;s history.
            </Note>
          )}
          {Object.keys(params).length > 0 && (
            <Detail title="Parameters">
              <div style={{ display: "grid", gap: 3 }}>
                {Object.entries(params).map(([k, v]) => (
                  <div key={k} style={mono}>
                    <span style={{ color: c.muted }}>{k}</span>{" "}
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </div>
                ))}
              </div>
            </Detail>
          )}
          {methods.length > 0 && (
            <Detail title="Verification methods">
              <div style={{ display: "grid", gap: 3 }}>
                {methods.map((m) => (
                  <div key={m} style={mono}>
                    {m}
                  </div>
                ))}
              </div>
            </Detail>
          )}
          {services.length > 0 && (
            <Detail title="Services">
              <div style={{ display: "grid", gap: 6 }}>
                {services.map((s) => (
                  <div key={s.id || s.type} style={{ display: "grid", gap: 1 }}>
                    <div style={mono}>{s.id}</div>
                    <div style={{ fontSize: t.xs, color: c.muted }}>{s.type}</div>
                    <div style={{ ...mono, color: c.muted }}>{s.endpoint}</div>
                  </div>
                ))}
              </div>
            </Detail>
          )}
          <Detail title="The entry as it was written">
            <pre style={pre}>{entry.raw}</pre>
          </Detail>
        </div>
      )}
    </div>
  );
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <span
        style={{
          fontSize: t.xs,
          color: c.faint,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          fontWeight: 640,
        }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}
