// App state — where applications keep their metadata in the agent.
//
// `vta/app-state/*`: durable key/value records the *agent* holds, as opposed to
// the wallet's own `KVStore`, which is this browser profile's state and is
// invisible to a phone or a second laptop signed in as the same holder. This is
// the only place an application can keep something that has to be true on every
// device — so it is also the place where a wrong or stale record follows the
// user everywhere.
//
// ## Why this pane demands a context, rather than defaulting to all of them
//
// Every other context-scoped pane treats `contextId` as a filter: omit it and
// the agent answers for everything the caller can reach. App-state does not
// work that way — `contextId` is part of the *address*. A record is
// `(contextId, namespace, key)`, and two contexts holding the same namespace
// and key hold two unrelated records.
//
// So there is no "all contexts" answer to give, and inventing one by fanning
// out across contexts would produce a list in which identical-looking rows are
// different records. The pane asks for a context instead.
//
// ## Two things the agent tracks that this pane must not flatten
//
// Records are **versioned**, and every write can carry `expectedVersion` — so
// an edit compare-and-swaps against what was read rather than overwriting
// whatever arrived since. And deletes are **soft**: `includeDeleted` reveals
// tombstones, which is the difference between "no application ever wrote this"
// and "something deleted it".

import { useCallback, useState } from "react";
import {
  appStateDelete,
  appStateList,
  appStatePut,
  type AppStateRecord,
} from "@openvtc/pnm-core";
import { Button, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, Truncated, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatInstant } from "../format.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";

const PAGE = 100;

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

const codeStyle: React.CSSProperties = {
  ...fieldStyle,
  fontFamily: font.mono,
  fontSize: t.xs,
  minHeight: 140,
  width: "100%",
  lineHeight: 1.5,
  resize: "vertical",
};

/** The record's value, rendered as the agent stored it. */
function Value({ record }: { record: AppStateRecord }) {
  if (record.value === undefined) {
    // `appStateList` can be asked for keys without values, and a tombstone has
    // none. Three different facts — not fetched, deleted, stored empty — that
    // an empty cell would collapse into one.
    return (
      <span style={{ color: c.faint }}>{record.deleted ? "deleted" : "not fetched"}</span>
    );
  }
  const text = JSON.stringify(record.value, null, 2);
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: font.mono,
        fontSize: t.xs,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 160,
        overflowY: "auto",
        maxWidth: 460,
      }}
    >
      {text}
    </pre>
  );
}

function WriteRecord({
  parties,
  contextId,
  authority,
  existing,
  onDone,
  onCancel,
}: {
  parties: Parties;
  contextId: string;
  authority: Authority | null;
  existing?: AppStateRecord;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [namespace, setNamespace] = useState(existing?.namespace ?? "");
  const [key, setKey] = useState(existing?.key ?? "");
  const [value, setValue] = useState(() => {
    return existing?.value === undefined ? "{}" : JSON.stringify(existing.value, null, 2);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Writing app state needs an administrative role at this agent."
    : null;

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    // The schema types `value` as a JSON object, so anything else is refused
    // here rather than sent and rejected. Reporting "expected an object" beside
    // the box beats the agent's parse error arriving with no cursor in it.
    let parsed: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(value);
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        setError("A record's value must be a JSON object — an array or a bare value is not one.");
        setBusy(false);
        return;
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      setError("That is not valid JSON. A record's value must be a JSON object.");
      setBusy(false);
      return;
    }
    const ok = await runMutation(
      async () => {
        await appStatePut(managerSender, {
          ...parties,
          contextId,
          namespace: namespace.trim(),
          key: key.trim(),
          value: parsed,
          // Compare-and-swap against the version this editor opened on, so an
          // application that wrote since is not silently overwritten.
          ...(existing ? { expectedVersion: existing.version } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onDone();
  }, [parties, contextId, namespace, key, value, existing, onDone]);

  return (
    <Panel
      title={existing ? `Edit ${existing.namespace}/${existing.key}` : "New record"}
      description={
        existing ? (
          <>
            Saving is compare-and-swapped against version{" "}
            <strong>{existing.version}</strong> — if an application has written
            since this editor opened, your save is refused rather than overwriting it.
          </>
        ) : (
          <>
            Written into <code style={{ fontFamily: font.mono }}>{contextId}</code>. Applications
            read this on every device the holder uses, so a wrong value here follows them
            everywhere.
          </>
        )
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>NAMESPACE</span>
            <input
              style={{ ...fieldStyle, fontFamily: font.mono }}
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              disabled={Boolean(existing)}
              placeholder="net.openvtc.app"
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>KEY</span>
            <input
              style={{ ...fieldStyle, fontFamily: font.mono }}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={Boolean(existing)}
            />
          </label>
        </div>
        {existing && (
          <span style={{ fontSize: t.xs, color: c.faint }}>
            Namespace and key form the record's address and cannot be changed — write a new
            record and delete this one instead.
          </span>
        )}

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>VALUE</span>
          <textarea
            style={codeStyle}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
          />
        </label>
        <span style={{ fontSize: t.xs, color: c.faint }}>
          A JSON object. Applications read this shape directly, so a key renamed here is a key
          the application stops finding.
        </span>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="primary"
            disabled={busy || !namespace.trim() || !key.trim() || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save changes" : "Write record"}
          </Button>
          {onCancel && (
            <Button kind="quiet" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

export function AppStatePane({
  parties,
  authority,
  contextId,
  contextHeading,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: ContextSelection;
  contextHeading?: string | undefined;
}) {
  const [namespace, setNamespace] = useState("");
  const [applied, setApplied] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<AppStateRecord | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useAsync(
    async () =>
      contextId
        ? appStateList(managerSender, {
            ...parties,
            contextId,
            includeValues: true,
            includeDeleted,
            pageSize: PAGE,
            ...(applied ? { namespace: applied } : {}),
          })
        : null,
    [parties.holder.did, parties.service.did, contextId, applied, includeDeleted],
  );

  const deleteDenied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Deleting app state needs an administrative role at this agent."
    : null;

  // `contextId` is the record's address, not a filter — there is no
  // agent-wide answer to give. See the header.
  if (!contextId) {
    return (
      <Panel
        title="App state"
        description="Durable key/value records applications keep in your agent, so they are true
          on every device you use rather than only in this browser."
      >
        <Note tone="accent">
          <strong>Select a context in the tree.</strong> Unlike keys or DIDs, a context is part of
          an app-state record's address rather than a filter over it —{" "}
          <code style={{ fontFamily: font.mono }}>(context, namespace, key)</code> together name
          one record. Two contexts holding the same namespace and key hold two unrelated records,
          so there is no agent-wide list to show you.
        </Note>
      </Panel>
    );
  }

  const records = list.data?.records ?? [];
  const done = () => {
    setEditing(null);
    setCreating(false);
    list.reload();
  };

  if (editing) {
    return (
      <WriteRecord
        parties={parties}
        contextId={contextId}
        authority={authority}
        existing={editing}
        onDone={done}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<AppStateRecord>[] = [
    {
      key: "ns",
      header: "Namespace",
      render: (r) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{r.namespace}</span>
      ),
    },
    {
      key: "key",
      header: "Key",
      render: (r) => <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{r.key}</span>,
    },
    { key: "value", header: "Value", render: (r) => <Value record={r} /> },
    {
      key: "version",
      header: "Version",
      render: (r) => <span style={{ color: c.muted }}>{r.version}</span>,
    },
    {
      key: "state",
      header: "State",
      render: (r) =>
        // A tombstone is not an absent record, and the difference is the whole
        // reason `includeDeleted` exists.
        r.deleted ? (
          <Pill tone="off">deleted</Pill>
        ) : (
          <Pill tone="ok">live</Pill>
        ),
    },
    {
      key: "updated",
      header: "Updated",
      render: (r) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
          {formatInstant(r.updatedAt, "—")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) =>
        r.deleted ? (
          <span style={{ color: c.faint, fontSize: t.xs }}>deleted</span>
        ) : (
          <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
            <Button kind="quiet" onClick={() => setEditing(r)}>
              Edit
            </Button>
            <Destructive<AppStateRecord>
              label="Delete"
              disabledReason={deleteDenied}
              preview={async () => r}
              renderPreview={(p) => (
                <>
                  <strong>
                    Deleting {p.namespace}/{p.key} takes it away on every device.
                  </strong>
                  <span>
                    App state is the agent's copy, not this browser's — whatever application
                    reads this key stops finding it everywhere the holder is signed in, not just
                    here. If the application treats an absent record as "not set up yet", that is
                    the state it will fall back to.
                  </span>
                </>
              )}
              commit={async () => {
                await appStateDelete(managerSender, {
                  ...parties,
                  contextId,
                  namespace: r.namespace,
                  key: r.key,
                  expectedVersion: r.version,
                });
              }}
              onDone={done}
            />
          </div>
        ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={`App state in ${contextHeading ?? contextId}`}
        description="Durable key/value records applications keep in your agent. Unlike the
          wallet's own storage these follow the holder to every device, so what is here is what
          every one of them sees."
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 260px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>NAMESPACE</span>
            <input
              style={{ ...fieldStyle, fontFamily: font.mono }}
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="all namespaces"
            />
          </label>
          <div style={{ paddingBottom: 1 }}>
            <Button onClick={() => setApplied(namespace.trim())}>Filter</Button>
          </div>
          <label
            style={{ display: "flex", gap: 7, alignItems: "center", fontSize: t.sm, paddingBottom: 7 }}
          >
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
            />
            Show deleted
          </label>
        </div>

        {list.error && <LoadError what="app state" error={list.error} />}
        {list.loading && !list.data && <Loading what="app state" />}
        {list.data && (
          <>
            <Table
              columns={columns}
              rows={records}
              rowKey={(r) => `${r.namespace}/${r.key}`}
              empty={
                applied
                  ? `No records in namespace ${applied}. Clear the filter to see the rest.`
                  : `No application has written anything into ${contextId}.`
              }
            />
            {list.data.cursor && <Truncated what="this context's records" />}
          </>
        )}

        {!creating && (
          <div>
            <Button onClick={() => setCreating(true)}>New record</Button>
          </div>
        )}
      </Panel>

      {creating && (
        <WriteRecord
          parties={parties}
          contextId={contextId}
          authority={authority}
          onDone={done}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}
