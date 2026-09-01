// Approvals — who gets asked when your agent will not act alone.
//
// This is the pane with the most leverage over the wallet's own behaviour. An
// approver binding decides which party is sent the `task-consent/request` that
// the wallet renders as a consent prompt; a wrong or missing one is a gated
// action that never got its human check, which is the failure the whole consent
// path exists to prevent.
//
// Two lists, and they answer different questions. **Approvers** is
// configuration — who will be asked, per platform and context. **Grants** is
// history — what has already been consented to, and until when.

import { useCallback, useState } from "react";
import {
  consentApproverList,
  consentApproverSet,
  consentList,
  consentRevoke,
  type ApproverBinding,
  type ConsentGrant,
} from "@openvtc/pnm-core/admin";
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

function SetApprover({
  parties,
  contextId,
  authority,
  onSet,
}: {
  parties: Parties;
  contextId: ContextSelection;
  authority: Authority | null;
  onSet: () => void;
}) {
  const [platform, setPlatform] = useState("");
  const [approver, setApprover] = useState("");
  const [route, setRoute] = useState<"wake" | "bridge-relay">("wake");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Setting an approver needs the admin role at this agent."
    : !contextId
      ? "Select a context in the tree — an approver is bound to one."
      : null;

  const submit = useCallback(async () => {
    if (!contextId) return;
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await consentApproverSet(managerSender, {
          ...parties,
          platform: platform.trim(),
          context: contextId,
          approver: approver.trim(),
          route,
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setPlatform("");
      setApprover("");
      onSet();
    }
  }, [parties, platform, contextId, approver, route, onSet]);

  return (
    <Panel
      title="Bind an approver"
      description="The party your agent asks when a task needs a human. Getting this wrong is not
        a cosmetic error: the request goes somewhere nobody is watching, and a gated action never
        gets its check."
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>PLATFORM</span>
          <input
            style={fieldStyle}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: 4, flex: "1 1 320px" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>APPROVER DID</span>
          <input
            style={{ ...fieldStyle, fontFamily: font.mono }}
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
            placeholder="did:key:z6Mk…"
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>ROUTE</span>
          <select
            style={fieldStyle}
            value={route}
            onChange={(e) => setRoute(e.target.value as typeof route)}
          >
            <option value="wake">wake</option>
            <option value="bridge-relay">bridge-relay</option>
          </select>
        </label>
      </div>

      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div>
        <Button
          kind="primary"
          disabled={busy || !platform.trim() || !approver.trim() || Boolean(denied)}
          {...(denied ? { title: denied } : {})}
          onClick={() => void submit()}
        >
          {busy ? "Binding…" : "Bind approver"}
        </Button>
      </div>
      {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
    </Panel>
  );
}

export function ApprovalsPane({
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
  const approvers = useAsync(
    () =>
      consentApproverList(managerSender, {
        ...parties,
        ...(contextId ? { context: contextId } : {}),
      }),
    [parties.holder.did, parties.service.did, contextId],
  );

  const grants = useAsync(
    () => consentList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );

  const revokeDenied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Revoking consent needs the admin role at this agent."
    : null;

  const approverColumns: Column<ApproverBinding>[] = [
    { key: "platform", header: "Platform", render: (a) => a.platform },
    {
      key: "context",
      header: "Context",
      render: (a) => <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{a.context}</span>,
    },
    { key: "approver", header: "Approver", render: (a) => <Did value={a.approver} /> },
    {
      key: "route",
      header: "Route",
      render: (a) => (
        <div style={{ display: "grid", gap: 2 }}>
          <Pill tone="accent">{a.route ?? "wake"}</Pill>
          {a.routeHint && <span style={{ color: c.faint, fontSize: t.xs }}>{a.routeHint}</span>}
        </div>
      ),
    },
  ];

  const grantColumns: Column<ConsentGrant>[] = [
    {
      key: "subject",
      header: "Conversation",
      render: (g) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: t.sm }}>
            {g.subject.platform} · {g.subject.kind}
          </span>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}>
            {g.subject.conversationRef}
          </span>
        </div>
      ),
    },
    { key: "agent", header: "Agent", render: (g) => <Did value={g.subject.agent} /> },
    {
      key: "effect",
      header: "Effect",
      render: (g) => <Pill tone={g.effect === "allow" ? "ok" : "danger"}>{g.effect}</Pill>,
    },
    {
      key: "scope",
      header: "Scope",
      render: (g) => <span style={{ color: c.muted }}>{g.scope ?? "—"}</span>,
    },
    {
      key: "granted",
      header: "Granted",
      render: (g) => (
        <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
          {formatDate(g.grantedAt)}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      render: (g) =>
        g.expiresAt ? (
          <span style={{ color: c.muted, whiteSpace: "nowrap" }}>
            {formatDate(g.expiresAt)}
          </span>
        ) : (
          <span style={{ color: c.warn }}>never</span>
        ),
    },
    {
      key: "actions",
      header: "",
      render: (g) => (
        <div style={{ minWidth: 180 }}>
          <Destructive<ConsentGrant>
            label="Revoke"
            disabledReason={revokeDenied}
            preview={async () => g}
            renderPreview={(p) => (
              <>
                <strong>Revoking this consent takes effect immediately.</strong>
                <span>
                  {p.subject.agent} loses its <strong>{p.effect}</strong> decision for this
                  conversation. The next thing it tries will be gated again, and somebody will be
                  asked.
                </span>
              </>
            )}
            commit={async () => {
              await consentRevoke(managerSender, { ...parties, subject: g.subject });
            }}
            onDone={grants.reload}
          />
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextHeading ? `Approvers for ${contextHeading}` : "Approvers"}
        description="Who your agent asks when a task needs a human. Your wallet renders that
          request as a consent prompt — so a binding that points nowhere is silent, not noisy."
      >
        {approvers.error && <LoadError what="approver bindings" error={approvers.error} />}
        {approvers.loading && !approvers.data && <Loading what="approver bindings" />}
        {approvers.data && (
          <>
            <Table
              columns={approverColumns}
              rows={approvers.data}
              rowKey={(a) => `${a.platform}:${a.context}:${a.approver}`}
              empty={
                contextId
                  ? `No approver is bound for ${contextId}. Tasks in this context that need a ` +
                    "human have nobody to ask."
                  : "No approvers bound. Tasks that need a human have nobody to ask."
              }
            />
            {approvers.data.length === 0 && (
              <Note tone="warn">
                With no approver bound, a task your agent's policy gates on human consent cannot
                be approved by anyone — it will be refused rather than queued.
              </Note>
            )}
          </>
        )}
      </Panel>

      <SetApprover
        parties={parties}
        contextId={contextId}
        authority={authority}
        onSet={approvers.reload}
      />

      <Panel
        title="Consent grants"
        description="What has already been agreed to, and until when. Unlike the approver list
          above this is history, not configuration."
      >
        {grants.error && <LoadError what="consent grants" error={grants.error} />}
        {grants.loading && !grants.data && <Loading what="consent grants" />}
        {grants.data && (
          <Table
            columns={grantColumns}
            rows={grants.data.grants}
            rowKey={(g) => `${g.subject.platform}:${g.subject.conversationRef}:${g.subject.agent}`}
            empty="Nothing has been consented to yet. Decisions your approvers make appear here."
          />
        )}
      </Panel>
    </div>
  );
}
