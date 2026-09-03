// Sessions — **yours**, and only yours.
//
// `sessionsList` returns the caller's own sessions and nothing else. The agent
// has a separate admin route that lists everyone's, and this task deliberately
// does not use it. So the heading says "your sessions": a console that put this
// answer under "all sessions" would be lying about its own scope, and an
// operator would read an empty list as "nobody else is signed in".

import {
  sessionRevoke,
  sessionsList,
  type Session,
} from "@openvtc/pnm-core/admin";
import { Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Destructive } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { formatInstant } from "../format.js";
import type { Authority, Parties } from "../use-vta.js";

function When({ iso }: { iso: string }) {
  return (
    <span style={{ color: c.muted, whiteSpace: "nowrap" }}>{formatInstant(iso)}</span>
  );
}

export function SessionsPane({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const list = useAsync(
    () => sessionsList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );

  const current = authority?.session.id;

  const columns: Column<Session>[] = [
    {
      key: "id",
      header: "Session",
      render: (s) => (
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
            {s.id}
          </span>
          {s.id === current && <Pill tone="accent">this console</Pill>}
        </div>
      ),
    },
    {
      key: "amr",
      header: "Signed in with",
      render: (s) => (
        <span style={{ color: c.muted }}>{s.amr?.length ? s.amr.join(" + ") : "—"}</span>
      ),
    },
    {
      key: "acr",
      header: "Assurance",
      render: (s) => <span style={{ color: c.muted }}>{s.acr ?? "—"}</span>,
    },
    { key: "issued", header: "Started", render: (s) => <When iso={s.issuedAt} /> },
    { key: "expires", header: "Expires", render: (s) => <When iso={s.expiresAt} /> },
    {
      key: "actions",
      header: "",
      render: (s) => (
        <div style={{ minWidth: 180 }}>
          <Destructive<Session>
            label="Revoke"
            preview={async () => s}
            renderPreview={(p) => (
              <>
                <strong>
                  {p.id === current
                    ? "This is the session this console is using."
                    : "Revoking this session signs it out immediately."}
                </strong>
                <span>
                  {p.id === current
                    ? "Revoking it signs you out here. You will need to authenticate again " +
                      "before this console can do anything else."
                    : "Whatever is using it stops being able to act at this agent until it " +
                      "authenticates again."}
                </span>
              </>
            )}
            commit={async () => {
              await sessionRevoke(managerSender, { ...parties, sessionId: s.id });
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
        title="Your sessions"
        description="Every session authenticated as you at this agent. Your agent also knows
          about other people's; this list is deliberately not that one, so an empty result here
          says nothing about anybody else."
      >
        {list.error && <LoadError what="your sessions" error={list.error} />}
        {list.loading && !list.data && <Loading what="your sessions" />}
        {list.data && (
          <Table
            columns={columns}
            rows={list.data}
            rowKey={(s) => s.id}
            empty="Your agent reports no sessions for you — including, apparently, the one this
              console is using, which is worth a second look."
          />
        )}
        {list.data && list.data.length > 1 && (
          <Note tone="warn">
            More than one session is signed in as you. That is normal if you use several devices,
            and worth a look if you do not.
          </Note>
        )}
      </Panel>
    </div>
  );
}
