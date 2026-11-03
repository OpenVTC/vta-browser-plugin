// Notifications — what the member's agent holds that it was told exists.
//
// A notification is a community's (or any originator's) signed statement that a
// thing exists which the member, or a party they belong to, may take part in:
// where it is held, its identifier there, and whom it concerns. The agent holds
// each one it accepts in the context of the DID it was addressed to
// (VTI-NTF-050), and this pane lists them, reads one with the document that
// delivered it, and dismisses one — none of which tells anybody anything
// (VTI-NTF-053).
//
// **Nothing here opens a thing by itself.** An election is opened only when the
// member presses *Open the election*, and then read from its community as the
// DID the notification was addressed to; if the community shows it only to a
// party's members, the member is told what reading it shows before anything is
// presented (VTI-NTF-063, VTI-VOT-016). The console names only the held record;
// the background re-reads it from the agent (`RUNTIME_NOTIFIED_ELECTION`).
//
// A kind this wallet does not know is shown as existing and nothing more
// (VTI-NTF-012).

import { useCallback, useMemo, useState } from "react";
import {
  notificationsDismiss,
  notificationsListAll,
  notificationsShow,
  type HeldNotification,
} from "@openvtc/pnm-core/notifications";

import {
  RUNTIME_NOTIFIED_ELECTION,
  type NotifiedElectionOutcome,
  type RuntimeNotifiedElectionResponse,
} from "../../bridge-protocol.js";
import { requestOriginPermission } from "../../host-permissions.js";
import { sendToBackground } from "../../send-message.js";
import { c, font, t } from "../../theme.js";
import { Button, Note, Panel, Pill } from "../../ui.js";
import type { ContextSelection } from "../context-column.js";
import { formatInstant } from "../format.js";
import { MailDid } from "../mail-did.js";
import { UNKNOWN_KIND_NOTE, kindWords, lapsed, periodWords, presentWords } from "../notification-words.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { useAsync } from "../use-async.js";
import type { Parties } from "../use-vta.js";

interface Listed {
  items: HeldNotification[];
  /** Contexts the agent would not list, with why. */
  failed: { contextId: string; error: string }[];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: c.muted, whiteSpace: "nowrap" }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0, wordBreak: "break-word" }}>{children}</dd>
    </>
  );
}

function DidOrText({ value }: { value: string }) {
  return value.startsWith("did:") ? (
    <MailDid value={value} size={t.xs} />
  ) : (
    <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{value}</span>
  );
}

type Opened =
  | { state: "busy" }
  | { state: "done"; outcome: NotifiedElectionOutcome }
  | { state: "failed"; error: string };

async function openElection(item: HeldNotification, present: boolean): Promise<Opened> {
  const res = await sendToBackground<RuntimeNotifiedElectionResponse>({
    type: RUNTIME_NOTIFIED_ELECTION,
    params: { contextId: item.contextId, recordId: item.recordId, ...(present ? { present: true } : {}) },
  });
  return res.ok ? { state: "done", outcome: res.result } : { state: "failed", error: res.error };
}

/** An election read from its community, or what stands in the way. */
function ElectionOpened({
  opened,
  onRetry,
  onPresent,
}: {
  opened: Opened;
  onRetry: () => void;
  onPresent: () => void;
}) {
  if (opened.state === "busy") return <div style={{ fontSize: t.sm, color: c.faint }}>Reading the election from its community…</div>;
  if (opened.state === "failed") return <Note tone="danger">{opened.error}</Note>;
  const o = opened.outcome;
  if (o.kind === "needsReach") {
    return (
      <Note tone="accent">
        The wallet may not reach {new URL(o.origin).host} yet, so nothing was read.{" "}
        <Button
          onClick={() => {
            // The permission request must be the click's first await.
            void requestOriginPermission(o.origin).then((granted) => granted && onRetry());
          }}
        >
          Allow and read
        </Button>
      </Note>
    );
  }
  if (o.kind === "needsPresent") {
    return o.held ? (
      <Note tone="warn">
        <div style={{ display: "grid", gap: 8 }}>
          <span>{presentWords(o.community, o.audience)}</span>
          <div>
            <Button onClick={onPresent}>Show my membership and read it</Button>
          </div>
        </div>
      </Note>
    ) : (
      <Note tone="warn">
        The community shows this election only to members of {o.audience}, and you hold no membership credential issued by
        it, so you are not a member of that party here. Nothing was presented.
      </Note>
    );
  }
  const e = o.election;
  return (
    <div style={{ display: "grid", gap: 6, fontSize: t.sm }}>
      <strong>{e.title ?? e.electionId}</strong>
      {e.description && <span style={{ color: c.muted }}>{e.description}</span>}
      <span>
        {e.state} · voting {periodWords(e.votingOpensAt, e.votingClosesAt)} · {e.questions.length} question
        {e.questions.length === 1 ? "" : "s"} · {e.secrecy}
      </span>
      <span style={{ color: c.muted }}>
        Ballot box run by {e.disclosure.ballotBoxOperator}
        {e.disclosure.sameOperator ? " (the community itself)" : ""}.
        {o.presented ? " Read showing your membership credential." : ""}
      </span>
      <span style={{ color: c.faint }}>
        Tickets and ballots are taken from the community's member portal, where the wallet fills the ballot in its own
        window.
      </span>
    </div>
  );
}

function NotificationCard({
  parties,
  item,
  onDismissed,
}: {
  parties: Parties;
  item: HeldNotification;
  onDismissed: () => void;
}) {
  const n = item.notification;
  const kind = kindWords(n.kind);
  const gone = lapsed(n.status, n.validUntil, Date.now());
  const [doc, setDoc] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  const run = useCallback(async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const open = useCallback(
    (present: boolean) => {
      setOpened({ state: "busy" });
      void openElection(item, present)
        .then(setOpened)
        .catch((e: unknown) => setOpened({ state: "failed", error: e instanceof Error ? e.message : String(e) }));
    },
    [item],
  );

  return (
    <div
      style={{
        background: c.raised,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-sm)",
        padding: "12px 14px",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: t.md }}>{kind.label}</strong>
        {!kind.known && <Pill tone="off">unknown kind</Pill>}
        {n.status === "withdrawn" ? <Pill tone="warn">withdrawn</Pill> : gone ? <Pill tone="off">lapsed</Pill> : <Pill tone="ok">available</Pill>}
        {item.state === "dismissed" && <Pill tone="off">dismissed</Pill>}
        <span style={{ marginLeft: "auto", color: c.faint, fontSize: t.xs }}>received {formatInstant(item.receivedAt)}</span>
      </div>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr)",
          gap: "5px 16px",
          fontSize: t.sm,
          alignItems: "baseline",
        }}
      >
        <Field label="Said by">
          <DidOrText value={item.originator} />
        </Field>
        {item.relayedBy.length > 0 && (
          <Field label="Passed on by">
            <div style={{ display: "grid", gap: 2 }}>
              {item.relayedBy.map((d) => (
                <DidOrText key={d} value={d} />
              ))}
            </div>
          </Field>
        )}
        <Field label="Held by">
          <DidOrText value={n.subject.heldBy} />
        </Field>
        <Field label="Its identifier">
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{n.subject.id}</span>
        </Field>
        <Field label="It concerns">
          <DidOrText value={n.audience} />
        </Field>
        <Field label="Period">{periodWords(n.validFrom, n.validUntil)}</Field>
        <Field label="Addressed to">
          <DidOrText value={item.addressee} />
        </Field>
        <Field label="Context">
          <span style={{ fontFamily: font.mono, fontSize: t.xs }}>{item.contextId}</span>
        </Field>
      </dl>
      {!kind.known && <span style={{ fontSize: t.xs, color: c.muted }}>{UNKNOWN_KIND_NOTE}</span>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {kind.known && n.kind === "election" && n.status === "available" && !gone && (
          <Button kind="primary" onClick={() => open(false)} disabled={opened?.state === "busy"}>
            Open the election
          </Button>
        )}
        <Button
          kind="quiet"
          disabled={busy !== null}
          onClick={() =>
            doc !== null
              ? setDoc(null)
              : void run("show", async () => {
                  const shown = await notificationsShow(managerSender, parties, item.contextId, item.recordId);
                  setDoc(JSON.stringify(shown.document, null, 2));
                })
          }
        >
          {doc !== null ? "Hide the document" : "The document as received"}
        </Button>
        {item.state === "active" && (
          <Button
            kind="quiet"
            disabled={busy !== null}
            onClick={() =>
              void run("dismiss", async () => {
                await notificationsDismiss(managerSender, parties, item.contextId, item.recordId);
                onDismissed();
              })
            }
          >
            Dismiss
          </Button>
        )}
      </div>
      {opened && <ElectionOpened opened={opened} onRetry={() => open(false)} onPresent={() => open(true)} />}
      {error && <Note tone="danger">{error}</Note>}
      {doc !== null && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            background: c.ground,
            border: `1px solid ${c.lineSoft}`,
            borderRadius: "var(--w-r-sm)",
            fontSize: t.xs,
            fontFamily: font.mono,
            overflowX: "auto",
            maxHeight: 360,
          }}
        >
          {doc}
        </pre>
      )}
    </div>
  );
}

export function NotificationsPane({
  parties,
  contextId,
  contextHeading,
  contexts,
}: {
  parties: Parties;
  contextId: ContextSelection;
  contextHeading?: string | undefined;
  /** Every context the console lists, read when none is selected. */
  contexts: string[];
}) {
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [includeLapsed, setIncludeLapsed] = useState(false);
  const asked = useMemo(() => (contextId ? [contextId] : contexts), [contextId, contexts]);

  const list = useAsync<Listed>(async () => {
    const failed: Listed["failed"] = [];
    const pages = await Promise.all(
      asked.map((ctx) =>
        notificationsListAll(managerSender, parties, ctx, {
          ...(includeDismissed ? { includeDismissed: true } : {}),
          ...(includeLapsed ? { includeLapsed: true } : {}),
        }).catch((e: unknown) => {
          failed.push({ contextId: ctx, error: e instanceof Error ? e.message : String(e) });
          return [] as HeldNotification[];
        }),
      ),
    );
    const items = pages.flat().sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    return { items, failed };
  }, [parties.holder.did, parties.service.did, asked.join("\n"), includeDismissed, includeLapsed]);

  const items = list.data?.items ?? [];
  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={contextHeading ? `Notifications in ${contextHeading}` : "Notifications"}
        description="What your agent was told exists that you, or a party you belong to, may take part in — an
          election, for one. A notification says where the thing is and whom it concerns; it is not an invitation
          and says nothing about whether you may take part. Reading, listing and dismissing one tells nobody
          anything."
      >
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: t.sm }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeDismissed} onChange={(e) => setIncludeDismissed(e.target.checked)} />
            Include dismissed
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeLapsed} onChange={(e) => setIncludeLapsed(e.target.checked)} />
            Include withdrawn and lapsed
          </label>
        </div>
        {list.error && <LoadError what="your notifications" error={list.error} />}
        {list.loading && !list.data && <Loading what="your notifications" />}
        {list.data && list.data.failed.length > 0 && (
          <Note tone="warn">
            Your agent would not list the notifications in{" "}
            {list.data.failed.map((f) => `${f.contextId} (${f.error})`).join(", ")}. Anything held there is not shown.
          </Note>
        )}
        {list.data &&
          (items.length === 0 ? (
            <div style={{ fontSize: t.sm, color: c.faint, padding: "10px 0", lineHeight: 1.55 }}>
              {asked.length === 0 ? "Your agent lists no contexts to read." : "Your agent holds no notifications here."}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {items.map((item) => (
                <NotificationCard parties={parties} key={`${item.contextId}\n${item.recordId}`} item={item} onDismissed={list.reload} />
              ))}
            </div>
          ))}
      </Panel>
    </div>
  );
}
