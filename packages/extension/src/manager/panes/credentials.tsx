// Credentials — what this agent issues to others, and takes back.
//
// ## What it took to show the issued list
//
// `vta/credentials` declared `issue` and `revoke` and nothing else, so this
// pane spent its first version saying so — "there is no list of issued
// credentials, and this is not an empty one" — rather than rendering a blank
// table, which would have read as "you have issued nothing" and been wrong the
// moment anything had been.
//
// The task now exists: specified at trustoverip/dtgwg-trust-tasks-tf#342 and
// implemented at OpenVTC/verifiable-trust-infrastructure#1235. `IssuedList`
// below is what the notice became.
//
// Two things it renders that the shape makes easy to lose. `truncated` means
// the agent stopped early, so a caller must not read the page as a complete
// account of what was issued — it is surfaced above the table rather than
// below it. And `status` is derived by the agent at read time with `revoked`
// beating `expired`, so it is never cached and never recomputed here: a copy
// of a fact about the clock is wrong from the first second after it is made.
//
// The holder side — the credentials this agent *holds* — lives in a different
// family again (`vault/credentials/*`) and is in `HeldCredentials` below. It
// waited on `trustoverip/dtgwg-trust-tasks-tf#338`, which specified that family
// from the implementation that had been dispatching it unspecified; before that
// there were no bindings and hand-transcribing the shapes would have been the
// copy-that-drifts this repo has removed once already.
//
// Two things that surface carries which a list of credentials would otherwise
// flatten. **Query refuses an unconstrained filter** — an empty one returns the
// shape of the holder's whole life, so the pane requires a filter and says so
// rather than firing a request it knows will be refused. And **validity and
// lifecycle are orthogonal**: a credential can be `valid` and `archived`, or
// `revoked` and `active`, so both are rendered and neither is derived from the
// other.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  issueCredential,
  listCredentials,
  revokeCredential,
  type IssuedCredentialSummary,
} from "@openvtc/pnm-core/admin";
import {
  credVaultArchive,
  credVaultDelete,
  credVaultPurge,
  credVaultGet,
  credVaultQuery,
  credVaultRestore,
  credVaultUnarchive,
  isRunnableCredentialQuery,
  type CredentialDescriptor,
  type CredentialFilter,
  type CredentialStatus,
} from "@openvtc/pnm-core";
import { Button, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatDate, isPast } from "../format.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";

const DAY = 86400;

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

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: t.xs, color: c.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
      {children}
    </span>
  );
}

function IssueCredential({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const [holderDid, setHolderDid] = useState("");
  const [credentialType, setCredentialType] = useState("");
  const [claims, setClaims] = useState("{\n  \n}");
  const [validityDays, setValidityDays] = useState("365");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Issuing a credential needs the admin role at this agent."
    : null;

  const days = Number(validityDays);
  const daysValid = Number.isFinite(days) && days > 0;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    setIssued(null);

    let parsed: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(claims);
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        setError("Claims must be a JSON object.");
        setBusy(false);
        return;
      }
      parsed = candidate as Record<string, unknown>;
    } catch {
      setError("Claims are not valid JSON.");
      setBusy(false);
      return;
    }

    const ok = await runMutation(
      async () => {
        const res = await issueCredential(managerSender, {
          ...parties,
          holderDid: holderDid.trim(),
          claims: parsed as never,
          validitySeconds: Math.round(days * DAY),
          ...(credentialType.trim() ? { credentialType: credentialType.trim() } : {}),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        });
        // The id is the only handle revocation has, and there is no list to
        // recover it from later. Surfaced prominently for exactly that reason.
        const id = (res as { credentialId?: string; id?: string }).credentialId
          ?? (res as { id?: string }).id
          ?? null;
        setIssued(id);
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setHolderDid("");
      setClaims("{\n  \n}");
    }
  }, [parties, holderDid, claims, days, credentialType, purpose]);

  return (
    <Panel
      title="Issue a credential"
      description="Your agent signs this as issuer. Once it reaches the holder it is theirs to
        present anywhere, to anyone who trusts your agent — revocation is the only way back."
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 680 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Holder DID</Label>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={holderDid}
            onChange={(e) => setHolderDid(e.target.value)}
            placeholder="did:key:z6Mk…"
          />
        </label>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 220px" }}>
            <Label>Type (optional)</Label>
            <input
              style={fieldStyle}
              value={credentialType}
              onChange={(e) => setCredentialType(e.target.value)}
              placeholder="MembershipCredential"
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <Label>Valid for (days)</Label>
            <input
              style={{ ...fieldStyle, width: 120 }}
              value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)}
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
            <Label>Purpose (optional)</Label>
            <input style={fieldStyle} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </label>
        </div>

        <label style={{ display: "grid", gap: 4 }}>
          <Label>Claims</Label>
          <textarea
            style={codeStyle}
            value={claims}
            onChange={(e) => setClaims(e.target.value)}
            spellCheck={false}
          />
        </label>
        <span style={{ fontSize: t.xs, color: c.faint }}>
          A JSON object. Everything in here is asserted by your agent and readable by anyone the
          holder shows it to.
        </span>

        {!daysValid && validityDays.trim() !== "" && (
          <Note tone="danger">Validity must be a positive number of days.</Note>
        )}
        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        {issued !== null && (
          <Note tone="warn">
            <div style={{ display: "grid", gap: 6 }}>
              <strong>Issued. Keep this id.</strong>
              <span style={{ fontFamily: font.mono, fontSize: t.sm, wordBreak: "break-all" }}>
                {issued || "(your agent returned no id)"}
              </span>
              <span>
                It is the only handle revocation has, and your agent offers no way to list
                issued credentials — so if this is lost, the audit trail is the only place it
                can be recovered from.
              </span>
            </div>
          </Note>
        )}

        <div>
          <Button
            kind="primary"
            disabled={busy || !holderDid.trim() || !daysValid || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void submit()}
          >
            {busy ? "Issuing…" : "Issue credential"}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

function RevokeCredential({
  parties,
  authority,
  prefillId,
  onConsumed,
}: {
  parties: Parties;
  authority: Authority | null;
  /** A credential id picked from the list above, so an operator never copies an
   *  opaque identifier by eye before an irreversible action. */
  prefillId?: string | null;
  onConsumed?: () => void;
}) {
  const [credentialId, setCredentialId] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [done, setDone] = useState(false);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Revoking a credential needs the admin role at this agent."
    : null;

  // A pick from the list replaces whatever was typed, and clears any previous
  // outcome — a stale "Revoked." beside a different id reads as a result for
  // the one now in the field.
  useEffect(() => {
    if (!prefillId) return;
    setCredentialId(prefillId);
    setConfirming(false);
    setDone(false);
    setError(null);
  }, [prefillId]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await revokeCredential(managerSender, {
          ...parties,
          credentialId: credentialId.trim(),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setDone(true);
      setConfirming(false);
      setCredentialId("");
      setReason("");
      onConsumed?.();
    }
  }, [parties, credentialId, reason, onConsumed]);

  return (
    <Panel
      title="Revoke a credential"
      description="By id. Pick a row above and its id lands here — copying an opaque identifier
        by eye before an irreversible action is how the wrong credential gets revoked."
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 680 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Credential id</Label>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={credentialId}
            onChange={(e) => {
              setCredentialId(e.target.value);
              setConfirming(false);
              setDone(false);
            }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Reason (optional, recorded)</Label>
          <input style={fieldStyle} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}
        {done && <Note tone="accent">Revoked.</Note>}

        {/* No preview is possible — there is no read task to preview *from*.
            So the confirm step states what cannot be checked rather than
            dressing up a guess as a preview. */}
        {confirming ? (
          <>
            <Note tone="danger">
              <div style={{ display: "grid", gap: 6 }}>
                <strong>Revoking cannot be undone.</strong>
                <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
                  {credentialId.trim()}
                </span>
                <span>
                  Whoever holds this stops being able to present it anywhere that checks
                  revocation. The list above shows who holds it and when it was issued; what it
                  actually <em>claims</em> cannot be shown — there is no task that reads a
                  credential body back — so if the claims are what you are deciding on, check
                  your own records first.
                </span>
              </div>
            </Note>
            <div style={{ display: "flex", gap: 8 }}>
              <Button kind="danger" disabled={busy} onClick={() => void submit()}>
                {busy ? "Revoking…" : "Revoke it"}
              </Button>
              <Button kind="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button
              kind="danger"
              disabled={!credentialId.trim() || Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => setConfirming(true)}
            >
              Revoke
            </Button>
          </div>
        )}
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

/** Validity and lifecycle are separate axes, so they get separate pills. A
 *  single "status" column would have to pick one and would be wrong about the
 *  other — a revoked-but-active credential and a valid-but-archived one are
 *  both real, and mean opposite things. */
function ValidityPill({ status }: { status: CredentialDescriptor["status"] }) {
  const tone = status === "valid" ? "ok" : status === "unknown" ? "off" : "danger";
  return <Pill tone={tone}>{status}</Pill>;
}

function LifecyclePill({ record }: { record: CredentialDescriptor }) {
  const state = record.lifecycle ?? "active";
  if (state === "active") return <Pill tone="ok">active</Pill>;
  if (state === "archived") return <Pill tone="off">archived</Pill>;
  // A tombstone's grace window is the whole reason to show this row: after it
  // passes the agent has erased the credential and restore does nothing.
  const expired = isPast(record.graceUntil);
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <Pill tone="danger">deleted</Pill>
      <span style={{ fontSize: t.xs, color: expired ? c.faint : c.warn, whiteSpace: "nowrap" }}>
        {record.graceUntil
          ? expired
            ? "grace expired"
            : `restorable until ${formatDate(record.graceUntil)}`
          : "not restorable"}
      </span>
    </div>
  );
}

function HeldCredentials({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const [filter, setFilter] = useState<CredentialFilter>({});
  const [applied, setApplied] = useState<CredentialFilter | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [rows, setRows] = useState<CredentialDescriptor[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The agent refuses an unconstrained query, so the control is disabled rather
  // than firing a request whose refusal the operator would have to interpret.
  const runnable = isRunnableCredentialQuery(filter);

  const search = useCallback(
    async (f: CredentialFilter = filter, arch = includeArchived, del = includeDeleted) => {
      if (!isRunnableCredentialQuery(f)) return;
      setLoading(true);
      setError(null);
      try {
        setRows(await credVaultQuery(managerSender, {
          ...parties, ...f, includeArchived: arch, includeDeleted: del,
        }));
        setApplied(f);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [parties, filter, includeArchived, includeDeleted],
  );

  const reload = useCallback(() => {
    if (applied) void search(applied, includeArchived, includeDeleted);
  }, [applied, search, includeArchived, includeDeleted]);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Changing a stored credential needs an administrative role at this agent."
    : null;

  const set = (k: keyof CredentialFilter) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilter((prev) => {
      const next = { ...prev };
      if (e.target.value) (next as Record<string, string>)[k] = e.target.value;
      else delete next[k];
      return next;
    });

  const columns: Column<CredentialDescriptor>[] = useMemo(() => [
    {
      key: "types",
      header: "Credential",
      render: (r) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>
            {r.types.filter((x) => x !== "VerifiableCredential").join(", ") || "VerifiableCredential"}
          </span>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint }}>{r.id}</span>
        </div>
      ),
    },
    {
      key: "issuer",
      header: "Issuer",
      render: (r) => (r.issuerDid ? <Did value={r.issuerDid} size={t.xs} /> : <span style={{ color: c.faint }}>—</span>),
    },
    {
      key: "purpose",
      header: "Purpose",
      render: (r) => <span style={{ color: c.muted }}>{r.purpose ?? "—"}</span>,
    },
    { key: "validity", header: "Validity", render: (r) => <ValidityPill status={r.status} /> },
    { key: "lifecycle", header: "State", render: (r) => <LifecyclePill record={r} /> },
    {
      key: "until",
      header: "Valid until",
      render: (r) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>{formatDate(r.validUntil, "—")}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) => {
        const state = r.lifecycle ?? "active";
        return (
          <div style={{ display: "grid", gap: 8, minWidth: 200 }}>
            {/* Reading a credential is its own request. The search returned
                metadata; this fetches the document by id. */}
            <Button kind="quiet" onClick={() => setViewing(r.id)}>
              View
            </Button>
            {state === "active" && (
              <Button
                kind="quiet"
                disabled={Boolean(denied)}
                {...(denied ? { title: denied } : {})}
                onClick={() => void credVaultArchive(managerSender, { ...parties, id: r.id }).then(reload)}
              >
                Archive
              </Button>
            )}
            {state === "archived" && (
              <Button
                kind="quiet"
                disabled={Boolean(denied)}
                {...(denied ? { title: denied } : {})}
                onClick={() => void credVaultUnarchive(managerSender, { ...parties, id: r.id }).then(reload)}
              >
                Unarchive
              </Button>
            )}
            {state === "deleted" && !isPast(r.graceUntil) && (
              <Button
                kind="quiet"
                disabled={Boolean(denied)}
                {...(denied ? { title: denied } : {})}
                onClick={() => void credVaultRestore(managerSender, { ...parties, id: r.id }).then(reload)}
              >
                Restore
              </Button>
            )}
            {state !== "deleted" ? (
              <Destructive<CredentialDescriptor>
                label="Delete"
                disabledReason={denied}
                preview={async () => r}
                renderPreview={(p) => (
                  <>
                    <strong>This moves the credential to the trash, recoverably.</strong>
                    <span>
                      It stops being presentable straight away. Your agent keeps it until its
                      grace window passes, then erases it — after that, getting it back means
                      going back to {p.issuerDid ? "the issuer" : "whoever issued it"}, which for
                      an invitation or a one-time membership may not be possible at all.
                    </span>
                  </>
                )}
                commit={async () => {
                  await credVaultDelete(managerSender, { ...parties, id: r.id });
                }}
                onDone={reload}
              />
            ) : (
              <Destructive<CredentialDescriptor>
                label="Purge"
                disabledReason={denied}
                preview={async () => r}
                renderPreview={() => (
                  <>
                    <strong>Purging erases this now, and nothing can bring it back.</strong>
                    <span>
                      Not a faster delete — it skips the grace window entirely. Use it when the
                      requirement is that the material stop existing.
                    </span>
                  </>
                )}
                commit={async () => {
                  await credVaultPurge(managerSender, { ...parties, id: r.id });
                }}
                onDone={reload}
              />
            )}
          </div>
        );
      },
    },
  ], [parties, denied, reload]);

  return (
    <Panel
      title="Credentials this agent holds"
      description="Invitations, memberships and roles issued to you and stored by your agent.
        Searching returns metadata only — your agent never puts a credential's contents in a
        search result."
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
          <Label>Type</Label>
          <input style={fieldStyle} value={filter.type ?? ""} onChange={set("type")}
            placeholder="MembershipCredential" />
        </label>
        <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
          <Label>Purpose</Label>
          <input style={fieldStyle} value={filter.purpose ?? ""} onChange={set("purpose")}
            placeholder="membership" />
        </label>
        <label style={{ display: "grid", gap: 4, flex: "1 1 240px" }}>
          <Label>Issuer DID</Label>
          <input style={{ ...fieldStyle, fontFamily: font.mono }} value={filter.issuerDid ?? ""}
            onChange={set("issuerDid")} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Validity</Label>
          <select style={fieldStyle} value={filter.status ?? ""} onChange={set("status")}>
            <option value="">any</option>
            <option value="valid">valid</option>
            <option value="expired">expired</option>
            <option value="revoked">revoked</option>
            <option value="unknown">unknown</option>
          </select>
        </label>
        <div style={{ paddingBottom: 1 }}>
          <Button
            kind="primary"
            disabled={!runnable || loading}
            {...(!runnable ? { title: "Set at least one filter — see below." } : {})}
            onClick={() => void search()}
          >
            {loading ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: t.sm }}>
          <input type="checkbox" checked={includeArchived}
            onChange={(e) => { setIncludeArchived(e.target.checked); if (applied) void search(applied, e.target.checked, includeDeleted); }} />
          Include archived
        </label>
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: t.sm }}>
          <input type="checkbox" checked={includeDeleted}
            onChange={(e) => { setIncludeDeleted(e.target.checked); if (applied) void search(applied, includeArchived, e.target.checked); }} />
          Include deleted (trash)
        </label>
      </div>

      {!runnable && (
        <Note tone="accent">
          <div style={{ display: "grid", gap: 8 }}>
            <span>
              <strong>Set at least one filter.</strong> Your agent refuses a search that constrains
              nothing, because the answer would be the shape of everything you hold — every
              community, every role, every issuer. The two tick-boxes widen a search rather than
              narrowing one, so they do not count on their own.
            </span>
            {/* The refusal is the agent's, and it is reasonable — but "set a
                filter" is a poor answer to "what do I have?", which is the
                question almost everyone opens this pane with. Answering it
                needed a `type` or an issuer DID the operator would have to
                know in advance, so a wallet holding credentials looked
                identical to one holding none.

                `status` counts as a filter, so one click gets there. Not a way
                round the rule — it is the rule satisfied with the narrowest
                thing that still answers the question. Named for what it
                returns, because `valid` excludes expired and revoked and the
                button should not imply otherwise. */}
            <div>
              <Button
                onClick={() => {
                  const f = { ...filter, status: "valid" as CredentialStatus };
                  setFilter(f);
                  void search(f);
                }}
              >
                Show what is currently valid
              </Button>
            </div>
            <span style={{ fontSize: t.xs, color: c.faint }}>
              Expired and revoked credentials are still held — pick their status above to see them.
            </span>
          </div>
        </Note>
      )}

      {error && <LoadError what="your stored credentials" error={error} />}
      {loading && !rows && <Loading what="your stored credentials" />}

      {rows && (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty="Nothing matches that filter. Your agent answered — this is not a failed search."
        />
      )}

      {viewing && (
        <CredentialView
          key={viewing}
          parties={parties}
          id={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </Panel>
  );
}


/**
 * Fetch and show one credential's contents.
 *
 * Separate from the search on purpose, and the panel says why: a query answers
 * with metadata, and the contents only ever arrive because someone asked for
 * this one credential by id. Rendering the whole document from a list would
 * have quietly turned "show me what I hold" into "read everything I hold".
 *
 * The copy button hands over the exact bytes the agent returned, canonically
 * formatted — this is the form a verifier expects, so it must not be a
 * prettified approximation of it.
 */
function CredentialView({
  parties,
  id,
  onClose,
}: {
  parties: Parties;
  id: string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setError(null);
    credVaultGet(managerSender, { ...parties, id })
      .then((d) => live && setDoc(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [parties, id]);

  const text = doc ? JSON.stringify(doc, null, 2) : "";

  return (
    <Panel
      title="Credential"
      description={<code style={{ fontFamily: font.mono, fontSize: t.xs }}>{id}</code>}
    >
      <div style={{ display: "grid", gap: 10 }}>
        {error && <LoadError what="this credential" error={error} />}
        {!doc && !error && <Loading what="this credential" />}

        {doc && (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(text).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    // Clipboard access can be refused — say so rather than
                    // showing "Copied" over a clipboard that did not change.
                    () => setError("The browser refused clipboard access."),
                  );
                }}
              >
                {copied ? "Copied" : "Copy JSON"}
              </Button>
              <Button kind="quiet" onClick={onClose}>
                Close
              </Button>
            </div>
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: c.ground,
                border: `1px solid ${c.line}`,
                borderRadius: "var(--w-r-sm)",
                fontFamily: font.mono,
                fontSize: t.xs,
                lineHeight: 1.5,
                overflowX: "auto",
                maxHeight: 460,
                overflowY: "auto",
                whiteSpace: "pre",
              }}
            >
              {text}
            </pre>
          </>
        )}
      </div>
    </Panel>
  );
}

/** Validity of an issued credential. Derived by the agent at read time — see
 *  the header — so this only paints what it was told. */
function IssuedStatus({ row }: { row: IssuedCredentialSummary }) {
  if (row.status === "revoked") {
    return (
      <div style={{ display: "grid", gap: 2 }}>
        <Pill tone="danger">revoked</Pill>
        {row.revokedAt && (
          <span style={{ fontSize: t.xs, color: c.muted, whiteSpace: "nowrap" }}>
            {formatDate(row.revokedAt)}
          </span>
        )}
        {row.revocationReason && (
          <span style={{ fontSize: t.xs, color: c.faint, maxWidth: 200, lineHeight: 1.4 }}>
            {row.revocationReason}
          </span>
        )}
      </div>
    );
  }
  return <Pill tone={row.status === "active" ? "ok" : "off"}>{row.status}</Pill>;
}

function IssuedList({
  parties,
  authority,
  onRevoke,
}: {
  parties: Parties;
  authority: Authority | null;
  /** Hand a credential id to the revoke form below, so an operator never has to
   *  copy an opaque identifier by eye. */
  onRevoke: (credentialId: string) => void;
}) {
  const [holderDid, setHolderDid] = useState("");
  const [status, setStatus] = useState("");
  const [applied, setApplied] = useState({ holderDid: "", status: "" });
  const [pageSize, setPageSize] = useState(50);

  const list = useAsync(
    () =>
      listCredentials(managerSender, {
        ...parties,
        pageSize,
        ...(applied.holderDid ? { holderDid: applied.holderDid } : {}),
        ...(applied.status
          ? { status: applied.status as IssuedCredentialSummary["status"] }
          : {}),
      }),
    [parties.holder.did, parties.service.did, applied.holderDid, applied.status, pageSize],
  );

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Reading the issuance log needs an administrative role at this agent."
    : null;

  const columns: Column<IssuedCredentialSummary>[] = [
    {
      key: "id",
      header: "Credential",
      render: (r) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{r.credentialType ?? "VerifiableCredential"}</span>
          <span
            style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}
          >
            {r.credentialId}
          </span>
        </div>
      ),
    },
    { key: "holder", header: "Issued to", render: (r) => <Did value={r.holder} size={t.xs} /> },
    { key: "status", header: "Status", render: (r) => <IssuedStatus row={r} /> },
    {
      key: "issued",
      header: "Issued",
      render: (r) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>{formatDate(r.issuedAt)}</span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      render: (r) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>{formatDate(r.expiresAt)}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) =>
        r.status === "revoked" ? (
          <span style={{ color: c.faint, fontSize: t.xs }}>revoked</span>
        ) : (
          <Button
            kind="quiet"
            disabled={Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => onRevoke(r.credentialId)}
          >
            Revoke…
          </Button>
        ),
    },
  ];

  return (
    <Panel
      title="Credentials this agent has issued"
      description="Metadata only — your agent returns no claim bodies here, and this console does
        not ask for any. Status is computed when the list is read, so it is current rather than
        remembered."
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 300px" }}>
          <Label>Holder DID</Label>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={holderDid}
            onChange={(e) => setHolderDid(e.target.value)}
            placeholder="all holders"
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Status</Label>
          <select style={fieldStyle} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">any</option>
            <option value="active">active</option>
            <option value="expired">expired</option>
            <option value="revoked">revoked</option>
          </select>
        </label>
        <div style={{ paddingBottom: 1 }}>
          <Button
            onClick={() => {
              setPageSize(50);
              setApplied({ holderDid: holderDid.trim(), status });
            }}
          >
            Filter
          </Button>
        </div>
      </div>

      {list.error && <LoadError what="the issuance log" error={list.error} />}
      {list.loading && !list.data && <Loading what="the issuance log" />}

      {list.data && (
        <>
          {/* Above the table. A caution under a long list is one nobody reads,
              and this one changes what the list *means*. */}
          {list.data.truncated && (
            <Note tone="warn">
              <strong>This is not everything your agent has issued.</strong> It stopped early, so
              anything you conclude from what is below — including that a credential was never
              issued — may be wrong.{" "}
              <button
                onClick={() => setPageSize((n) => n + 50)}
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
              , or narrow by holder.
            </Note>
          )}
          <Table
            columns={columns}
            rows={list.data.credentials}
            rowKey={(r) => r.credentialId}
            empty={
              applied.holderDid || applied.status
                ? "Nothing matches those filters. Clear them to see the rest."
                : "Your agent has issued nothing yet."
            }
          />
        </>
      )}
    </Panel>
  );
}

export function CredentialsPane({
  parties,
  authority,
  onOpenAudit,
}: {
  parties: Parties;
  authority: Authority | null;
  /** The audit trail — still the place that answers "what happened", which the
   *  issuance list deliberately does not: one is a record of events, the other
   *  a view of current state. */
  onOpenAudit: () => void;
}) {
  // Set by a row's "Revoke…", read by the revoke form. The id is opaque and
  // long, and asking an operator to copy one by eye before an irreversible
  // action is how the wrong credential gets revoked.
  const [revokeId, setRevokeId] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title="Credentials this agent issues"
        description="Your agent as an issuer: minting credentials for others, and taking them
          back."
      >
        <div style={{ fontSize: t.sm, color: c.muted, lineHeight: 1.55 }}>
          Issuing as <Did value={parties.service.did} size={t.xs} />. For the history of
          issuance and revocation events rather than what is current,{" "}
          <button
            onClick={onOpenAudit}
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
            open the audit trail
          </button>
          .
        </div>
      </Panel>

      <IssuedList parties={parties} authority={authority} onRevoke={setRevokeId} />

      <IssueCredential parties={parties} authority={authority} />
      <RevokeCredential
        parties={parties}
        authority={authority}
        prefillId={revokeId}
        onConsumed={() => setRevokeId(null)}
      />

      <HeldCredentials parties={parties} authority={authority} />
    </div>
  );
}
