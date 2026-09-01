// Policy — the Rego modules the agent evaluates before it acts.
//
// A power-user surface, and labelled as one. For "which tasks need a human"
// the answer is the Approvals pane; this is the layer underneath, where the
// rule is written rather than chosen.
//
// **Every write carries `expectedVersion`.** `PolicyModule` has a `version`,
// and both upsert and delete accept the version the editor was opened on. That
// is the difference between saving your edit and silently discarding somebody
// else's: without it, two operators editing the same module means last-write-
// wins, and the loser never finds out.

import { useCallback, useState } from "react";
import {
  policyDelete,
  policyList,
  policyUpsert,
  type PolicyModule,
} from "@openvtc/pnm-core/admin";
import { Button, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, Truncated, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
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

const codeStyle: React.CSSProperties = {
  ...fieldStyle,
  fontFamily: font.mono,
  fontSize: t.xs,
  minHeight: 180,
  width: "100%",
  lineHeight: 1.5,
  resize: "vertical",
};

function PolicyEditor({
  parties,
  existing,
  authority,
  onSaved,
  onCancel,
}: {
  parties: Parties;
  /** Absent for a new module. */
  existing?: PolicyModule;
  authority: Authority | null;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [module, setModule] = useState(existing?.module ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Editing policy needs the admin role at this agent."
    : null;

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await policyUpsert(managerSender, {
          ...parties,
          ...(existing ? { id: existing.id, expectedVersion: existing.version } : {}),
          name: name.trim(),
          module,
          enabled,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onSaved();
  }, [parties, existing, name, description, module, enabled, onSaved]);

  return (
    <Panel
      title={existing ? `Edit ${existing.name}` : "New policy module"}
      description={
        existing ? (
          <>
            Saving is compare-and-swapped against version{" "}
            <strong>{existing.version}</strong> — if someone else has changed this module since
            this editor opened, your save is refused rather than overwriting theirs.
          </>
        ) : (
          "A Rego module the agent evaluates before it acts. Written by hand; for the common " +
          "case of 'this task needs a human', use the Approvals pane instead."
        )
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>NAME</span>
            <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4, flex: "2 1 320px" }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>DESCRIPTION</span>
            <input
              style={fieldStyle}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>REGO MODULE</span>
          <textarea
            style={codeStyle}
            value={module}
            onChange={(e) => setModule(e.target.value)}
            spellCheck={false}
            placeholder={"package vta.policy\n\ndefault allow := false\n"}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: t.sm }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled — the agent evaluates this module on every gated task
        </label>

        {enabled && (
          <Note tone="warn">
            An enabled module takes effect as soon as it is saved. A module that denies more than
            you intended will refuse real work, including work this console does.
          </Note>
        )}
        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            kind="primary"
            disabled={busy || !name.trim() || !module.trim() || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : existing ? "Save changes" : "Create module"}
          </Button>
          {onCancel && (
            <Button kind="quiet" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

export function PolicyPane({
  parties,
  authority,
  contextId,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: ContextSelection;
}) {
  const [editing, setEditing] = useState<PolicyModule | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useAsync(
    () => policyList(managerSender, { ...parties, ...(contextId ? { contextId } : {}) }),
    [parties.holder.did, parties.service.did, contextId],
  );

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Deleting policy needs the admin role at this agent."
    : null;

  const done = () => {
    setEditing(null);
    setCreating(false);
    list.reload();
  };

  const columns: Column<PolicyModule>[] = [
    {
      key: "name",
      header: "Module",
      render: (p) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{p.name}</span>
          {p.description && (
            <span style={{ color: c.muted, fontSize: t.xs }}>{p.description}</span>
          )}
        </div>
      ),
    },
    {
      key: "enabled",
      header: "State",
      render: (p) => (p.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="off">disabled</Pill>),
    },
    {
      key: "applies",
      header: "Applies to",
      render: (p) =>
        p.appliesTo?.length ? (
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{p.appliesTo.join(", ")}</span>
        ) : (
          <span style={{ color: c.muted }}>every task</span>
        ),
    },
    {
      key: "version",
      header: "Version",
      render: (p) => <span style={{ color: c.muted }}>{p.version}</span>,
    },
    {
      key: "updated",
      header: "Updated",
      render: (p) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
          {new Date(p.updatedAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (p) => (
        <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
          <Button kind="quiet" onClick={() => setEditing(p)}>
            Edit
          </Button>
          <Destructive<PolicyModule>
            label="Delete"
            disabledReason={denied}
            preview={async () => p}
            renderPreview={(m) => (
              <>
                <strong>Deleting {m.name} removes the rule it enforces.</strong>
                <span>
                  {m.enabled
                    ? "It is currently enabled, so whatever it was refusing becomes allowed as " +
                      "soon as this is deleted."
                    : "It is currently disabled, so nothing changes about what the agent " +
                      "allows today — but the module itself is not recoverable."}
                </span>
              </>
            )}
            commit={async () => {
              await policyDelete(managerSender, {
                ...parties,
                id: p.id,
                // Same compare-and-swap as the editor: delete the version that
                // was read, not whatever is there now.
                expectedVersion: p.version,
              });
            }}
            onDone={done}
          />
        </div>
      ),
    },
  ];

  if (editing) {
    return (
      <PolicyEditor
        parties={parties}
        existing={editing}
        authority={authority}
        onSaved={done}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextId ? `Policy in ${contextId}` : "Policy"}
        description="Hand-authored Rego the agent evaluates before it acts. For the common case
          — which tasks need a human — the Approvals pane is the surface to use."
      >
        {list.error && <LoadError what="policy modules" error={list.error} />}
        {list.loading && !list.data && <Loading what="policy modules" />}
        {list.data && (
          <>
            <Table
              columns={columns}
              rows={list.data.policies}
              rowKey={(p) => p.id}
              empty="No policy modules. Without one the agent falls back to its configured
                defaults — which, for consent enforcement, is off."
            />
            {list.data.truncated && <Truncated what="the policy list" />}
          </>
        )}
        {!creating && (
          <div>
            <Button onClick={() => setCreating(true)}>New module</Button>
          </div>
        )}
      </Panel>

      {creating && (
        <PolicyEditor
          parties={parties}
          authority={authority}
          onSaved={done}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}
