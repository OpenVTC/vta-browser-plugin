// Open rooms the member is in — beside the rooms the agent holds keys for.
//
// An open room has no group, so `rooms/keys/list` never names it: the member
// reads and writes it with the credentials the community's offer gave, and only
// the community's record says they are in it (`openRooms` in `room-groups.ts`).
// So these are drawn apart from the key-custody cards, said to be open, and
// their detail is only the records: no epochs, no history to fetch, no group to
// switch places in.

import type { AgentName } from "../../agent-name.js";
import { didHost } from "../../did-display.js";
import { Button, Note, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { memberLabel, shortDid } from "../room-words.js";
import type { OpenRoom } from "../room-groups.js";
import type { Parties } from "../use-vta.js";
import { RoomTile } from "./rooms-detail.js";
import { RoomRecords } from "./rooms-records.js";

/** One open room, as a card that opens its records. */
export function OpenRoomCard({
  room,
  agentDid,
  names,
  onOpen,
}: {
  room: OpenRoom;
  agentDid: string;
  names: Readonly<Record<string, AgentName>>;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-label={`Open ${room.label ?? "this room"}`}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 9,
        background: c.surface,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-md)",
        padding: "14px 16px",
        minWidth: 0,
      }}
    >
      <span style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
        <RoomTile name={room.label} />
        <span style={{ fontSize: t.base, fontWeight: 650, color: c.text, wordBreak: "break-word" }}>
          {room.label ?? "Unnamed room"}
        </span>
      </span>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span title="An open room has no keys: your agent reads it with the credentials the community gave you">
          <Pill tone="off">open · no keys</Pill>
        </span>
        {room.actions.map((a) => (
          <Pill key={a} tone="accent">
            {a}
          </Pill>
        ))}
      </span>
      <span style={{ fontSize: t.sm, color: c.muted }}>as {memberLabel(room, agentDid, names)}</span>
      <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all", marginTop: "auto" }}>
        {room.roomId}
      </code>
    </button>
  );
}

/** One open room's records, read and written as the member the community admitted. */
export function OpenRoomDetail({
  parties,
  room,
  names,
  onBack,
}: {
  parties: Parties;
  room: OpenRoom;
  names: Readonly<Record<string, AgentName>>;
  onBack: () => void;
}) {
  const agentDid = parties.service.did;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Button kind="quiet" onClick={onBack} style={{ justifySelf: "start", paddingLeft: 0 }}>
        ← All rooms
      </Button>
      <section
        style={{
          background: c.surface,
          border: `1px solid ${c.line}`,
          borderRadius: "var(--w-r-lg)",
          padding: "18px 20px",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
          <RoomTile name={room.label} size={48} />
          <div style={{ flex: "1 1 300px", display: "grid", gap: 4, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: t.lg, fontWeight: 700, wordBreak: "break-word" }}>
              {room.label ?? "Unnamed room"}
            </h2>
            <span style={{ fontSize: t.sm, color: c.muted }}>
              {room.label ? "the community's name for it · " : ""}
              hosted by{" "}
              <strong style={{ color: c.text, fontWeight: 600 }} title={room.communityDid}>
                {didHost(room.communityDid) ?? shortDid(room.communityDid)}
              </strong>
            </span>
            <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all" }}>{room.roomId}</code>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${c.lineSoft}` }}>
          <span style={{ fontSize: t.sm, color: c.muted }}>Acting as</span>
          <span style={{ fontSize: t.sm, fontWeight: 600 }}>{memberLabel(room, agentDid, names)}</span>
          <Pill tone="off">open · no keys</Pill>
        </div>
      </section>
      <Note tone="accent">
        This room is open: there are no keys to hold, so it is not among the rooms your agent holds keys for. Your
        agent reads and writes it with the credentials the community gave you, and what is in it — notes you add
        included — is readable by its host. A file you add is stored encrypted, under a key its record carries in
        the clear: the host and the room&rsquo;s members can open it, whoever holds only the storage cannot.
      </Note>
      <RoomRecords key={`${room.roomId}|${room.member}`} parties={parties} room={room} host={room.communityDid} />
    </div>
  );
}
