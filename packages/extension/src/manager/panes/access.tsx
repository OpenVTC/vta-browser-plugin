// Access — who may act at this agent, in which contexts, until when.
//
// The sharpest pane in the console: an ACL entry is the authority itself, and
// `acl/grant` is how someone who could do nothing here comes to be able to do
// everything.
//
// Two things the agent enforces that this pane must not paper over:
//
//  - **`aclUpdate` replaces an act scope wholesale, and refuses to narrow it.**
//    Sending a shorter set is not "remove these" — the agent rejects a
//    reduction here on purpose, because a narrowing typed into an edit box
//    looks identical to a mistake. Taking authority away goes through
//    `aclRevoke`, which says so.
//  - **`aclChangeRole` compare-and-swaps against the current role.** The form
//    carries `fromRole` from the row it was opened on, so a role someone else
//    changed in between rejects rather than silently overwriting their change.
//  - **A capability narrowing only ever subtracts.** The effective set is the
//    role's intersected with the entry's own non-additive grants, so the role
//    stays a true upper bound and this pane can never be used to hand a reader
//    an admin's authority. The agent re-reads the entry on every gated call, so a change
//    here binds the subject's *next* request rather than waiting for their next
//    token — do not imply a delay that is not there.
//
// Every scope on an AclEntry 0.2 is stated — `act`, `keys` and `capabilities`
// have no implicit form — so this pane reads them as written and never infers
// one from the role. 0.1's "empty scopes means everywhere on an admin and
// nowhere on anyone else" is exactly the inference 0.2 removed.

import { useCallback, useState } from "react";
import {
  aclChangeRole,
  aclList,
  aclRevoke,
  aclGrant,
  aclUpdate,
  effectiveCapabilities,
  narrowingToSend,
  isAdditiveCapability,
  DERIVED_CAPABILITIES,
  isAclRole,
  type AclEntry,
  type AuthorityScope,
  type EffectiveCapabilities,
} from "@openvtc/pnm-core/admin";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Redacted, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatDate, isPast } from "../format.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";
import { MailDid } from "../mail-did.js";

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
 * What an entry holds, without letting a malformed scope blank the pane.
 *
 * `effectiveCapabilities` throws on a capability scope it cannot read, and that
 * strictness is right — every guess about an unreadable scope is a statement
 * about the entry's authority nobody checked. But a throw inside a table cell
 * takes the whole access list with it, so the read is caught here and rendered
 * as the uncertainty it is. `eff` is `undefined` for a role this console does
 * not know.
 */
function readCapabilities(entry: AclEntry): { eff: EffectiveCapabilities | undefined; error?: string } {
  try {
    return { eff: effectiveCapabilities(entry.role, entry.capabilities) };
  } catch (e) {
    return { eff: undefined, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Where an act (or approve) scope reaches, in words. `all` and `none` are
 *  both stated in 0.2, and neither reads as the other. */
export function describeScope(scope: AuthorityScope): string {
  switch (scope.scope) {
    case "all":
      return "everywhere";
    case "none":
      return "nowhere";
    case "contexts":
      return scope.contexts.join(", ");
    default:
      return `an unrecognised scope (${String((scope as { scope: unknown }).scope)})`;
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
  const stored = readCapabilities(entry);
  if (stored.error) {
    return (
      <span style={{ color: c.danger, fontSize: t.xs }}>
        unreadable capabilities — {stored.error}
      </span>
    );
  }

  const eff = stored.eff;
  if (!eff) {
    // Not "holds nothing". This console is older than the agent, and the honest
    // answer is that it cannot say — which is a different thing from an answer.
    return (
      <span style={{ color: c.warn, fontSize: t.xs }}>
        role <strong>{entry.role}</strong> is unknown here — this console cannot say what it holds
      </span>
    );
  }

  // Additive grants (`persona-holder`) sit outside the role, so they are named
  // on their own line rather than folded into a count of the role's set.
  const additive =
    eff.additive.length > 0 ? (
      <span style={{ fontFamily: font.mono, fontSize: t.xs }}>+ {eff.additive.join(", ")}</span>
    ) : null;
  const fromRole = eff.effective.filter((cap) => !isAdditiveCapability(cap));

  if (eff.unnarrowed) {
    return (
      <div style={{ display: "grid", gap: 2 }}>
        <span style={{ color: c.muted, fontSize: t.xs }}>
          everything <strong>{entry.role}</strong> allows ({eff.derived.length})
        </span>
        {additive}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "baseline" }}>
        <Pill tone="warn">narrowed</Pill>
        <span style={{ color: c.faint, fontSize: t.xs }}>
          {fromRole.length} of {eff.derived.length}
        </span>
      </div>
      {fromRole.length === 0 ? (
        // `capabilities: none`, or a listing naming nothing the role carries.
        // This agent refuses to write either, but an entry is read as stated,
        // and one that holds nothing of its role must say so.
        <span style={{ color: c.danger, fontSize: t.xs }}>
          nothing — the entry holds no capability the {entry.role} role carries
        </span>
      ) : (
        <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-word" }}>
          {fromRole.join(", ")}
        </span>
      )}
      {additive}
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
  const stored = readCapabilities(entry);
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
    // Only the role's set is editable here; an additive grant is carried
    // through by `narrowingToSend`, never ticked or unticked.
    const eff = stored.eff;
    setKept(eff ? eff.effective.filter((cap) => !isAdditiveCapability(cap)) : []);
    setError(null);
    setOpen(true);
  };

  if (!open) {
    return (
      <Button kind="quiet" disabled={!derived || Boolean(stored.error)} onClick={start}>
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

  const heldAdditive = stored.eff?.additive ?? [];
  const narrowed = stored.eff ? !stored.eff.unnarrowed : false;

  const submit = (intent: "narrow" | "clear") => {
    // Builds the 0.2 capability scope, carrying any additive grant through
    // and refusing — before anything is sent — a name outside the role and a
    // narrowing to nothing.
    const plan = narrowingToSend(entry.role, kept, entry.capabilities, intent);
    if (!plan.ok) {
      setError(plan.reason);
      return;
    }
    const capabilities = plan.capabilities;
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
        // Not expressible: the agent cannot hold an entry with none of its
        // role's capabilities, and refuses one rather than store it.
        <Note tone="danger">
          Nothing ticked. A narrowing cannot keep nothing — your agent cannot hold an entry with
          none of what the <strong>{entry.role}</strong> role allows. To take that authority away,
          change the role.
        </Note>
      )}
      {heldAdditive.length > 0 && (
        <span style={{ fontSize: t.xs, color: c.faint }}>
          Also holds <code>{heldAdditive.join(", ")}</code>, which sits outside the role and is kept
          whichever button you press. Clearing therefore lists today&rsquo;s role in full beside
          it — the only way to say &ldquo;the whole role, and this&rdquo; — so a capability the role
          gains later will not reach this entry.
        </span>
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
        <Button disabled={busy || kept.length === 0} onClick={() => submit("narrow")}>
          {busy ? "Saving…" : "Narrow"}
        </Button>
        <Button
          kind="quiet"
          // Clearing is the one direction here that ADDS authority, back up to
          // whatever the role implies. Offered only when there is a narrowing
          // to clear, so the widening button is absent on entries it would
          // silently no-op against.
          // An entry holding its whole role plus an additive grant has nothing
          // to clear.
          disabled={busy || !narrowed}
          onClick={() => submit("clear")}
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

/** The local calendar day of an instant, as a date input spells it. */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * What an edit asks `acl/update` to change — only the members that moved.
 *
 * `acl/update` is a partial update, so an omitted member is left alone and a
 * `null` one is cleared. Sending every member the form shows would rewrite an
 * untouched expiry at end-of-day precision, and a label resent unchanged is an
 * audit record of a change nobody made. So a member goes out only when the
 * operator altered it, and emptying a field that held something is a `null`,
 * never an omission — the two are opposite instructions.
 */
export function aclEditToSend(
  entry: Pick<AclEntry, "label" | "expiresAt">,
  form: { label: string; expiresDay: string },
): { label?: string | null; expiresAt?: string | null } {
  const out: { label?: string | null; expiresAt?: string | null } = {};
  const label = form.label.trim();
  const was = entry.label ?? "";
  if (label !== was) out.label = label ? label : null;

  const wasDay = entry.expiresAt ? localDay(entry.expiresAt) : "";
  if (form.expiresDay !== wasDay) {
    // A date input gives a local day; the wire wants an instant. Clearing it
    // makes the entry permanent — a privilege increase the agent gates.
    out.expiresAt = form.expiresDay
      ? new Date(`${form.expiresDay}T23:59:59`).toISOString()
      : null;
  }
  return out;
}

/**
 * Change an entry's label and expiry.
 *
 * Role, act scope and capabilities are deliberately not here: each has its own
 * task with its own name in the audit trail (`acl/change-role`, `acl/revoke`,
 * the narrowing editor), and folding them into one Save would make a reduction
 * in authority look like a tidy-up.
 */
function EditEntry({
  parties,
  entry,
  onClose,
  onDone,
}: {
  parties: Parties;
  entry: AclEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  // Opened on what the entry holds, so Save without a change sends nothing.
  const [label, setLabel] = useState(entry.label ?? "");
  const [expiresDay, setExpiresDay] = useState(entry.expiresAt ? localDay(entry.expiresAt) : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const change = aclEditToSend(entry, { label, expiresDay });
  const changed = Object.keys(change).length > 0;
  const makesPermanent = change.expiresAt === null;

  const submit = () => {
    setBusy(true);
    setError(null);
    setPending(null);
    void runMutation(
      async () => {
        await aclUpdate(managerSender, {
          ...parties,
          subject: entry.subject,
          ...change,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    ).then((ok) => {
      setBusy(false);
      if (ok) {
        onClose();
        onDone();
      }
    });
  };

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 620, paddingTop: 4 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>LABEL</span>
          <input
            style={fieldStyle}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What this subject is — a device, a person, a service"
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>EXPIRES</span>
          <input
            type="date"
            style={fieldStyle}
            value={expiresDay}
            onChange={(e) => setExpiresDay(e.target.value)}
          />
        </label>
      </div>
      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: t.xs, color: c.muted }}>REASON (optional, recorded with the change)</span>
        <input style={fieldStyle} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {makesPermanent && (
        <Note tone="warn">
          Clearing the expiry makes this a standing grant — it lasts until someone revokes it. Your
          agent treats that as an increase in authority and may ask for approval.
        </Note>
      )}
      <span style={{ fontSize: t.xs, color: c.faint }}>
        To change the role, the contexts or what it can do, use the row&rsquo;s own actions — each
        is recorded as the change it is.
      </span>
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}
      <div style={{ display: "flex", gap: 6 }}>
        <Button disabled={busy || !changed} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button kind="quiet" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What a new grant may do where it reaches: make changes itself (`act`), or
 * only ratify changes someone else makes (`approve`).
 */
export type GrantReach = "act" | "approve";

/**
 * The entry a grant sends. Every axis is stated, because AclEntry 0.2 has no
 * default for any of them, and none is derived from the role.
 *
 * - **`act`**: the act scope is the selected context, or everywhere. An agent
 *   that cannot hold `all` on the role refuses it (`invalidActScope`) rather
 *   than this form quietly sending `none` and granting a role that can act
 *   nowhere. Keys and capabilities are the role's whole reach; narrowing either
 *   is a decision taken afterwards, on the row, where it is recorded as one.
 *   Approve authority is stated as none, not left absent to mean it.
 * - **`approve`**: the least-privilege approver the spec names — act `none`,
 *   and the approve scope where the act scope would have been. It holds no
 *   capabilities and no keys, and may approve the role's whole approve ceiling
 *   (`approveCapabilities` absent would mean none, so it is stated).
 */
export function grantEntry(p: {
  subject: string;
  role: string;
  contextId: ContextSelection;
  reach: GrantReach;
}): AclEntry {
  const where: AclEntry["act"] = p.contextId
    ? { scope: "contexts", contexts: [p.contextId] }
    : { scope: "all" };
  return p.reach === "approve"
    ? {
        subject: p.subject,
        role: p.role,
        act: { scope: "none" },
        approve: where,
        approveCapabilities: { scope: "ceiling" },
        keys: { scope: "none" },
        capabilities: { scope: "none" },
      }
    : {
        subject: p.subject,
        role: p.role,
        act: where,
        approve: { scope: "none" },
        keys: { scope: "all" },
        capabilities: { scope: "ceiling" },
      };
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
  const [reach, setReach] = useState<GrantReach>("act");
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
      ...grantEntry({ subject: subject.trim(), role: role.trim(), contextId, reach }),
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
      setReach("act");
      onGranted();
    }
  }, [parties, subject, role, label, expiresAt, contextId, reach, onGranted]);

  return (
    <Panel
      title="Grant access"
      description={
        contextId ? (
          <>
            Scoped to <code style={{ fontFamily: font.mono }}>{contextId}</code>. The subject will
            be able to {reach === "approve" ? "approve changes" : "act"} at this agent within that
            context, as the role allows.
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
            placeholder="did:key:z6Mk… or did:peer:2…"
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

        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
          <legend style={{ fontSize: t.xs, color: c.muted, padding: 0, marginBottom: 4 }}>
            WHAT IT MAY DO {contextId ? "THERE" : "EVERYWHERE"}
          </legend>
          <label style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <input type="radio" checked={reach === "act"} onChange={() => setReach("act")} />
            <span>Act — make changes itself, as the role allows</span>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <input
              type="radio"
              checked={reach === "approve"}
              onChange={() => setReach("approve")}
            />
            <span>
              Approve only — ratify changes someone else makes, and act nowhere. It holds no
              capabilities and no keys.
            </span>
          </label>
        </fieldset>

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

/**
 * Split a context's access list into what was granted in it and what reaches
 * it from outside.
 *
 * `acl/list` filtered by context `actingIn` answers "who can act here", which
 * rightly includes every agent-wide entry — but shown as one list under a
 * context's name, an admin granted everywhere reads as though it had been
 * granted in this context, and revoking it "here" takes it away everywhere.
 * Membership is read from the entry's own act scope, never from the filter
 * that returned it.
 */
export function partitionByContext(
  entries: AclEntry[],
  contextId: string,
): { granted: AclEntry[]; inherited: AclEntry[] } {
  const granted: AclEntry[] = [];
  const inherited: AclEntry[] = [];
  for (const e of entries) {
    const here = e.act.scope === "contexts" && e.act.contexts.includes(contextId);
    (here ? granted : inherited).push(e);
  }
  return { granted, inherited };
}

function GroupHeading({ title, note }: { title: string; note: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, margin: "4px 0 2px" }}>
      <span
        style={{
          fontSize: t.xs,
          fontWeight: 640,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: c.muted,
        }}
      >
        {title}
      </span>
      <span style={{ fontSize: t.xs, color: c.faint, lineHeight: 1.5 }}>{note}</span>
    </div>
  );
}

function Grouped({
  contextId,
  contextHeading,
  entries,
  renderTable,
}: {
  contextId: string;
  contextHeading: string;
  entries: AclEntry[];
  renderTable: (rows: AclEntry[], empty: React.ReactNode) => React.ReactNode;
}) {
  const { granted, inherited } = partitionByContext(entries, contextId);
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <GroupHeading
          title={`Granted in ${contextHeading} (${granted.length})`}
          note={<>Entries that name this context. Their authority here is what they were given for it.</>}
        />
        {renderTable(granted, `Nobody holds an entry scoped to ${contextHeading}.`)}
      </div>
      {inherited.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <GroupHeading
            title={`From outside this context (${inherited.length})`}
            note={
              <>
                These were not granted in {contextHeading} — they reach it because they are not
                confined to it. Editing or revoking one here changes it{" "}
                <strong>everywhere it applies</strong>, not just in this context.
              </>
            }
          />
          {renderTable(inherited, null)}
        </div>
      )}
    </div>
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
    () =>
      aclList(managerSender, {
        ...parties,
        // `actingIn` is the question this pane asks — who may act here — and
        // it has to be said: `acl/list/0.3` refuses a context with no
        // direction rather than guess one.
        ...(contextId ? { context: contextId, direction: "actingIn" as const } : {}),
      }),
    [parties.holder.did, parties.service.did, contextId],
  );

  const isAdmin = !authority || hasRole(authority, "admin", "super-admin");
  const revokeDenied = isAdmin ? null : "Revoking access needs the admin role at this agent.";
  const editDenied = isAdmin ? null : "Editing access needs the admin role at this agent.";
  // Which row's editor is open. One at a time, keyed by subject — the list's
  // own row key — so a reload that reorders rows keeps it under the right one.
  const [editing, setEditing] = useState<string | null>(null);

  const columns: Column<AclEntry>[] = [
    {
      key: "subject",
      header: "Subject",
      render: (e) => (
        <div style={{ display: "grid", gap: 2 }}>
          <MailDid value={e.subject} />
          {e.label && <span style={{ color: c.muted, fontSize: t.xs }}>{e.label}</span>}
        </div>
      ),
    },
    { key: "role", header: "Role", render: (e) => <Pill tone="accent">{e.role}</Pill> },
    {
      key: "act",
      header: "Contexts",
      render: (e) =>
        e.act.scope === "contexts" ? (
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{describeScope(e.act)}</span>
        ) : (
          // `all` and `none` are both stated, and both deserve to be read:
          // everywhere is the widest grant there is, and nowhere is an entry
          // that can only ratify (or nothing at all).
          <span style={{ color: e.act.scope === "all" ? c.warn : c.muted }}>
            {describeScope(e.act)}
          </span>
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
          <Button
            kind="quiet"
            disabled={Boolean(editDenied)}
            {...(editDenied ? { title: editDenied } : {})}
            onClick={() => setEditing(editing === e.subject ? null : e.subject)}
          >
            Edit…
          </Button>
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
                  <MailDid value={p.subject} size={t.xs} /> loses the <strong>{p.role}</strong> role
                  {p.act.scope === "contexts" ? ` in ${describeScope(p.act)}` : ` ${describeScope(p.act)}`}. Anything
                  running as that subject stops working immediately — including, if it is a
                  device or an agent you rely on, one you may not be watching.
                </span>
              </>
            )}
            commit={async () => {
              await aclRevoke(managerSender, {
                ...parties,
                subject: e.subject,
                revocation: { kind: "entry" },
              });
            }}
            onDone={list.reload}
          />
        </div>
      ),
    },
  ];

  const renderTable = (rows: AclEntry[], empty: React.ReactNode) => (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(e) => e.subject}
      // Under the row, not in the actions column: that column is the narrowest
      // in the table and a label field there shows a handful of characters.
      expanded={(e) =>
        editing === e.subject ? (
          <EditEntry
            key={e.subject}
            parties={parties}
            entry={e}
            onClose={() => setEditing(null)}
            onDone={list.reload}
          />
        ) : null
      }
      empty={empty}
    />
  );

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
            {contextId ? (
              <Grouped
                contextId={contextId}
                contextHeading={contextHeading ?? contextId}
                entries={list.data.entries}
                renderTable={renderTable}
              />
            ) : (
              renderTable(
                list.data.entries,
                "No entries you can read. Grants you administer appear here.",
              )
            )}
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
