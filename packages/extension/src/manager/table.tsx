// The console's list vocabulary.
//
// Nine panes render "a list of records the agent holds", and each one has the
// same three states worth distinguishing — loading, the agent refused, and the
// agent answered with nothing. Written per-pane those collapse: an empty array
// and a failed call both render as no rows, and the operator reads "you have no
// keys" off a permission error.
//
// So the states are separated here, once, and each says something different.

import { Fragment, type ReactNode } from "react";
import { c, t } from "../theme.js";
import { Note } from "../ui.js";

export interface Column<R> {
  key: string;
  header: string;
  /** Column width; omit to let it take its share. */
  width?: string;
  render: (row: R) => ReactNode;
}

export function Table<R>({
  columns,
  rows,
  rowKey,
  expanded,
  empty,
}: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  /**
   * Detail to show directly beneath a row, or `null` for rows that have none.
   *
   * A detail panel rendered *after* the table is a detail panel the operator
   * does not notice: they click View on the third row, the content appears
   * below the fold, and the table looks like it did nothing. Putting it in the
   * flow under the row it belongs to is the difference between an answer and a
   * thing that happened somewhere else.
   */
  expanded?: (row: R) => ReactNode | null;
  /** What would appear here. An empty state is a chance to explain, so this is
   *  required rather than defaulting to "None". */
  empty: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: t.sm, color: c.faint, padding: "10px 0", lineHeight: 1.55 }}>
        {empty}
      </div>
    );
  }
  return (
    // Wide tables scroll inside their own box rather than pushing the page
    // sideways — a DID column is wider than any pane.
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          // A floor, not a width. Without it a wide cell — a destructive
          // preview opening inside the actions column — steals space from
          // the identifier columns and wraps DIDs mid-token. The container
          // scrolls instead, which is the tradeoff already chosen above.
          minWidth: 760,
          fontSize: t.sm,
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
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
                  ...(col.width ? { width: col.width } : {}),
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const detail = expanded?.(row) ?? null;
            return (
              <Fragment key={rowKey(row)}>
                <tr>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: "7px 12px 7px 0",
                        // No bottom rule when a detail follows: the row and its
                        // detail are one thing, and a line between them reads
                        // as two.
                        ...(detail ? {} : { borderBottom: `1px solid ${c.lineSoft}` }),
                        verticalAlign: "top",
                      }}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
                {detail && (
                  <tr>
                    <td
                      colSpan={columns.length}
                      style={{
                        padding: "0 12px 14px 0",
                        borderBottom: `1px solid ${c.lineSoft}`,
                      }}
                    >
                      {detail}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The agent is being asked. Distinct from "answered with nothing". */
export function Loading({ what }: { what: string }) {
  return <div style={{ fontSize: t.sm, color: c.faint, padding: "10px 0" }}>Reading {what}…</div>;
}

/**
 * The agent refused, or could not be reached.
 *
 * Rendered as a note rather than an empty list, because the two mean opposite
 * things: "you have none" and "we could not find out" are different answers,
 * and only one of them should stop an operator worrying.
 */
export function LoadError({ what, error }: { what: string; error: string }) {
  return (
    <Note tone="danger">
      Your agent would not return {what} — {error}
    </Note>
  );
}

/**
 * A page that stopped early.
 *
 * Worth its own component because the failure it prevents is specific: an
 * operator reading "nothing else happened" off a truncated list. `auditList`'s
 * own documentation is explicit that this is what an audit trail exists to
 * prevent.
 */
export function Truncated({ what, onMore }: { what: string; onMore?: () => void }) {
  return (
    <Note tone="warn">
      This is not all of {what} — your agent stopped early.{" "}
      {onMore ? (
        <button
          onClick={onMore}
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
      ) : (
        "Narrow the filters to see the rest."
      )}
    </Note>
  );
}

/** A redaction list from the agent, shown rather than silently ignored — a
 *  field the agent withheld is not a field that is absent. */
export function Redacted({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return (
    <Note tone="warn">
      Your agent withheld {fields.join(", ")} from this answer. What you see is complete except
      for those.
    </Note>
  );
}
