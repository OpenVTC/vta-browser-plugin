// Agent memory — what your agent has been told to remember.
//
// `vta/memory/*`: plain string key/value, scoped to a context. This is the
// store behind the memory tooling an assistant uses, so what is listed here is
// what it will recall in a future conversation — which makes deletion the
// operation that matters most. A memory formed from a misunderstanding does not
// decay; it gets recalled, acted on, and quietly shapes answers until somebody
// removes it.
//
// **`contextId` is required**, and the module says why: memory has no global
// namespace. The context is the isolation boundary — an agent scoped elsewhere
// cannot see these — so, as with app-state, there is no agent-wide list to
// show and the pane asks for a context instead of inventing one.
//
// ## Writing by hand
//
// `memoryPut` is offered here, and it is worth being clear about what it does:
// a memory written from this console is stored identically to one the agent
// formed during a conversation. There is no provenance marker in the record, so
// nothing downstream can tell them apart — the value is simply what the agent
// will recall. Useful for correcting; not a place to be casual.

import { useCallback, useMemo, useState } from "react";
import { memoryDelete, memoryList, memoryPut } from "@openvtc/pnm-core/admin";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";

interface MemoryItem {
  key: string;
  value: string;
}

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

function WriteMemory({
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
  existing?: MemoryItem;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [key, setKey] = useState(existing?.key ?? "");
  const [value, setValue] = useState(existing?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Writing memory needs an administrative role at this agent."
    : null;

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await memoryPut(managerSender, {
          ...parties,
          contextId,
          key: key.trim(),
          value,
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onDone();
  }, [parties, contextId, key, value, onDone]);

  return (
    <Panel
      title={existing ? `Edit ${existing.key}` : "New memory"}
      description={
        existing
          ? "Writing replaces whatever this key held. There is no version check on this " +
            "family, so a write here wins over anything stored since this editor opened."
          : "Your agent will recall this in future conversations, exactly as if it had formed " +
            "the memory itself — nothing in the record marks it as hand-written."
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>KEY</span>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={Boolean(existing)}
          />
        </label>
        {existing && (
          <span style={{ fontSize: t.xs, color: c.faint }}>
            The key is the record's address. To rename, write a new memory and forget this one.
          </span>
        )}
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>VALUE</span>
          <textarea
            style={{ ...fieldStyle, minHeight: 110, width: "100%", lineHeight: 1.55, resize: "vertical" }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="primary"
            disabled={busy || !key.trim() || !value.trim() || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save" : "Remember this"}
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

export function MemoryPane({
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
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useAsync(
    async () => (contextId ? memoryList(managerSender, { ...parties, contextId }) : null),
    [parties.holder.did, parties.service.did, contextId],
  );

  const items = list.data ?? [];
  // Filtering happens here because `vta/memory/list` takes no filter — the
  // agent sends the whole context. Said plainly rather than implied, so the
  // count below is not mistaken for a server-side search.
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (i) => i.key.toLowerCase().includes(needle) || i.value.toLowerCase().includes(needle),
    );
  }, [items, filter]);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Forgetting a memory needs an administrative role at this agent."
    : null;

  if (!contextId) {
    return (
      <Panel
        title="Agent memory"
        description="What your agent remembers between conversations."
      >
        <Note tone="accent">
          <strong>Select a context in the tree.</strong> Memory has no global namespace — the
          context is the isolation boundary, and an agent scoped to a different one cannot see
          these at all. There is no agent-wide list to show you.
        </Note>
      </Panel>
    );
  }

  const done = () => {
    setEditing(null);
    setCreating(false);
    list.reload();
  };

  if (editing) {
    return (
      <WriteMemory
        key={editing.key}
        parties={parties}
        contextId={contextId}
        authority={authority}
        existing={editing}
        onDone={done}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const columns: Column<MemoryItem>[] = [
    {
      key: "key",
      header: "Key",
      width: "220px",
      render: (m) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-word" }}>
          {m.key}
        </span>
      ),
    },
    {
      key: "value",
      header: "Remembered",
      render: (m) => (
        <span style={{ lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {m.value}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (m) => (
        <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
          <Button kind="quiet" onClick={() => setEditing(m)}>
            Edit
          </Button>
          <Destructive<MemoryItem>
            label="Forget"
            disabledReason={denied}
            preview={async () => m}
            renderPreview={(p) => (
              <>
                <strong>Forgetting this cannot be undone.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{p.key}</span>
                <span style={{ whiteSpace: "pre-wrap" }}>{p.value}</span>
                <span>
                  Your agent stops recalling this in future conversations. Anything it has
                  already said or done on the strength of it is unaffected.
                </span>
              </>
            )}
            commit={async () => {
              await memoryDelete(managerSender, { ...parties, contextId, key: m.key });
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
        title={`Memory in ${contextHeading ?? contextId}`}
        description="What your agent will recall in future conversations. A memory formed from a
          misunderstanding does not decay on its own — this is where it gets removed."
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 320px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>FILTER</span>
            <input
              style={fieldStyle}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="key or text"
            />
          </label>
          {filter.trim() && (
            <span style={{ fontSize: t.sm, color: c.muted, paddingBottom: 7 }}>
              {shown.length} of {items.length}
            </span>
          )}
        </div>

        {list.error && <LoadError what="agent memory" error={list.error} />}
        {list.loading && !list.data && <Loading what="agent memory" />}
        {list.data && (
          <Table
            columns={columns}
            rows={shown}
            rowKey={(m) => m.key}
            empty={
              filter.trim()
                ? "Nothing here matches that. Clear the filter to see the rest."
                : `Your agent remembers nothing in ${contextId}.`
            }
          />
        )}

        {!creating && (
          <div>
            <Button onClick={() => setCreating(true)}>New memory</Button>
          </div>
        )}
      </Panel>

      {creating && (
        <WriteMemory
          key="new"
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
