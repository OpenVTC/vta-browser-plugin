// DIDs — the `did:webvh` identifiers a context publishes.
//
// Scoped to the selected context like Keys, and for the same reason:
// `webvhDidList` takes a `contextId`, so a changed selection asks the agent a
// different question rather than filtering an answer it already gave.
//
// A DID here is a *published* identifier: its log lives on a hosting server and
// anyone can resolve it. That is why deletion is treated as the sharpest action
// in this console — see the confirm copy.

import { useCallback, useState } from "react";
import {
  webvhDidCreate,
  webvhDidDelete,
  webvhDidList,
  type WebvhDidRecord,
} from "@openvtc/pnm-core/webvh";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatDate } from "../format.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

function CreateDid({
  parties,
  contextId,
  authority,
  onCreated,
}: {
  parties: Parties;
  contextId: ContextSelection;
  authority: Authority | null;
  onCreated: () => void;
}) {
  const [serverId, setServerId] = useState("");
  const [portable, setPortable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Creating a DID needs an administrative role at this agent."
    : !contextId
      ? "Select a context in the tree first — a DID is created inside one."
      : null;

  const submit = useCallback(async () => {
    if (!contextId) return;
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await webvhDidCreate(managerSender, {
          ...parties,
          contextId,
          portable,
          ...(serverId.trim() ? { serverId: serverId.trim() } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setServerId("");
      onCreated();
    }
  }, [parties, contextId, serverId, portable, onCreated]);

  return (
    <Panel
      title="New DID"
      description={
        contextId ? (
          <>
            Created in <code style={{ fontFamily: font.mono }}>{contextId}</code> and published as
            a <code style={{ fontFamily: font.mono }}>did:webvh</code> log on a hosting server.
            Once published it is resolvable by anyone.
          </>
        ) : (
          "Select a context in the tree to create a DID inside it."
        )
      }
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>SERVER ID (optional)</span>
          <input
            style={fieldStyle}
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            placeholder="your agent's default"
          />
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: t.sm, paddingBottom: 7 }}>
          <input type="checkbox" checked={portable} onChange={(e) => setPortable(e.target.checked)} />
          Portable
        </label>
      </div>

      {portable && (
        <Note tone="warn">
          A portable DID can be moved to another hosting domain later. That flexibility is decided
          now and cannot be added afterwards — but it also means the DID's identifier does not pin
          it to one host.
        </Note>
      )}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div>
        <Button
          kind="primary"
          disabled={busy || Boolean(denied)}
          {...(denied ? { title: denied } : {})}
          onClick={() => void submit()}
        >
          {busy ? "Creating…" : "Create DID"}
        </Button>
      </div>
      {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
    </Panel>
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
      render: (d) => <Did value={d.did} />,
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
      render: (d) => <span style={{ color: c.muted }}>{d.logEntryCount}</span>,
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
        <div style={{ minWidth: 190 }}>
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
