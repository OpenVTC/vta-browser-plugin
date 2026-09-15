// DIDs — the `did:webvh` identifiers a context publishes.
//
// Scoped to the selected context like Keys, and for the same reason:
// `webvhDidList` takes a `contextId`, so a changed selection asks the agent a
// different question rather than filtering an answer it already gave.
//
// A DID here is a *published* identifier: its log lives on a hosting server and
// anyone can resolve it. That is why deletion is treated as the sharpest action
// in this console — see the confirm copy.
//
// A row opens into `did-detail.tsx`, which fetches the log. It is fetched on
// open rather than with the listing because `includeLog` is opt-in at the agent
// for a reason: the log is the DID's whole history and can be large, and a
// listing that pulled every one would be the whole history of every identifier
// to draw a table.

import { useState } from "react";
import {
  webvhDidDelete,
  webvhDidList,
  webvhDidRealignKeys,
  type WebvhDidRecord,
} from "@openvtc/pnm-core/webvh";
import { Button, Did, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Destructive } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatDate } from "../format.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";
import { CreateDid } from "./did-create.js";
import { DidDetail } from "./did-detail.js";

/** What the agent said a realignment would do, or did. */
type RealignPlan = Awaited<ReturnType<typeof webvhDidRealignKeys>>;

/**
 * Bring this DID's key records back onto the verification-method ids its
 * published document declares.
 *
 * **The dry run is not a courtesy, it is the diagnosis.** There is nothing on
 * this screen that tells an operator whether a DID needs this: the answer lives
 * in the agent's key store and the DID's log, and comparing them is exactly what
 * the task does. So the preview is the whole feature — a DID that is already
 * consistent says so, and one that is not lists the renames before any of them
 * happen.
 *
 * Offered on every DID for the same reason. Showing the action only where the
 * console *thinks* it is needed would mean shipping a second, client-side copy
 * of the comparison, which could disagree with the agent's — and the operator
 * would have no way to find out.
 */
function RealignKeys({
  parties,
  did,
  disabledReason,
  onDone,
}: {
  parties: Parties;
  did: string;
  disabledReason: string | null;
  onDone: () => void;
}) {
  return (
    <Destructive<RealignPlan>
      label="Realign keys"
      nature="corrective"
      disabledReason={disabledReason}
      preview={() => webvhDidRealignKeys(managerSender, { ...parties, did, dryRun: true })}
      renderPreview={(plan) => <RealignPreview plan={plan} />}
      commit={async () => {
        await webvhDidRealignKeys(managerSender, { ...parties, did, dryRun: false });
      }}
      onDone={onDone}
    />
  );
}

function RealignPreview({ plan }: { plan: RealignPlan }) {
  if (plan.moved.length === 0 && plan.unmatched.length === 0) {
    return (
      <>
        <strong>Nothing to change.</strong>
        <span>
          Every verification method this DID publishes is held under the name the document
          gives it.
        </span>
      </>
    );
  }
  return (
    <>
      {plan.moved.length > 0 && (
        <>
          <strong>
            {plan.moved.length} key{plan.moved.length === 1 ? "" : "s"} would be renamed.
          </strong>
          <span>
            The key material is untouched — these are the names your agent answers to when
            something addresses a key by the id the document publishes.
          </span>
          <div style={{ display: "grid", gap: 6 }}>
            {plan.moved.map((m) => (
              <div
                key={m.to}
                style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}
              >
                <div style={{ color: c.muted }}>{m.from}</div>
                <div>→ {m.to}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {/* Said out loud rather than folded into "nothing to do": a method with
          no record here is a key this agent does not hold, and a realignment
          that reports one has not finished the job. */}
      {plan.unmatched.length > 0 && (
        <span>
          Your agent holds no key for {plan.unmatched.length} of the methods this DID publishes,
          so it cannot name {plan.unmatched.length === 1 ? "it" : "them"}:{" "}
          <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
            {plan.unmatched.join(", ")}
          </span>
        </span>
      )}
    </>
  );
}

export function DidsPane({
  parties,
  authority,
  contextId,
  contextHeading,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: ContextSelection;
  /** How the selected context is named in the tree, so heading and navigation
   *  agree. See `contextLabel` in `format.ts`. */
  contextHeading?: string | undefined;
}) {
  const list = useAsync(
    () =>
      webvhDidList(managerSender, {
        ...parties,
        ...(contextId ? { contextId } : {}),
      }),
    [parties.holder.did, parties.service.did, contextId],
  );

  // Which row is open, by DID rather than by index: the list is refetched after
  // every realignment and deletion, and an index would reopen whichever DID had
  // moved into that position.
  const [opened, setOpened] = useState<string | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Deleting a DID needs the admin role at this agent."
    : null;

  const columns: Column<WebvhDidRecord>[] = [
    // A floor on the identifier column. A `did:webvh` has no natural break
    // points, so when something else in the row demands width — a long refusal
    // from the agent, say — the browser squeezes this one and the DID wraps
    // every few characters, which is unreadable exactly when you most need to
    // tell two of them apart.
    {
      key: "did",
      header: "DID",
      width: "26ch",
      // The identifier is the control. An operator wanting to read a DID's
      // history clicks the DID — a separate "View" button beside it would be a
      // second thing to find for the gesture they already tried.
      render: (d) => (
        <button
          onClick={() => setOpened(opened === d.did ? null : d.did)}
          aria-expanded={opened === d.did}
          title={opened === d.did ? "Close" : "Open this DID and read its log"}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            textAlign: "left",
            cursor: "pointer",
            minWidth: 0,
          }}
        >
          <Did value={d.did} />
        </button>
      ),
    },
    {
      key: "context",
      header: "Context",
      render: (d) => <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{d.contextId}</span>,
    },
    {
      key: "server",
      header: "Server",
      render: (d) => <span style={{ color: c.muted }}>{d.serverId}</span>,
    },
    {
      key: "portable",
      header: "Portable",
      render: (d) => (d.portable ? <Pill tone="accent">portable</Pill> : <span style={{ color: c.faint }}>—</span>),
    },
    {
      key: "log",
      header: "Log entries",
      render: (d) => (
        <span style={{ color: c.muted }}>
          {d.logEntryCount}
          {opened === d.did ? "" : " ·\u00a0read"}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      render: (d) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
          {formatDate(d.createdAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (d) => (
        <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
          <RealignKeys parties={parties} did={d.did} disabledReason={denied} onDone={list.reload} />
          <Destructive<WebvhDidRecord>
            label="Delete"
            disabledReason={denied}
            preview={async () => d}
            forceLabel="Delete anyway"
            renderPreview={(p) => (
              <>
                <strong>Deleting this DID cannot be undone.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
                  {p.did}
                </span>
                <span>
                  Its {p.logEntryCount} log{p.logEntryCount === 1 ? " entry" : " entries"} and the
                  keys behind them go with it. Anyone still resolving this DID — a relying party
                  holding a credential you issued, an ACL entry naming it — stops being able to
                  verify anything signed by it.
                </span>
              </>
            )}
            commit={async () => {
              await webvhDidDelete(managerSender, { ...parties, did: d.did });
            }}
            onDone={list.reload}
          />
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextHeading ? `DIDs in ${contextHeading}` : "DIDs in every context you can reach"}
        description="Published did:webvh identifiers. Each one's log is served by a hosting
          server and resolvable by anyone — these are the identities others see."
      >
        {list.error && <LoadError what="DIDs" error={list.error} />}
        {list.loading && !list.data && <Loading what="DIDs" />}
        {list.data && (
          <Table
            columns={columns}
            rows={list.data.dids}
            rowKey={(d) => d.did}
            expanded={(d) =>
              opened === d.did ? <DidDetail parties={parties} record={d} /> : null
            }
            empty={
              contextId
                ? `No DIDs in ${contextId}. Identifiers published from this context appear here.`
                : "No DIDs you can reach. Published identifiers you administer appear here."
            }
          />
        )}
      </Panel>

      <CreateDid
        parties={parties}
        contextId={contextId}
        authority={authority}
        onCreated={list.reload}
      />
    </div>
  );
}
