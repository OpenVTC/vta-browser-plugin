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
// the honest failure is a refusal at the point of use. That is said **once**,
// above the cards, rather than under every room.
//
// **Two epochs per room, because neither alone is enough.** A card carries one
// history pill (`standing()` in `room-words.ts`) for its most readable place;
// the detail's Access tab says what the pair means and offers the repair.
//
// **One card per room, one place at a time.** One agent can hold two members of
// a room — an administrator whose agent also holds the community's own place in
// a room the community owns, or a person with two personas in it. The card says
// so; the detail acts as one place chosen on screen (`rooms-detail.tsx`), and
// every request from it names that member, because the agent refuses to choose.
//
// **Grouped by where the room was last found.** Nothing authoritative maps a
// room to its host, so the groups come from what this wallet has seen itself
// (`room-hosts.ts`): a community's offer, a room this console created, a host
// that answered a listing. A room with none sits under *Host not known yet*
// until its records are listed once. Grouping by trust context needs no hint.
//
// **Your name for a room comes first.** A card is named, in order, by the
// member's own private label, the room's own profile name, the community's
// offer label, then nothing — and a personal name never hides the others: the
// room's or community's name and the DID stay on the card beside it.
//
// The rest of the family has its own tab: the communities the member signs in
// to — what each offered, what became a room, what its portal may see, as one
// lane (`rooms-communities.tsx`) — the owner's issuing tools, and creating one.

import { useCallback, useEffect, useState } from "react";
import { roomsKeysList, type HeldRoom } from "@openvtc/pnm-core/rooms";
import { displayAgentName, type AgentName } from "../../agent-name.js";
import { didHost } from "../../did-display.js";
import { useAgentNames } from "../../use-agent-names.js";
import { Button, Pill } from "../../ui.js";
import { rememberedRoomLabels } from "../../room-page-policy.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { groupRooms, mostReadable, roomEntries, type GroupBy, type RoomEntry, type RoomGroup } from "../room-groups.js";
import { knownRoomHosts, ownedRooms, rememberRoomHost, type KnownRoomHost, type OwnedRoom } from "../room-hosts.js";
import { memberLabel, placeWord, shortDid, standing } from "../room-words.js";
import type { ContextRecord } from "@openvtc/pnm-core";
import type { RoomProfileView } from "@openvtc/pnm-core/rooms";
import type { Parties } from "../use-vta.js";
import { CreateRoom } from "./rooms-create.js";
import { IssueInRoomsName } from "./rooms-owner.js";
import { useRoomShares } from "./rooms-shares.js";
import { useRoomOffers } from "./rooms-offers.js";
import { RoomCommunities } from "./rooms-communities.js";
import { roomDisplayName, useRoomProfiles } from "./rooms-profile.js";
import { profileNotices, RoomDetail, RoomTile, Segmented, TabStrip } from "./rooms-detail.js";

type Tab = "rooms" | "communities" | "owner" | "new";

const INTRO_DISMISSED = "rooms-intro-dismissed";

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(INTRO_DISMISSED) === "1";
  } catch {
    return false;
  }
}

/** A host group's heading: the name its document claims, else its domain, else the DID cut short. */
function hostName(did: string, names: Readonly<Record<string, AgentName>>): string {
  const n = names[did];
  return n ? displayAgentName(n) : (didHost(did) ?? shortDid(did));
}

const HOST_KIND: Record<KnownRoomHost["source"], { word: string; tone: "accent" | "ok" | "off" }> = {
  community: { word: "community", tone: "accent" },
  created: { word: "created here", tone: "ok" },
  used: { word: "host", tone: "off" },
};

function RoomCard({
  entry,
  agentDid,
  names,
  profile,
  community,
  onOpen,
}: {
  entry: RoomEntry;
  agentDid: string;
  names: Readonly<Record<string, AgentName>>;
  profile: RoomProfileView | undefined;
  community: string | undefined;
  onOpen: () => void;
}) {
  // A card is the room; its personal label is whichever place carries one.
  const personal = entry.places.find((p) => p.personal?.label)?.personal;
  const shown = roomDisplayName({ personal: personal?.label, profile, community });
  const theirs = personal?.label !== undefined ? roomDisplayName({ profile, community }) : undefined;
  const best = standing(mostReadable(entry));
  const words = [...new Set(entry.places.map(placeWord).filter(Boolean))];
  const tags = personal?.tags ?? profile?.tags;
  const notices = profileNotices(profile);
  const multi = entry.places.length > 1;

  return (
    <button
      onClick={onOpen}
      aria-label={`Open ${shown?.name ?? "this room"}`}
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
        <RoomTile name={shown?.name} />
        <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
          <span style={{ fontSize: t.base, fontWeight: 650, color: c.text, wordBreak: "break-word" }}>
            {shown?.source === "profile" && profile?.emoji ? `${profile.emoji} ` : ""}
            {shown?.name ?? "Unnamed room"}
            {shown?.source === "personal" && (
              <span style={{ fontSize: t.xs, fontWeight: 500, color: c.muted }}> · your name for it</span>
            )}
          </span>
          {theirs && (
            <span style={{ fontSize: t.xs, color: c.muted }}>
              {theirs.source === "profile" ? "the room's name" : "community's name"}: {theirs.name}
            </span>
          )}
        </span>
      </span>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {words.map((w) => (
          <Pill key={w} tone="accent">
            {w}
          </Pill>
        ))}
        <span title={best.why}>
          <Pill tone={best.tone}>{best.label}</Pill>
        </span>
      </span>
      <span style={{ fontSize: t.sm, color: c.muted }}>
        {multi
          ? `Held as ${entry.places.length} identities: ${entry.places.map((p) => memberLabel(p, agentDid, names)).join(" and ")}`
          : `as ${memberLabel(entry.places[0]!, agentDid, names)}`}
      </span>
      {(personal?.description ?? profile?.description) && (
        <span
          style={{
            fontSize: t.xs,
            color: c.muted,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {personal?.description ?? profile?.description}
        </span>
      )}
      {notices.map((n) => (
        <span key={n} role="note" style={{ fontSize: t.xs, color: c.warn }}>
          {n}
        </span>
      ))}
      {tags && tags.length > 0 && <span style={{ fontSize: t.xs, color: c.muted }}>{tags.join(" · ")}</span>}
      <code style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all", marginTop: "auto" }}>
        {entry.roomId}
      </code>
    </button>
  );
}

function GroupHeading({
  group,
  names,
}: {
  group: RoomGroup;
  names: Readonly<Record<string, AgentName>>;
}) {
  const count = `${group.entries.length} ${group.entries.length === 1 ? "room" : "rooms"}`;
  let title: string;
  let kind: { word: string; tone: "accent" | "ok" | "off" | "warn" };
  let sub: string | undefined;
  if (group.kind === "host") {
    title = hostName(group.host.host, names);
    kind = HOST_KIND[group.host.source];
    sub = group.host.host;
  } else if (group.kind === "unknown") {
    title = "Host not known yet";
    kind = { word: "unknown", tone: "off" };
    sub = "Your agent holds these rooms' keys, but this wallet has not seen where they live. Open one and list its records once.";
  } else {
    title = group.context ? `context ${group.context}` : "Context not reported";
    kind = { word: "context", tone: "off" };
  }
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", paddingBottom: 6, borderBottom: `1px solid ${c.lineSoft}` }}>
      <h3 style={{ margin: 0, fontSize: t.md, fontWeight: 650, wordBreak: "break-word" }}>{title}</h3>
      <Pill tone={kind.tone}>{kind.word}</Pill>
      {sub && (
        <span style={{ fontSize: t.xs, color: c.faint, wordBreak: "break-all", flex: "1 1 20rem", minWidth: 0 }}>{sub}</span>
      )}
      <span style={{ fontSize: t.sm, color: c.faint, marginLeft: "auto" }}>{count}</span>
    </div>
  );
}

export function RoomsPane({
  parties,
  contexts,
}: {
  parties: Parties;
  contexts: ContextRecord[];
}) {
  const [tab, setTab] = useState<Tab>("rooms");
  const [rooms, setRooms] = useState<HeldRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [by, setBy] = useState<GroupBy>("host");
  const [introHidden, setIntroHidden] = useState(readDismissed);
  const agentDid = parties.service.did;

  const load = useCallback(async () => {
    setError(null);
    try {
      // The member's own console: the one surface that asks for their labels.
      setRooms(await roomsKeysList(managerSender, { ...parties }, { includePersonal: true }));
    } catch (e) {
      setRooms(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [parties]);

  useEffect(() => {
    void load();
  }, [load]);

  // Owned by the pane, whichever tab shows them: the open count is a badge.
  const reload = useCallback(() => void load(), [load]);
  const offerState = useRoomOffers({ onAccepted: reload });
  const offers = offerState.overview?.openCount ?? 0;
  const shareState = useRoomShares();
  const [owned, setOwned] = useState<OwnedRoom[]>([]);
  const [ownerStart, setOwnerStart] = useState<OwnedRoom | undefined>(undefined);

  // The names communities gave rooms on their offers, and where each room was
  // last found. Absent outside the extension (the pane's render tests).
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [hosts, setHosts] = useState<Record<string, KnownRoomHost>>({});
  useEffect(() => {
    const store = globalThis.chrome?.storage?.local;
    if (!store) return;
    store
      .get(null)
      .then((all) => {
        setLabels(rememberedRoomLabels(all, agentDid));
        setHosts(knownRoomHosts(all, agentDid));
        setOwned(ownedRooms(all, agentDid));
      })
      .catch(() => {
        setLabels({});
        setHosts({});
        setOwned([]);
      });
  }, [agentDid, rooms]);

  const remember = useCallback(
    (roomId: string, host: string, source: "created" | "used", signingKeyId?: string) => {
      setHosts((prev) =>
        prev[roomId]?.host === host ? prev : { ...prev, [roomId]: { host, source: prev[roomId]?.source === "created" ? "created" : source } },
      );
      if (signingKeyId) setOwned((prev) => [{ roomId, signingKeyId }, ...prev.filter((o) => o.roomId !== roomId)]);
      void rememberRoomHost(agentDid, roomId, host, source, signingKeyId);
    },
    [agentDid],
  );

  // The room's own profile, read once per listing from its known host — never polled.
  const hostDids = Object.fromEntries(Object.entries(hosts).map(([roomId, h]) => [roomId, h.host]));
  const profiles = useRoomProfiles(parties, rooms, hostDids);

  const names = useAgentNames([
    ...(rooms ?? []).map((r) => r.member),
    ...Object.values(hosts).map((h) => h.host),
  ]);

  const entries = roomEntries(rooms ?? []);
  const opened = open === null ? undefined : entries.find((e) => e.roomId === open);
  const places = rooms?.length ?? 0;

  const intro = !introHidden && (
    <div
      role="note"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        background: "var(--w-accent-wash)",
        border: `1px solid ${c.accentSoft}`,
        borderRadius: "var(--w-r-md)",
        padding: "11px 14px",
      }}
    >
      <p style={{ margin: 0, flex: 1, fontSize: t.sm, color: c.text, lineHeight: 1.55, maxWidth: "92ch" }}>
        These are the rooms your agent can <strong>open</strong> — its key custody, not its memberships.
        Holding keys is not permission to act: whether you may write is decided by the host, from
        credentials the room issued. A room you belong to whose Welcome never arrived is not listed.
      </p>
      <Button
        kind="quiet"
        onClick={() => {
          setIntroHidden(true);
          try {
            globalThis.localStorage?.setItem(INTRO_DISMISSED, "1");
          } catch {
            // Per-viewer convenience only; it simply shows again.
          }
        }}
      >
        Got it
      </Button>
    </div>
  );

  const list =
    error ? (
      <LoadError what="its rooms" error={error} />
    ) : rooms === null ? (
      <Loading what="rooms" />
    ) : entries.length === 0 ? (
      <div style={{ fontSize: t.sm, color: c.faint, lineHeight: 1.55 }}>
        No rooms. This agent has been given keys to none — which is also what it looks like before an
        invitation has been accepted.{" "}
        {offers > 0 && (
          <Button kind="quiet" onClick={() => setTab("communities")}>
            See {offers === 1 ? "the offer" : `${offers} offers`} waiting
          </Button>
        )}
      </div>
    ) : (
      <div style={{ display: "grid", gap: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: t.sm, color: c.muted }}>Group by</span>
          <Segmented<GroupBy>
            label="Group rooms by"
            current={by}
            onPick={setBy}
            options={[
              { key: "host", label: "Where it lives" },
              { key: "context", label: "Context" },
            ]}
          />
          <span style={{ fontSize: t.sm, color: c.faint, marginLeft: "auto" }}>
            {entries.length} {entries.length === 1 ? "room" : "rooms"}
            {places !== entries.length ? ` · ${places} places` : ""}
          </span>
        </div>
        {groupRooms(entries, hosts, by).map((g) => (
          <section key={g.key} style={{ display: "grid", gap: 10 }}>
            <GroupHeading group={g} names={names} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 12 }}>
              {g.entries.map((e) => (
                <RoomCard
                  key={e.roomId + "|" + e.places.map((p) => p.member).join(",")}
                  entry={e}
                  agentDid={agentDid}
                  names={names}
                  profile={profiles[e.roomId]}
                  community={labels[e.roomId]}
                  onOpen={() => setOpen(e.roomId)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    );

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", display: "grid", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: t.xl, fontWeight: 700 }}>Data rooms</h2>
          <p style={{ margin: 0, fontSize: t.sm, color: c.muted }}>
            Shared spaces your agent holds keys for, grouped by where each was last found.
          </p>
        </div>
        {tab !== "new" && (
          <Button kind="primary" onClick={() => setTab("new")}>
            New room
          </Button>
        )}
      </div>

      <TabStrip<Tab>
        label="Data rooms"
        current={tab}
        onPick={(k) => {
          setTab(k);
          setOpen(null);
          setOwnerStart(undefined);
        }}
        tabs={[
          { key: "rooms", label: "My rooms" },
          {
            key: "communities",
            label: (
              <>
                Communities
                {offers > 0 && <Pill tone="accent">{offers}</Pill>}
              </>
            ),
          },
          { key: "owner", label: "Owner tools" },
          ...(tab === "new" ? [{ key: "new" as const, label: "New room" }] : []),
        ]}
      />

      {tab === "rooms" &&
        (opened ? (
          <RoomDetail
            key={opened.roomId}
            parties={parties}
            entry={opened}
            host={hosts[opened.roomId]}
            community={labels[opened.roomId]}
            profile={profiles[opened.roomId]}
            names={names}
            onBack={() => setOpen(null)}
            onChanged={() => void load()}
            onHost={(host) => remember(opened.roomId, host, "used")}
            owned={owned.find((o) => o.roomId === opened.roomId)}
            onIssue={(o) => {
              setOwnerStart(o);
              setTab("owner");
            }}
          />
        ) : (
          <>
            {intro}
            {list}
          </>
        ))}

      {tab === "communities" && (
        <RoomCommunities
          agentDid={agentDid}
          offers={offerState}
          shares={shareState}
          entries={entries}
          hosts={hosts}
          names={names}
          profiles={profiles}
          onOpen={(roomId) => {
            setTab("rooms");
            setOpen(roomId);
          }}
        />
      )}

      {/* Its own tab rather than per room: issuing is about a room the owner
          has, and the list is key custody — a room can appear in one and not
          the other in both directions, so pairing them per card would suggest a
          correspondence that does not hold. */}
      {tab === "owner" && (
        <IssueInRoomsName
          key={ownerStart?.roomId ?? ""}
          parties={parties}
          owned={owned.map((o) => {
            const personal = rooms?.find((r) => r.roomId === o.roomId && r.personal?.label)?.personal?.label;
            const name = roomDisplayName({ personal, profile: profiles[o.roomId], community: labels[o.roomId] })?.name;
            return { ...o, ...(name !== undefined ? { name } : {}) };
          })}
          initial={ownerStart}
        />
      )}

      {tab === "new" && (
        <div style={{ display: "grid", gap: 10 }}>
          <Button kind="quiet" onClick={() => setTab("rooms")} style={{ justifySelf: "start", paddingLeft: 0 }}>
            ← All rooms
          </Button>
          <CreateRoom
            parties={parties}
            contexts={contexts}
            onCreated={({ roomId, host, signingKeyId }) => {
              remember(roomId, host, "created", signingKeyId);
              void load();
              setTab("rooms");
            }}
          />
        </div>
      )}
    </div>
  );
}
