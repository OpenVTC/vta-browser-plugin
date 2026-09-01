// Access — who may act at this agent, in which contexts, until when.
//
// The sharpest pane in the console: an ACL entry is the authority itself, and
// `acl/grant` is how someone who could do nothing here comes to be able to do
// everything.
//
// Two things the agent enforces that this pane must not paper over:
//
//  - **`aclUpdate` replaces scopes wholesale, and refuses to narrow.** Sending
//    a shorter set is not "remove these" — the agent rejects a reduction here
//    on purpose, because a narrowing typed into an edit box looks identical to
//    a mistake. Taking authority away goes through `aclRevoke`, which says so.
//  - **`aclChangeRole` compare-and-swaps against the current role.** The form
//    carries `fromRole` from the row it was opened on, so a role someone else
//    changed in between rejects rather than silently overwriting their change.

import { useCallback, useState } from "react";
import {
  aclChangeRole,
  aclList,
  aclRevoke,
  aclGrant,
  type AclEntry,
} from "@openvtc/pnm-core/admin";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Redacted, Table, Truncated, type Column } from "../table.js";
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

function Expiry({ entry }: { entry: AclEntry }) {
  if (!entry.expiresAt) {
    // Not "—". An entry that never expires is a standing grant, and that is a
    // decision worth reading as one.
    return <span style={{ color: c.warn }}>never</span>;
  }
  const when = new Date(entry.expiresAt);
  const past = when.getTime() < Date.now();
  return (
    <span style={{ color: past ? c.faint : c.muted, whiteSpace: "nowrap" }}>
      {when.toLocaleDateString()}
      {past ? " (expired)" : ""}
    </span>
  );
}

function ChangeRole({
  parties,
  entry,
  onDone,
}: {
  parties: Parties;
  entry: AclEntry;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [toRole, setToRole] = useState(entry.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  if (!open) {
    return (
      <Button kind="quiet" onClick={() => setOpen(true)}>
        Change role
      </Button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 7 }}>
      <input style={fieldStyle} value={toRole} onChange={(e) => setToRole(e.target.value)} />
      <span style={{ fontSize: t.xs, color: c.faint }}>
        from <strong>{entry.role}</strong> — rejected if it changed since this list was read
      </span>
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}
      <div style={{ display: "flex", gap: 6 }}>
        <Button
          disabled={busy || !toRole.trim() || toRole === entry.role}
          onClick={() => {
            setBusy(true);
            setError(null);
            void runMutation(
              async () => {
                await aclChangeRole(managerSender, {
                  ...parties,
                  subject: entry.subject,
                  // Compare-and-swap against what this row was read at.
                  fromRole: entry.role,
                  toRole: toRole.trim(),
                });
              },
              { onConsent: setPending, onError: setError },
            ).then((ok) => {
              setBusy(false);
              if (ok) {
                setOpen(false);
                onDone();
              }
            });
          }}
        >
          {busy ? "Changing…" : "Change"}
        </Button>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function GrantAccess({
  parties,
  contextId,
  authority,
  onGranted,
}: {
  parties: Parties;
  contextId: ContextSelection;
  authority: Authority | null;
  onGranted: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState("");
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Granting access needs the admin role at this agent."
    : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const entry: AclEntry = {
      subject: subject.trim(),
      role: role.trim(),
      ...(contextId ? { scopes: [contextId] } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      // A date input gives a local day; the wire wants an instant.
      ...(expiresAt ? { expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString() } : {}),
    };
    const ok = await runMutation(
      async () => {
        await aclGrant(managerSender, { ...parties, entry });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setSubject("");
      setRole("");
      setLabel("");
      setExpiresAt("");
      onGranted();
    }
  }, [parties, subject, role, label, expiresAt, contextId, onGranted]);

  return (
    <Panel
      title="Grant access"
      description={
        contextId ? (
          <>
            Scoped to <code style={{ fontFamily: font.mono }}>{contextId}</code>. The subject will
            be able to act at this agent within that context, as the role allows.
          </>
        ) : (
          <>
            <strong>Unscoped.</strong> With no context selected this grant reaches everything the
            role permits, everywhere. Select a context in the tree to confine it.
          </>
        )
      }
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 620 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>SUBJECT DID</span>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="did:key:z6Mk…"
          />
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>ROLE</span>
            <input style={fieldStyle} value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>LABEL (optional)</span>
            <input style={fieldStyle} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>EXPIRES (optional)</span>
            <input
              type="date"
              style={fieldStyle}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </label>
        </div>

        {!expiresAt && (
          <Note tone="warn">
            With no expiry this is a standing grant — it lasts until someone revokes it. An expiry
            is the difference between access you decided to give and access you forgot about.
          </Note>
        )}
        {!contextId && (
          <Note tone="danger">
            No context is selected, so this grant is not confined to one. That is rarely what you
            want.
          </Note>
        )}
        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div>
          <Button
            kind="primary"
            disabled={busy || !subject.trim() || !role.trim() || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void submit()}
          >
            {busy ? "Granting…" : "Grant access"}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

export function AccessPane({
  parties,
  authority,
  contextId,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: ContextSelection;
}) {
  const list = useAsync(
    () => aclList(managerSender, { ...parties, ...(contextId ? { scope: contextId } : {}) }),
    [parties.holder.did, parties.service.did, contextId],
  );

  const revokeDenied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Revoking access needs the admin role at this agent."
    : null;

  const columns: Column<AclEntry>[] = [
    {
      key: "subject",
      header: "Subject",
      render: (e) => (
        <div style={{ display: "grid", gap: 2 }}>
          <Did value={e.subject} />
          {e.label && <span style={{ color: c.muted, fontSize: t.xs }}>{e.label}</span>}
        </div>
      ),
    },
    { key: "role", header: "Role", render: (e) => <Pill tone="accent">{e.role}</Pill> },
    {
      key: "scopes",
      header: "Contexts",
      render: (e) =>
        e.scopes?.length ? (
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{e.scopes.join(", ")}</span>
        ) : (
          // An entry with no scopes is not restricted to none — it is
          // restricted to nothing, i.e. everywhere. Say which.
          <span style={{ color: c.warn }}>everywhere</span>
        ),
    },
    { key: "expires", header: "Expires", render: (e) => <Expiry entry={e} /> },
    {
      key: "actions",
      header: "",
      render: (e) => (
        <div style={{ display: "grid", gap: 8, minWidth: 200 }}>
          <ChangeRole parties={parties} entry={e} onDone={list.reload} />
          <Destructive<AclEntry>
            label="Revoke"
            disabledReason={revokeDenied}
            preview={async () => e}
            renderPreview={(p) => (
              <>
                <strong>Revoking this entry takes away all of its authority.</strong>
                <span>
                  <Did value={p.subject} size={t.xs} /> loses the <strong>{p.role}</strong> role
                  {p.scopes?.length ? ` in ${p.scopes.join(", ")}` : " everywhere"}. Anything
                  running as that subject stops working immediately — including, if it is a
                  device or an agent you rely on, one you may not be watching.
                </span>
              </>
            )}
            commit={async () => {
              await aclRevoke(managerSender, { ...parties, subject: e.subject });
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
        title={contextId ? `Access to ${contextId}` : "Access to this agent"}
        description="Who may act here, as what, and until when. This is the authority itself —
          the agent checks it on every task, including the ones this console sends."
      >
        {list.error && <LoadError what="the access list" error={list.error} />}
        {list.loading && !list.data && <Loading what="the access list" />}
        {list.data && (
          <>
            <Redacted fields={list.data.redactedFields} />
            <Table
              columns={columns}
              rows={list.data.entries}
              rowKey={(e) => e.subject}
              empty={
                contextId
                  ? `Nobody holds an entry scoped to ${contextId}.`
                  : "No entries you can read. Grants you administer appear here."
              }
            />
            {list.data.truncated && <Truncated what="the access list" />}
          </>
        )}
      </Panel>

      <GrantAccess
        parties={parties}
        contextId={contextId}
        authority={authority}
        onGranted={list.reload}
      />
    </div>
  );
}
