// One room, opened from its card: who acts in it, and three things to look at.
//
// The pane used to render all of this under every row at once — the history
// explanation, the custody caveat, two separate host fields, the records and a
// four-field label editor — so two rooms filled two screens. Here it is one
// room at a time, in tabs:
//
// - **Records** lists straight away from where the room was last found
//   (`room-hosts.ts`), with *Change* for a room that moved. Files live here,
//   because a file *is* a record carrying a file claim.
// - **About** puts the room's three names side by side: its own profile, the
//   community's offer label, and the member's private label.
// - **Access** is where the detail that used to repeat on every row lives: the
//   two epochs and what they mean, history repair, and the full DIDs.
//
// **One place at a time.** The agent can hold two members of one room, and it
// refuses to choose between them, so the detail always acts as one *place*,
// chosen in the *Acting as* switch, and everything under it is keyed by
// `heldRoomKey` — switching remounts it rather than carrying one member's
// listing over to the other.

import { useState, type ReactNode } from "react";
import { heldRoomKey, roomProfileNotices, type RoomProfileView } from "@openvtc/pnm-core/rooms";
import type { AgentName } from "../../agent-name.js";
import { didHost } from "../../did-display.js";
import { Button, Did, Note, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { Popover, usePopoverAnchor } from "../popover.js";
import type { KnownRoomHost } from "../room-hosts.js";
import { memberLabel, placeLabel, placeWord, shortDid, standing } from "../room-words.js";
import type { RoomEntry } from "../room-groups.js";
import type { Parties } from "../use-vta.js";
import { FetchHistory } from "./rooms-backfill.js";
import { RoomLabel } from "./rooms-label.js";
import { RoomProfileDetails, roomDisplayName } from "./rooms-profile.js";
import { RoomRecords } from "./rooms-records.js";

/** A row of tabs, underlined when current. Shared with the pane's own tabs. */
export function TabStrip<K extends string>({
  tabs,
  current,
  onPick,
  label,
}: {
  tabs: readonly { key: K; label: ReactNode }[];
  current: K;
  onPick: (k: K) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} style={{ display: "flex", gap: 22, flexWrap: "wrap", borderBottom: `1px solid ${c.line}` }}>
      {tabs.map((tab) => {
        const on = tab.key === current;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={on}
            onClick={() => onPick(tab.key)}
            style={{
              font: "inherit",
              fontSize: t.base,
              fontWeight: 600,
              padding: "9px 2px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: on ? c.text : c.muted,
              boxShadow: on ? `inset 0 -2px 0 0 ${c.accent}` : "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** A small set of mutually exclusive choices, as pressed buttons. */
export function Segmented<K extends string>({
  options,
  current,
  onPick,
  label,
}: {
  options: readonly { key: K; label: ReactNode }[];
  current: K;
  onPick: (k: K) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: 2,
        padding: 2,
        background: c.raised,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-sm)",
      }}
    >
      {options.map((o) => {
        const on = o.key === current;
        return (
          <button
            key={o.key}
            aria-pressed={on}
            onClick={() => onPick(o.key)}
            style={{
              font: "inherit",
              fontSize: t.sm,
              fontWeight: 600,
              padding: "5px 11px",
              border: "none",
              borderRadius: "var(--w-r-sm)",
              cursor: "pointer",
              background: on ? c.surface : "transparent",
              color: on ? c.text : c.muted,
              boxShadow: on ? "0 1px 2px rgba(19,23,34,0.08)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A square tile carrying a room's initials, standing in for an icon it does not have. */
export function RoomTile({ name, size = 34 }: { name: string | undefined; size?: number }) {
  const initials = name
    ? name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => [...w][0]!.toUpperCase())
        .join("")
    : "?";
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: "0 0 auto",
        borderRadius: size > 40 ? 11 : 7,
        background: name ? c.accentSoft : c.raised,
        color: name ? c.accent : c.faint,
        display: "grid",
        placeItems: "center",
        fontWeight: 700,
        fontSize: size > 40 ? t.md : t.sm,
      }}
    >
      {initials}
    </span>
  );
}

/** Where a room was last found, in the words its provenance earns. */
export function hostProvenance(h: KnownRoomHost): string {
  switch (h.source) {
    case "community":
      return "From the community's offer, remembered by this wallet.";
    case "created":
      return "Where this console registered the room.";
    case "used":
      return "The host that last answered for this room here.";
  }
}

const section: React.CSSProperties = {
  background: c.surface,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-md)",
  padding: "14px 16px",
  display: "grid",
  gap: 8,
  alignContent: "start",
};

const sectionTitle: React.CSSProperties = {
  fontSize: t.xs,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontWeight: 650,
  color: c.faint,
};

type Sub = "records" | "about" | "access";

export function RoomDetail({
  parties,
  entry,
  host,
  community,
  profile,
  names,
  onBack,
  onChanged,
  onHost,
}: {
  parties: Parties;
  entry: RoomEntry;
  host: KnownRoomHost | undefined;
  /** The community's offer label for the room, where one is remembered. */
  community: string | undefined;
  profile: RoomProfileView | undefined;
  names: Readonly<Record<string, AgentName>>;
  onBack: () => void;
  /** The agent's listing changed (a label saved, history fetched): read it again. */
  onChanged: () => void;
  /** A host answered for this room: remember it. */
  onHost: (host: string) => void;
}) {
  const [at, setAt] = useState(0);
  const [sub, setSub] = useState<Sub>("records");
  const editor = usePopoverAnchor();
  const place = entry.places[Math.min(at, entry.places.length - 1)]!;
  const multi = entry.places.length > 1;
  const agentDid = parties.service.did;

  const personal = place.personal?.label;
  const shown = roomDisplayName({ personal, profile, community });
  const s = standing(place);

  const label = editor.open && (
    <Popover anchor={editor.ref} onClose={editor.hide} title="Your label for this room">
      <RoomLabel
        key={heldRoomKey(place)}
        parties={parties}
        room={place}
        onSaved={() => {
          onChanged();
          editor.hide();
        }}
      />
    </Popover>
  );

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
          <RoomTile name={shown?.name} size={48} />
          <div style={{ flex: "1 1 300px", display: "grid", gap: 4, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: t.lg, fontWeight: 700, wordBreak: "break-word" }}>
              {shown?.source === "profile" && profile?.emoji ? `${profile.emoji} ` : ""}
              {shown?.name ?? "Unnamed room"}
            </h2>
            <span style={{ fontSize: t.sm, color: c.muted }}>
              {shown?.source === "personal"
                ? "your name for it"
                : shown?.source === "profile"
                  ? "the room's own name"
                  : shown?.source === "community"
                    ? "the community's name for it"
                    : "no name this wallet can read"}
              {" · "}
              {host ? (
                <>
                  last found at <strong style={{ color: c.text, fontWeight: 600 }} title={host.host}>{didHost(host.host) ?? shortDid(host.host)}</strong>
                </>
              ) : (
                "host not known yet"
              )}
            </span>
            {place.personal?.tags && (
              <span style={{ fontSize: t.xs, color: c.muted }}>{place.personal.tags.map((x) => `#${x}`).join("  ")}</span>
            )}
          </div>
          <button
            ref={editor.ref}
            onClick={editor.show}
            style={{ font: "inherit", fontSize: t.sm, fontWeight: 600, padding: "7px 14px", borderRadius: "var(--w-r-sm)", border: `1px solid ${c.line}`, background: c.raised, color: c.text, cursor: "pointer" }}
          >
            Your label
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${c.lineSoft}` }}>
          <span style={{ fontSize: t.sm, color: c.muted }}>Acting as</span>
          {multi ? (
            <Segmented
              label="Which of this agent's places in the room to act as"
              current={String(at)}
              onPick={(k) => setAt(Number(k))}
              options={entry.places.map((p, i) => ({
                key: String(i),
                label: (
                  <>
                    {memberLabel(p, agentDid, names)}
                    {placeWord(p) && <span style={{ fontWeight: 500, color: c.faint }}> · {placeWord(p)}</span>}
                  </>
                ),
              }))}
            />
          ) : (
            <span style={{ fontSize: t.sm, fontWeight: 600 }}>
              {memberLabel(place, agentDid, names)}
              {placeWord(place) && <span style={{ fontWeight: 500, color: c.faint }}> · {placeWord(place)}</span>}
            </span>
          )}
          <span title={s.why}>
            <Pill tone={s.tone}>{s.label}</Pill>
          </span>
          {multi && (
            <span style={{ fontSize: t.xs, color: c.faint, flex: "1 1 18rem" }}>
              This agent holds {entry.places.length} places in this room. Everything below acts as the
              one selected, not as the other{entry.places.length > 2 ? "s" : ""}.
            </span>
          )}
        </div>
      </section>
      {label}

      <TabStrip<Sub>
        label="This room"
        current={sub}
        onPick={setSub}
        tabs={[
          { key: "records", label: "Records" },
          { key: "about", label: "About" },
          { key: "access", label: "Access" },
        ]}
      />

      {sub === "records" && (
        <div style={{ display: "grid", gap: 10 }}>
          {s.tone === "warn" && (
            <Note tone="warn">
              Records written before this place's {s.label === "from joining" ? "joining" : `epoch ${place.earliestReadableEpoch}`} cannot
              be opened here yet — their keys have not been delivered.{" "}
              <button
                onClick={() => setSub("access")}
                style={{ font: "inherit", border: "none", background: "transparent", color: c.accent, cursor: "pointer", padding: 0, fontWeight: 600 }}
              >
                Fetch the history
              </button>
            </Note>
          )}
          <RoomRecords key={heldRoomKey(place)} parties={parties} room={place} host={host?.host} onListed={onHost} />
        </div>
      )}

      {sub === "about" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          <div style={section}>
            <span style={sectionTitle}>The room's own profile</span>
            {profile?.name ? (
              <span style={{ fontSize: t.md, fontWeight: 650, wordBreak: "break-word" }}>
                {profile.emoji ? `${profile.emoji} ` : ""}
                {profile.name}
              </span>
            ) : (
              <span style={{ fontSize: t.sm, color: c.muted }}>
                {!host
                  ? "Not read yet: the room's host is not known. List its records once and it is."
                  : profile?.status === "absent" || profile?.status === "cleared"
                    ? "This room has not given itself a name you can read."
                    : "Your agent did not return a profile for this room."}
              </span>
            )}
            <RoomProfileDetails view={profile} />
            {profile?.name && (
              <span style={{ fontSize: t.xs, color: c.faint }}>Sealed inside the room, and read and checked by your agent.</span>
            )}
          </div>
          <div style={section}>
            <span style={sectionTitle}>What its community calls it</span>
            {community ? (
              <span style={{ fontSize: t.md, fontWeight: 650, wordBreak: "break-word" }}>{community}</span>
            ) : (
              <span style={{ fontSize: t.sm, color: c.muted }}>No community has offered this room to this wallet.</span>
            )}
          </div>
          <div style={section}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...sectionTitle, flex: 1 }}>Your label</span>
              <Button kind="quiet" onClick={editor.show}>
                Edit
              </Button>
            </div>
            {place.personal ? (
              <>
                {personal && <span style={{ fontSize: t.md, fontWeight: 650, wordBreak: "break-word" }}>{personal}</span>}
                {place.personal.description && (
                  <span style={{ fontSize: t.sm, color: c.text, whiteSpace: "pre-wrap" }}>{place.personal.description}</span>
                )}
                {place.personal.notes && (
                  <span style={{ fontSize: t.sm, color: c.muted, whiteSpace: "pre-wrap" }}>{place.personal.notes}</span>
                )}
              </>
            ) : (
              <span style={{ fontSize: t.sm, color: c.muted }}>Not set. Give it a name, notes or tags only you see.</span>
            )}
            <span style={{ fontSize: t.xs, color: c.faint }}>
              Kept by your agent for this place, and never sent to the room, its host or a community.
            </span>
          </div>
        </div>
      )}

      {sub === "access" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          <div style={section}>
            <span style={sectionTitle}>Who acts here</span>
            <span style={{ fontSize: t.base, fontWeight: 650 }}>{memberLabel(place, agentDid, names)}</span>
            {place.member && <Did value={place.member} size={t.xs} />}
            <span style={{ fontSize: t.sm, color: c.muted }}>
              {[placeLabel(place), place.context ? `context ${place.context}` : ""].filter(Boolean).join(" · ")}
            </span>
            <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.5 }}>
              Holding keys is not permission to act. Whether this place may still write here is decided by
              the host, from credentials the room issued — so a room it can read may still refuse a write.
            </p>
          </div>
          <div style={section}>
            <span style={sectionTitle}>History</span>
            <div style={{ display: "flex", gap: 20 }}>
              <span style={{ display: "grid" }}>
                <span style={{ fontSize: t.lg, fontWeight: 700, fontFamily: font.mono }}>{place.epoch}</span>
                <span style={{ fontSize: t.xs, color: c.faint }}>room epoch</span>
              </span>
              <span style={{ display: "grid" }}>
                <span style={{ fontSize: t.lg, fontWeight: 700, fontFamily: font.mono }}>{place.earliestReadableEpoch}</span>
                <span style={{ fontSize: t.xs, color: c.faint }}>readable from</span>
              </span>
            </div>
            <span>
              <Pill tone={s.tone}>{s.label}</Pill>
            </span>
            <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.5 }}>{s.why}</p>
            {/* Offered only where there is something to repair: a button that
                did nothing would teach an operator to distrust the one that does. */}
            {place.earliestReadableEpoch > 1 && (
              <FetchHistory key={heldRoomKey(place)} parties={parties} room={place} host={host?.host} onFetched={onChanged} />
            )}
          </div>
          <div style={section}>
            <span style={sectionTitle}>Identifiers</span>
            <span style={{ fontSize: t.xs, color: c.faint }}>Room</span>
            <Did value={entry.roomId} size={t.xs} />
            <span style={{ fontSize: t.xs, color: c.faint }}>Host</span>
            {host ? (
              <>
                <Did value={host.host} size={t.xs} />
                <span style={{ fontSize: t.xs, color: c.faint }}>
                  {hostProvenance(host)} Your agent keeps no host for a room — a room can move — so this is
                  where it was last found, not where it must be.
                </span>
              </>
            ) : (
              <span style={{ fontSize: t.xs, color: c.faint }}>
                Not known yet. Name it under Records once, and the wallet remembers it.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A profile's notices, for a card: a refused rename and a stale profile, in words. */
export function profileNotices(view: RoomProfileView | undefined): string[] {
  return view ? roomProfileNotices(view) : [];
}

