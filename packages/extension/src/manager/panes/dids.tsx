// DIDs — every identifier a context holds, of every method, in one table.
//
// One listing (`vta/dids/list`), because "which DIDs does this agent hold" has
// one answer whatever the method. The pane used to ask `vta/webvh/dids/list`
// alone, and an agent whose identities were all did:webs drew "No DIDs you can
// reach" over every one of them. The Method column says what each is; opening a
// row shows what that method has — a did:webvh's log and its webvh actions, a
// did:webs's key event log facts, a did:key's key — because what an identity
// *does* differs by method even where what it *is* does not.
//
// Scoped to the selected context like Keys, and for the same reason: the
// listing takes a `contextId`, so a changed selection asks the agent a
// different question rather than filtering an answer it already gave.
//
// A published DID is resolvable by anyone. That is why deletion is treated as
// the sharpest action in this console — see the confirm copy.
//
// A did:webvh row opens into `did-detail.tsx`, which fetches the log. It is
// fetched on open rather than with the listing because `includeLog` is opt-in
// at the agent for a reason: the log is the DID's whole history and can be
// large, and a listing that pulled every one would be the whole history of
// every identifier to draw a table.

import { useState } from "react";
import { didsList, type DidSummary } from "@openvtc/pnm-core";
import {
  webvhDidDelete,
  webvhDidRealignKeys,
  type WebvhDidRecord,
} from "@openvtc/pnm-core/webvh";
import { Button, Did, Panel, Pill } from "../../ui.js";
import { DidQrButton } from "../../did-qr-view.js";
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

/** The webvh family's record for a did:webvh or did:scid:vh identity, from its
 *  summary — the handle those tasks take is the log's did:webvh, which a
 *  did:scid identity carries in `alsoKnownAs`. `null` for any other method. */
export function webvhRecordOf(d: DidSummary): WebvhDidRecord | null {
  if (d.method !== "webvh" && d.method !== "scid:vh") return null;
  const details = (d.methodDetails?.[d.method] ?? {}) as Record<string, unknown>;
  const webvh =
    d.method === "webvh" ? d.did : (d.alsoKnownAs.find((a) => a.startsWith("did:webvh:")) ?? d.did);
  return {
    did: webvh,
    serverId: d.serverId ?? "serverless",
    mnemonic: typeof details.mnemonic === "string" ? details.mnemonic : "",
    scid: typeof details.scid === "string" ? details.scid : "",
    contextId: d.contextId ?? "",
    portable: details.portable === true,
    logEntryCount: typeof details.logEntryCount === "number" ? details.logEntryCount : 0,
    preRotationCount: typeof details.preRotationCount === "number" ? details.preRotationCount : 0,
    nextFragmentId: 0,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  } as WebvhDidRecord;
}

/** What a did:webs or did:key row opens into: the summary, read-only. Their
 *  writes are their own families' tasks, which this console does not drive. */
function SummaryDetail({ d }: { d: DidSummary }) {
  const details = (d.methodDetails?.[d.method] ?? {}) as Record<string, unknown>;
  const rows: Array<[string, string]> = [
    ["Method", d.method],
    ...(d.class ? ([["Class", d.class]] as Array<[string, string]>) : []),
    ["Context DID", d.primary ? "yes" : "no"],
    ...(d.signingKeyId ? ([["Signing key", d.signingKeyId]] as Array<[string, string]>) : []),
    ...(d.keyAgreementKeyId
      ? ([["Key agreement", d.keyAgreementKeyId]] as Array<[string, string]>)
      : []),
    ...d.alsoKnownAs.map((a) => ["Also known as", a] as [string, string]),
    ...Object.entries(details).map(([k, v]) => [k, String(v)] as [string, string]),
  ];
  return (
    <div style={{ display: "grid", gap: 4, fontSize: t.sm }}>
      {d.deactivated && (
        <span style={{ color: c.muted }}>
          Ended: it still resolves, as deactivated, and signs nothing.
        </span>
      )}
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} style={{ display: "flex", gap: 12, minWidth: 0 }}>
          <span style={{ color: c.muted, minWidth: 120 }}>{k}</span>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>{v}</span>
        </div>
      ))}
    </div>
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
      didsList(managerSender, {
        ...parties,
        includeDeactivated: true,
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
  const updateDenied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Publishing an entry to a DID's log needs the admin role at this agent."
    : null;

  const columns: Column<DidSummary>[] = [
    // A floor on the identifier column. A DID has no natural break points, so
    // when something else in the row demands width — a long refusal from the
    // agent, say — the browser squeezes this one and the DID wraps every few
    // characters, which is unreadable exactly when you most need to tell two of
    // them apart.
    {
      key: "did",
      header: "DID",
      width: "26ch",
      // The identifier is the control. An operator wanting to look inside a DID
      // clicks the DID — a separate "View" button beside it would be a second
      // thing to find for the gesture they already tried.
      render: (d) => (
        // The QR button sits beside the opening button, not inside it: a
        // button inside a button is invalid, and would open the row too.
        <span style={{ display: "inline-flex", alignItems: "flex-start", minWidth: 0 }}>
        <button
          onClick={() => setOpened(opened === d.did ? null : d.did)}
          aria-expanded={opened === d.did}
          title={opened === d.did ? "Close" : "Open this DID"}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            textAlign: "left",
            cursor: "pointer",
            minWidth: 0,
          }}
        >
          <Did value={d.did} qr={false} />
        </button>
        <DidQrButton value={d.did} />
        </span>
      ),
    },
    {
      key: "method",
      header: "Method",
      render: (d) => (
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{d.method}</span>
          {d.primary && <Pill tone="accent">context DID</Pill>}
          {d.deactivated && <Pill tone="off">ended</Pill>}
        </span>
      ),
    },
    {
      key: "context",
      header: "Context",
      render: (d) => (
        <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{d.contextId ?? "—"}</span>
      ),
    },
    {
      key: "server",
      header: "Server",
      render: (d) => <span style={{ color: c.muted }}>{d.serverId ?? "—"}</span>,
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
      render: (d) => {
        const record = webvhRecordOf(d);
        // Only the webvh family's actions are driven from here; another
        // method's writes are its own tasks.
        if (!record) return null;
        return (
          <div style={{ display: "grid", gap: 8, minWidth: 190 }}>
            <RealignKeys parties={parties} did={record.did} disabledReason={denied} onDone={list.reload} />
            <Destructive<WebvhDidRecord>
              label="Delete"
              disabledReason={denied}
              preview={async () => record}
              forceLabel="Delete anyway"
              renderPreview={(p) => (
                <>
                  <strong>Deleting this DID cannot be undone.</strong>
                  <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
                    {d.did}
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
                await webvhDidDelete(managerSender, { ...parties, did: record.did });
              }}
              onDone={list.reload}
            />
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextHeading ? `DIDs in ${contextHeading}` : "DIDs in every context you can reach"}
        description="Every identifier your agent holds the keys to, whatever its method — did:webvh,
          did:scid, did:webs, did:key. Published ones are resolvable by anyone: these are the
          identities others see."
      >
        {list.error && <LoadError what="DIDs" error={list.error} />}
        {list.loading && !list.data && <Loading what="DIDs" />}
        {list.data && (
          <Table
            columns={columns}
            rows={list.data}
            rowKey={(d) => d.did}
            expanded={(d) => {
              if (opened !== d.did) return null;
              const record = webvhRecordOf(d);
              return record ? (
                <DidDetail
                  parties={parties}
                  record={record}
                  disabledReason={updateDenied}
                  onChanged={list.reload}
                />
              ) : (
                <SummaryDetail d={d} />
              );
            }}
            empty={
              contextId
                ? `No DIDs in ${contextId}. Identifiers created in this context appear here.`
                : "No DIDs you can reach. Identifiers you administer appear here."
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
