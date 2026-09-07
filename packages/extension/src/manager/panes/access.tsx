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
//  - **A capability narrowing only ever subtracts.** The effective set is the
//    role's intersected with the entry's own, so the role stays a true upper
//    bound and this pane can never be used to hand a reader an admin's
//    authority. The agent re-reads the entry on every gated call, so a change
//    here binds the subject's *next* request rather than waiting for their next
//    token — do not imply a delay that is not there.

import { useCallback, useState } from "react";
import {
  aclChangeRole,
  aclList,
  aclRevoke,
  aclGrant,
  aclUpdate,
  checkNarrowing,
  effectiveCapabilities,
  entryNarrowing,
  DERIVED_CAPABILITIES,
  isAclRole,
  type AclEntry,
} from "@openvtc/pnm-core/admin";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Redacted, Table, Truncated, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatDate, isPast } from "../format.js";
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
  const past = isPast(entry.expiresAt);
  return (
    <span style={{ color: past ? c.faint : c.muted, whiteSpace: "nowrap" }}>
      {formatDate(entry.expiresAt)}
      {past ? " (expired)" : ""}
    </span>
  );
}

/**
 * The narrowing an entry carries, without letting a malformed one blank the pane.
 *
 * `entryNarrowing` throws on an `ext` member it cannot parse, and that strictness
 * is right — absence and "cannot read this" are opposite conclusions about an
 * entry's authority. But a throw inside a table cell takes the whole access list
 * with it, so the read is caught here and rendered as the uncertainty it is.
 */
function readNarrowing(entry: AclEntry): { names: string[] | undefined; error?: string } {
  try {
    return { names: entryNarrowing(entry) };
  } catch (e) {
    return { names: undefined, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What this entry may actually do.
 *
 * Deliberately not a list of every capability: an admin holds fourteen, and a
 * column that renders fourteen pills on every row buries the one entry that has
 * been narrowed. The unnarrowed case — which is every entry until someone acts
 * — is stated in one line, and detail appears only where there is a decision
 * behind it.
 */
function Capabilities({ entry }: { entry: AclEntry }) {
  const stored = readNarrowing(entry);
  if (stored.error) {
    return (
      <span style={{ color: c.danger, fontSize: t.xs }}>
        unreadable narrowing — {stored.error}
      </span>
    );
  }

  const eff = effectiveCapabilities(entry.role, stored.names);
  if (!eff) {
    // Not "holds nothing". This console is older than the agent, and the honest
    // answer is that it cannot say — which is a different thing from an answer.
    return (
      <span style={{ color: c.warn, fontSize: t.xs }}>
        role <strong>{entry.role}</strong> is unknown here — this console cannot say what it holds
      </span>
    );
  }

  if (eff.unnarrowed) {
    return (
      <span style={{ color: c.muted, fontSize: t.xs }}>
        everything <strong>{entry.role}</strong> allows ({eff.derived.length})
      </span>
    );
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "baseline" }}>
        <Pill tone="warn">narrowed</Pill>
        <span style={{ color: c.faint, fontSize: t.xs }}>
          {eff.effective.length} of {eff.derived.length}
        </span>
      </div>
      {eff.effective.length === 0 ? (
        // Reachable without anyone asking for it: `acl/change-role` moves the
        // role and leaves the stored narrowing alone, so an entry narrowed
        // within its old role can intersect to nothing under its new one.
        <span style={{ color: c.danger, fontSize: t.xs }}>
          nothing — the stored narrowing names no capability the {entry.role} role carries
        </span>
      ) : (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-word" }}>
          {eff.effective.join(", ")}
        </span>
      )}
      {eff.unrecognised.length > 0 && (
        <span style={{ color: c.warn, fontSize: t.xs }}>
          not enforced here: {eff.unrecognised.join(", ")} — this agent is newer than this console
        </span>
      )}
    </div>
  );
}

/**
 * Narrow an entry within its role, or clear a narrowing.
 *
 * The tick list is over the ROLE's derived set, not over every capability the
 * build knows: naming one the role does not carry is refused by the agent, and
 * offering it in a form is offering an error. The two buttons are separate
 * because they move authority in opposite directions.
 */
function NarrowCapabilities({
  parties,
  entry,
  onDone,
}: {
  parties: Parties;
  entry: AclEntry;
  onDone: () => void;
}) {
  const stored = readNarrowing(entry);
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const derived = isAclRole(entry.role) ? DERIVED_CAPABILITIES[entry.role] : null;

  const start = () => {
    // Preselect what the entry holds now, so opening the form and saving is a
    // no-op. An editor that opens on a blank selection turns "let me look" into
    // "narrow to nothing" for anyone who clicks the wrong button.
    const eff = effectiveCapabilities(entry.role, stored.names);
    setKept(eff ? [...eff.effective] : []);
    setError(null);
    setOpen(true);
  };

  if (!open) {
    return (
      <Button kind="quiet" disabled={!derived} onClick={start}>
        Capabilities…
      </Button>
    );
  }

  if (!derived) {
    return (
      <Note tone="warn">
        This console does not know the <strong>{entry.role}</strong> role, so it cannot say what a
        narrowing would leave. Use <code>pnm acl update</code>.
      </Note>
    );
  }

  if (derived.length === 0) {
    // `monitor` derives nothing, so the intersection is empty either way.
    return (
      <div style={{ display: "grid", gap: 7 }}>
        <Note tone="accent">
          The <strong>{entry.role}</strong> role carries no capabilities, so there is nothing to
          narrow. Change the role first.
        </Note>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    );
  }

  const submit = (capabilities: string[]) => {
    const check = checkNarrowing(entry.role, capabilities);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setBusy(true);
    setError(null);
    void runMutation(
      async () => {
        await aclUpdate(managerSender, {
          ...parties,
          subject: entry.subject,
          capabilities,
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
  };

  return (
    <div style={{ display: "grid", gap: 7 }}>
      <span style={{ fontSize: t.xs, color: c.faint }}>
        Ticked capabilities are kept. Unticking takes authority away on the subject&rsquo;s next
        request.
      </span>
      <div style={{ display: "grid", gap: 3 }}>
        {derived.map((cap) => (
          <label key={cap} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={kept.includes(cap)}
              onChange={(e) =>
                setKept((prev) =>
                  e.target.checked ? [...prev, cap] : prev.filter((x) => x !== cap),
                )
              }
            />
            <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{cap}</span>
          </label>
        ))}
      </div>
      {kept.length === 0 && (
        <Note tone="danger">
          Nothing ticked. This entry would keep its <strong>{entry.role}</strong> role and be able
          to do none of what the role allows.
        </Note>
      )}
      {kept.length === derived.length && (
        // Not the same as clearing, and the difference only shows up later: an
        // explicit list naming all of today's capabilities will not include one
        // the role gains tomorrow, where a cleared entry tracks the role.
        <Note tone="accent">
          Every capability ticked. This still stores a narrowing — it pins the entry to today&rsquo;s
          list, so a capability added to the role later will not reach it. To follow the role
          instead, clear the narrowing.
        </Note>
      )}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button disabled={busy} onClick={() => submit(kept)}>
          {busy ? "Saving…" : "Narrow"}
        </Button>
        <Button
          kind="quiet"
          // Clearing is the one direction here that ADDS authority, back up to
          // whatever the role implies. Offered only when there is a narrowing
          // to clear, so the widening button is absent on entries it would
          // silently no-op against.
          disabled={busy || stored.names === undefined}
          onClick={() => submit([])}
        >
          Clear narrowing
        </Button>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
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
    {
      key: "capabilities",
      header: "Can do",
      render: (e) => <Capabilities entry={e} />,
    },
    { key: "expires", header: "Expires", render: (e) => <Expiry entry={e} /> },
    {
      key: "actions",
      header: "",
      render: (e) => (
        <div style={{ display: "grid", gap: 8, minWidth: 200 }}>
          <ChangeRole parties={parties} entry={e} onDone={list.reload} />
          <NarrowCapabilities parties={parties} entry={e} onDone={list.reload} />
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
        title={contextHeading ? `Access to ${contextHeading}` : "Access to this agent"}
        description="Who may act here, as what, and until when. This is the authority itself —
          the agent checks it on every task, including the ones this console sends. A role is the
          ceiling; a narrowing subtracts from it and can never widen past it."
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
