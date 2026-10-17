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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  roomsKeysBrowse,
  roomsKeysRead,
  type HeldRoom,
} from "@openvtc/pnm-core/rooms";
import { Button, Note } from "../../ui.js";
import { didHost } from "../../did-display.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import type { Parties } from "../use-vta.js";
import type { RoomFilesPrepared } from "../../bridge-protocol.js";
import { prepareRoomFiles, roomFileClaimOf } from "../room-files.js";
import { GetRoomFile, PutRoomFile, RoomFilesUnavailable } from "./rooms-files.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

const bodyStyle: React.CSSProperties = {
  margin: "6px 0 0",
  padding: 10,
  background: c.ground,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontFamily: font.mono,
  fontSize: t.xs,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
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
  prepared,
}: {
  parties: Parties;
  room: HeldRoom;
  host: string;
  recordKey: string;
  prepared: RoomFilesPrepared | null;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const claim = body === null ? null : roomFileClaimOf(body);

  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await roomsKeysRead(managerSender, {
        ...parties,
        roomId: room.roomId,
        host,
        key: recordKey,
        ...(room.member !== undefined ? { member: room.member } : {}),
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
      {/* A record that carries a file is offered as one. The body is still
          there to look at, folded: it is JSON, and the proof is most of it. */}
      {claim && (
        <GetRoomFile room={room} host={host} prepared={prepared} recordKey={recordKey} claim={claim} />
      )}
      {body !== null && claim && (
        <details>
          <summary style={{ fontSize: t.xs, color: c.muted, cursor: "pointer" }}>The record</summary>
          <pre style={bodyStyle}>{body}</pre>
        </details>
      )}
      {body !== null && !claim && (
        <pre style={{ ...bodyStyle, margin: 0 }}>{body}</pre>
      )}
      {verification && <Verdict verification={verification} />}
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

/**
 * Browse a room's records at a host, and open the ones that matter.
 *
 * Nothing authoritative maps a room to its host — a room is portable, and may
 * have more than one, a mirror serving reads while its primary takes writes —
 * so `host` is only where this wallet last found it (`room-hosts.ts`). Given
 * one, the listing starts there and offers *Change*; without one, it asks.
 * `onListed` hears each host that answered, so the pane can remember it.
 */
export function RoomRecords({
  parties,
  room,
  host: knownHost,
  onListed,
}: {
  parties: Parties;
  room: HeldRoom;
  host?: string | undefined;
  onListed?: ((host: string) => void) | undefined;
}) {
  const [hostDid, setHostDid] = useState(knownHost ?? "");
  const [askHost, setAskHost] = useState(!knownHost);
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [complete, setComplete] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The host is learnt here, at listing, so that a click on put or get can ask
  // for its origin as its first act (`rooms-files.tsx`).
  const [listedHost, setListedHost] = useState("");
  const [prepared, setPrepared] = useState<RoomFilesPrepared | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  const started = useRef(false);
  const browse = useCallback(async (asked: string) => {
    const host = asked.trim();
    if (!host) return;
    started.current = true;
    setBusy(true);
    setError(null);
    setRows(null);
    setListedHost(host);
    setPrepared(null);
    setFilesError(null);
    void prepareRoomFiles(host).then(setPrepared, (e: unknown) =>
      setFilesError(e instanceof Error ? e.message : String(e)),
    );
    try {
      const res = await roomsKeysBrowse(managerSender, {
        ...parties,
        roomId: room.roomId,
        host,
        ...(room.member !== undefined ? { member: room.member } : {}),
      });
      setRows((res.records ?? []) as unknown as RecordRow[]);
      setVerification(res.verification as unknown as Verification);
      setComplete(res.complete);
      setAskHost(false);
      onListed?.(host);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A host that did not answer is one to correct, so the field comes back.
      setAskHost(true);
    }
    setBusy(false);
  }, [parties, room, onListed]);

  // Where the room was last found: list it straight away, once — and not again
  // when the host this listing just found comes back down as the known one.
  useEffect(() => {
    if (started.current || !knownHost) return;
    started.current = true;
    void browse(knownHost);
  }, [knownHost, browse]);

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
      {askHost ? (
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
          <Button disabled={busy || !hostDid.trim()} onClick={() => void browse(hostDid)}>
            {busy ? "Listing…" : "List the records"}
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: t.sm, color: c.muted }}>
          <span>Served by</span>
          <strong style={{ color: c.text, fontWeight: 600 }} title={listedHost || hostDid}>
            {didHost(listedHost || hostDid) ?? listedHost ?? hostDid}
          </strong>
          <Button kind="quiet" onClick={() => setAskHost(true)}>
            Change
          </Button>
          <Button kind="quiet" disabled={busy} onClick={() => void browse(listedHost || hostDid)}>
            {busy ? "Listing…" : "Refresh"}
          </Button>
        </div>
      )}

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
                host={listedHost}
                recordKey={r.key}
                prepared={prepared}
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
          {filesError && <RoomFilesUnavailable error={filesError} />}
          {prepared && (
            <PutRoomFile room={room} host={listedHost} prepared={prepared} onPut={() => void browse(listedHost)} />
          )}
        </>
      )}
    </div>
  );
}
