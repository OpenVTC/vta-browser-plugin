// The records in a room — browsed and read through this wallet's own agent.
//
// ## Why the agent and not the host
//
// `rooms/records/*` is served by the room's host, and this console cannot
// address one: its bridge carries a task type and a payload and addresses
// everything to the wallet's own VTA. That narrowing is deliberate — the
// offscreen document mints and signs rather than counter-signing a document
// composed in a page — so `rooms/keys/{browse,read}` ask the agent to make the
// call, being the party that has a channel to the host, holds the credentials,
// and is the only one that can open what comes back.
//
// ## The verdict is the point, and it is copy before it is code
//
// Every answer carries what the agent checked. The rule those checks feed — a
// client that catches a host **serves reads and refuses writes** — is one nobody
// would guess, so it has to be said in words at the moment it applies. A member
// shown a warning icon dismisses it; a member later refused a write with no
// explanation concludes their own agent is broken. A detection attributed to the
// wrong party is worse than no detection.
//
// So `Verdict` below says *what was observed*, never how alarmed to be, and
// always says that reading still works and writing will not.

import { useCallback, useState } from "react";
import {
  roomsKeysBrowse,
  roomsKeysRead,
  type HeldRoom,
} from "@openvtc/pnm-core/rooms";
import { Button, Note } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import type { Parties } from "../use-vta.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

/** The shape both tasks return under `verification`, as this pane reads it. */
interface Verification {
  trace?: string;
  priorRoots: string;
  count?: string;
  head?: { dataCommitment: string; recordCount: number; headVersion: number };
}

interface RecordRow {
  key: string;
  version: number;
  status?: string;
  updatedAt?: string;
  epoch?: number;
  author?: string;
}

/**
 * One finding, in words that name what was observed.
 *
 * The order matters: a caught host is reported before anything reassuring, and
 * `trace: "verified"` is never allowed to stand alone as though it settled the
 * question. It does not — a host serving a private view of a room builds a
 * consistent tree over that view and traces every record in it perfectly.
 */
function Verdict({
  verification,
  complete,
  returned,
}: {
  verification: Verification;
  complete?: boolean | undefined;
  returned?: number | undefined;
}) {
  const { trace, priorRoots, count, head } = verification;

  // ── Caught ────────────────────────────────────────────────────────────────
  if (priorRoots === "conflict") {
    return (
      <Note tone="danger">
        <strong>This host has given your agent two different answers about this room.</strong>{" "}
        Two record sets, both claimed as this room at version {head?.headVersion ?? "?"}. One
        of them is wrong, and a write would explain neither — a write moves the version.
        <br />
        <br />
        Reading still works, and is how you gather what you need. Writing to this host will
        be refused.
      </Note>
    );
  }
  if (count === "short") {
    return (
      <Note tone="danger">
        <strong>This host served fewer records than it committed to.</strong> It sent{" "}
        {returned ?? "some"} and committed to a set of {head?.recordCount ?? "?"}, with no
        filter to explain the difference. That is a contradiction inside a single answer.
        <br />
        <br />
        Reading still works. Writing to this host will be refused.
      </Note>
    );
  }
  if (trace === "failed") {
    return (
      <Note tone="danger">
        <strong>The path this host gave for this record does not reach the root it
        asserted</strong> in the same answer. Either its bookkeeping is broken or the path
        was made up, and from here those look the same.
        <br />
        <br />
        The record is above, unopened by anything this says. Writing to this host will be
        refused.
      </Note>
    );
  }

  // ── Nothing claimed ───────────────────────────────────────────────────────
  if (!head) {
    return (
      <Note tone="warn">
        This host keeps no record tree, so it makes no claim about what this room holds and
        nothing here can be checked. That is allowed — and it is worth knowing, because a
        record it simply left out would look exactly like a room that never held one.
      </Note>
    );
  }

  // ── Checked, and honest about what that is worth ──────────────────────────
  const agrees = priorRoots === "agree";
  return (
    <Note tone="accent">
      {trace === "verified" && (
        <>This record is inside the set this host committed to. </>
      )}
      {count === "agrees" && <>Its listing holds exactly the {head.recordCount} records it
        committed to. </>}
      {agrees ? (
        <>
          That commitment matches what this host told your agent before at version{" "}
          {head.headVersion}.
        </>
      ) : (
        <>
          Whether that commitment is the room&rsquo;s is a different question. Your agent has
          nothing to compare it against yet — a first reading is not a comparison
          {priorRoots === "notChecked" && ", and this agent is not keeping the history that " +
            "would make one possible"}
          .
        </>
      )}
      {complete === false && (
        <>
          {" "}
          The listing stopped before the end, so its length says nothing.
        </>
      )}
    </Note>
  );
}

/** base64url → text, for a body this agent just opened. */
function decodeBody(plaintext: string): string {
  const padded = plaintext.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // Not text. Saying so is better than printing mojibake and letting a member
    // conclude the record is corrupt.
    return "(this record's body is not text)";
  }
}

function OpenedRecord({
  parties,
  room,
  host,
  recordKey,
}: {
  parties: Parties;
  room: HeldRoom;
  host: string;
  recordKey: string;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await roomsKeysRead(managerSender, {
        ...parties,
        roomId: room.roomId,
        host,
        key: recordKey,
      });
      setVerification(res.verification as unknown as Verification);
      if (res.plaintext) setBody(decodeBody(res.plaintext));
      else if (res.cleartext) setBody(JSON.stringify(res.cleartext, null, 2));
      // A retracted record has no body, and that is an answer rather than a
      // failure — the tombstone is what the room retains of it.
      else setBody(res.status === "retracted" ? "(retracted — the body is gone)" : "(no body)");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }, [parties, room, host, recordKey]);

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {body === null && !error && (
        <div>
          <Button disabled={busy} onClick={() => void open()}>
            {busy ? "Opening…" : "Open this record"}
          </Button>
          <p style={{ margin: "6px 0 0", fontSize: t.xs, color: c.faint }}>
            Your agent fetches it, checks what the host said about it, and decrypts it. The
            key does not leave the agent and the ciphertext does not reach this console.
          </p>
        </div>
      )}
      {body !== null && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            background: c.ground,
            border: `1px solid ${c.line}`,
            borderRadius: "var(--w-r-sm)",
            fontFamily: font.mono,
            fontSize: t.xs,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {body}
        </pre>
      )}
      {verification && <Verdict verification={verification} />}
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

/**
 * Browse a room's records at a host, and open the ones that matter.
 *
 * The host is asked for rather than remembered, for the same reason
 * `FetchHistory` asks: nothing maps a room to its host, a room is portable, and
 * a room may have more than one — a mirror serving reads while its primary takes
 * writes.
 */
export function RoomRecords({ parties, room }: { parties: Parties; room: HeldRoom }) {
  const [hostDid, setHostDid] = useState("");
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [complete, setComplete] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = useCallback(async () => {
    const host = hostDid.trim();
    if (!host) return;
    setBusy(true);
    setError(null);
    setRows(null);
    try {
      const res = await roomsKeysBrowse(managerSender, {
        ...parties,
        roomId: room.roomId,
        host,
      });
      setRows((res.records ?? []) as unknown as RecordRow[]);
      setVerification(res.verification as unknown as Verification);
      setComplete(res.complete);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }, [parties, room, hostDid]);

  const columns: Column<RecordRow>[] = [
    {
      key: "key",
      header: "Key",
      render: (r) => (
        <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
          {r.key}
        </code>
      ),
    },
    {
      key: "version",
      header: "Version",
      width: "6rem",
      render: (r) => <span style={{ fontFamily: font.mono }}>{r.version}</span>,
    },
    {
      key: "status",
      header: "Standing",
      width: "8rem",
      render: (r) => (
        <span style={{ color: r.status === "retracted" ? c.warn : c.muted }}>
          {r.status ?? "active"}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 22rem" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            HOST DID <span style={{ color: c.faint }}>— who serves this room</span>
          </span>
          <input
            style={fieldStyle}
            value={hostDid}
            onChange={(e) => setHostDid(e.target.value)}
          />
        </label>
        <Button disabled={busy || !hostDid.trim()} onClick={() => void browse()}>
          {busy ? "Listing…" : "List the records"}
        </Button>
      </div>

      {error && <LoadError what="this room's records" error={error} />}
      {busy && rows === null && !error && <Loading what="records" />}

      {rows !== null && (
        <>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(r) => r.key}
            expanded={(r) => (
              <OpenedRecord
                parties={parties}
                room={room}
                host={hostDid.trim()}
                recordKey={r.key}
              />
            )}
            empty="This host served no records for this room — which is also what a host
              withholding all of them looks like, unless it committed to a count."
          />
          {verification && (
            <Verdict
              verification={verification}
              complete={complete}
              returned={rows.length}
            />
          )}
        </>
      )}
    </div>
  );
}
