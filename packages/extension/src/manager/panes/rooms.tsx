// Data rooms — shared spaces this agent holds keys for.
//
// A room is a set of records governed by credentials the *room itself* issued,
// not by anything its host stores. Two consequences shape this pane and neither
// is obvious from the screen:
//
// **This list is key custody, not membership.** It answers "what can this VTA
// open", which is a different set from "what is its principal a member of". A
// room whose Welcome never arrived is absent even where a perfectly good
// membership credential is held; a VTA not yet told of a removal still lists a
// room it can read and can no longer write to. So the pane never presents this
// as authority — the host decides that, from credentials the room issued, and
// the honest failure is a refusal at the point of use.
//
// **Two epochs per room, because neither alone is enough.** `epoch` behind the
// room's own means a commit was not delivered and records written since will
// not open. `earliest` equal to `epoch` means the epoch key chain has not
// arrived, so history before joining is unreadable. Different repairs, and a
// member shown only "you can't read this" reads it as loss rather than as a
// delivery that has not happened. The pane says which it is.
//
// Reading a sealed record is two hops on purpose: the host serves ciphertext it
// cannot read, and the member's own VTA opens it. Nothing here ever holds a key.
//
// **One row per (room, member).** One agent can hold two members of a room — an
// administrator whose agent also holds the community's own place in a room the
// community owns, or a person with two personas in it. The agent lists the room
// once per member, and every row says which member it is and what place it
// holds; everything done from a row acts as that member and names it, because
// the agent refuses to choose between them.

import { useCallback, useEffect, useState } from "react";
import { heldRoomKey, roomsKeysList, type HeldRoom } from "@openvtc/pnm-core/rooms";
import { displayAgentName, type AgentName } from "../../agent-name.js";
import { useAgentNames } from "../../use-agent-names.js";
import { Note, Panel } from "../../ui.js";
import { CreateRoom } from "./rooms-create.js";
import { FetchHistory } from "./rooms-backfill.js";
import { RoomRecords } from "./rooms-records.js";
import { IssueInRoomsName } from "./rooms-owner.js";
import { RoomShares } from "./rooms-shares.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import type { ContextRecord } from "@openvtc/pnm-core";
import type { Parties } from "../use-vta.js";

/** What the two epochs mean together, in the words a member needs. */
function standing(room: HeldRoom): { label: string; tone: string; why: string } {
  if (room.earliestReadableEpoch <= 1) {
    return {
      label: "whole history",
      tone: c.ok,
      why: "Every record this room retains can be opened.",
    };
  }
  if (room.earliestReadableEpoch >= room.epoch) {
    return {
      label: "from joining",
      tone: c.warn,
      why:
        "Readable from the epoch this agent joined at. Anything written before that needs " +
        "the room's epoch key chain, which has not been delivered here.",
    };
  }
  return {
    label: `back to epoch ${room.earliestReadableEpoch}`,
    tone: c.warn,
    why:
      "Part of the chain has arrived. Records older than this epoch were either severed " +
      "deliberately or their rungs were never delivered — from here the two look the same.",
  };
}

/** Who a row acts as, in words: a name its document claims, else the DID shortened. */
export function memberLabel(
  room: Pick<HeldRoom, "member">,
  agentDid: string,
  names: Readonly<Record<string, AgentName>>,
): string {
  if (!room.member) return "member not reported by this agent";
  const name = names[room.member];
  const who = name
    ? displayAgentName(name)
    : room.member.length > 44
      ? `${room.member.slice(0, 22)}…${room.member.slice(-14)}`
      : room.member;
  return room.member === agentDid ? `${who} (this agent's own DID)` : who;
}

/** The place a member holds in the room, from the actions its grant confers. */
export function placeLabel(room: Pick<HeldRoom, "actions">): string {
  if (!room.actions) return "";
  return room.actions.includes("admin") ? "administers the room" : "member";
}

export function RoomsPane({
  parties,
  contexts,
}: {
  parties: Parties;
  contexts: ContextRecord[];
}) {
  const [rooms, setRooms] = useState<HeldRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRooms(await roomsKeysList(managerSender, { ...parties }));
    } catch (e) {
      setRooms(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [parties]);

  useEffect(() => {
    void load();
  }, [load]);

  const names = useAgentNames((rooms ?? []).map((r) => r.member));
  // A room held as more than one member: the rows must say which is which.
  const twice = new Set(
    (rooms ?? []).filter((r, i, all) => all.findIndex((o) => o.roomId === r.roomId) !== i).map((r) => r.roomId),
  );

  const columns: Column<HeldRoom>[] = [
    {
      key: "room",
      header: "Room",
      render: (r) => (
        <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all" }}>
          {r.roomId}
        </code>
      ),
    },
    {
      key: "member",
      header: "As",
      render: (r) => (
        <span style={{ display: "grid", gap: 2 }} title={r.member}>
          <span style={{ fontSize: t.xs, wordBreak: "break-all" }}>{memberLabel(r, parties.service.did, names)}</span>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            {[placeLabel(r), r.context ? `context ${r.context}` : "", twice.has(r.roomId) ? "one of two places" : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "epoch",
      header: "Epoch",
      width: "5rem",
      render: (r) => <span style={{ fontFamily: font.mono }}>{r.epoch}</span>,
    },
    {
      key: "readable",
      header: "Readable",
      width: "12rem",
      render: (r) => {
        const s = standing(r);
        return <span style={{ color: s.tone }}>{s.label}</span>;
      },
    },
  ];

  const list = (
    <Panel
      title="Data rooms"
      description="Shared spaces this agent holds keys for. Listed by what it can open — which is
        not the same as what its principal is a member of."
    >
      {error ? (
        <LoadError what="its rooms" error={error} />
      ) : rooms === null ? (
        <Loading what="rooms" />
      ) : (
        <>
          <Table
            columns={columns}
            rows={rooms}
            rowKey={heldRoomKey}
            expanded={(r) => {
              const s = standing(r);
              return (
                <div style={{ fontSize: t.sm, color: c.muted }}>
                  {r.member && (
                    <p style={{ margin: "0 0 6px" }}>
                      Everything below acts in this room as <code style={{ wordBreak: "break-all" }}>{r.member}</code>
                      {twice.has(r.roomId) ? ", not as the other place this agent holds in it" : ""}.
                    </p>
                  )}
                  <p style={{ margin: "0 0 6px" }}>{s.why}</p>
                  <p style={{ margin: 0 }}>
                    Holding keys is not permission to act. Whether this agent may still write
                    here is decided by the host, from credentials the room issued — so a room
                    it can read may still refuse a write.
                  </p>
                  {/* Offered only where there is something to repair. A room
                      that already reads to its first epoch has no chain left to
                      fetch, and a button that did nothing would teach an
                      operator to distrust the one that does. */}
                  {r.earliestReadableEpoch > 1 && (
                    <FetchHistory parties={parties} room={r} onFetched={() => void load()} />
                  )}
                  {/* Reading is offered on every room, including one whose
                      history is incomplete: what a member can open now is not
                      contingent on what they cannot. */}
                  <RoomRecords parties={parties} room={r} />
                </div>
              );
            }}
            empty="No rooms. This agent has been given keys to none — which is also what it
              looks like before an invitation has been accepted."
          />
          <Note>
            Membership credentials are not shown here and cannot be: this is what the agent
            can decrypt, taken from its own key custody. A room the principal belongs to
            whose Welcome never arrived does not appear.
          </Note>
        </>
      )}
    </Panel>
  );

  return (
    <>
      {list}
      <CreateRoom parties={parties} contexts={contexts} onCreated={() => void load()} />
      {/* Below the list rather than beside it: issuing is about a room the owner
          already has, and the list is key custody — a room can appear in one and
          not the other in both directions, so pairing them per-row would suggest
          a correspondence that does not hold. */}
      <IssueInRoomsName parties={parties} />
      <RoomShares />
    </>
  );
}
