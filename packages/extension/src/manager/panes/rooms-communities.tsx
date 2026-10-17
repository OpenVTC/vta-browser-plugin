// Communities: each one as a lane, each room as a path across it.
//
//   Offered to you  →  In your rooms  →  Its portal can see
//
// This replaces two tabs, Offers and Shared with sites, which described one
// relationship from either end. The model is `community-lanes.ts`; this only
// draws it. Each column is a different source — the community's offer, the
// agent's key custody, this wallet's own grant — so a gap is drawn as the state
// it is (not offered here, keys not arrived yet, not shared) rather than left
// blank, and the arrow between two cells is solid only where both are present.
//
// Accepting still raises the wallet's own window (`useRoomOffers`); revoking a
// share stops the portal reading the room at once and cannot recall what it was
// already shown.

import type { ReactNode } from "react";
import type { RoomProfileView } from "@openvtc/pnm-core/rooms";
import { displayAgentName, type AgentName } from "../../agent-name.js";
import { didHost } from "../../did-display.js";
import { isActionable, type OfferView } from "../../room-offers-policy.js";
import { Button, Note, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { communityLanes, rowStage, type Lane, type LaneRow } from "../community-lanes.js";
import type { RoomEntry } from "../room-groups.js";
import type { KnownRoomHost } from "../room-hosts.js";
import { mostReadable } from "../room-groups.js";
import { memberLabel, placeWord, shortDid, standing } from "../room-words.js";
import { day, host, offerKey, type RoomOffersState } from "./rooms-offers.js";
import type { RoomSharesState, ShareRow } from "./rooms-shares.js";
import { roomDisplayName } from "./rooms-profile.js";

const COLUMNS = "minmax(0, 1fr) 28px minmax(0, 1fr) 28px minmax(0, 1fr)";

function communityName(did: string, names: Readonly<Record<string, AgentName>>): string {
  const n = names[did];
  return n ? displayAgentName(n) : (didHost(did) ?? shortDid(did));
}

function Arrow({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: "grid", placeItems: "center", color: on ? c.accent : c.line, fontSize: t.md, fontWeight: 700 }}
    >
      →
    </span>
  );
}

function Cell({ children, filled }: { children: ReactNode; filled: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        alignContent: "start",
        padding: "10px 12px",
        borderRadius: "var(--w-r-sm)",
        border: filled ? `1px solid ${c.line}` : `1px dashed ${c.line}`,
        background: filled ? c.surface : "transparent",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

const quiet = (text: string) => <span style={{ fontSize: t.sm, color: c.faint }}>{text}</span>;

function OfferCell({
  row,
  offers,
}: {
  row: LaneRow;
  offers: RoomOffersState;
}) {
  if (row.offers.length === 0) {
    return <Cell filled={false}>{quiet("Not from an offer here")}</Cell>;
  }
  return (
    <Cell filled>
      {row.offers.map((o: OfferView) => {
        const k = offerKey(o);
        const result = offers.outcome[k];
        const pill = o.inProgress ? (
          <Pill tone="warn">unfinished</Pill>
        ) : o.state === "open" ? (
          <Pill tone="accent">new</Pill>
        ) : (
          <Pill tone="ok">accepted</Pill>
        );
        return (
          <div key={k} style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: t.base, fontWeight: 600, wordBreak: "break-word" }} title="The name the community gave it">
                {o.label || "Unnamed room"}
              </span>
              {pill}
            </div>
            <span style={{ fontSize: t.xs, color: c.muted }}>
              to <span title={o.member}>{shortDid(o.member)}</span> · {o.visibility} · {o.actions.join(", ")} · until{" "}
              {day(o.validUntil)}
              {o.inProgress ? " · an accept began here and did not finish" : ""}
            </span>
            {isActionable(o) && (
              <div>
                <Button kind="primary" disabled={offers.busy !== null} onClick={() => void offers.accept(o)}>
                  {offers.busy === k ? "Confirm in the wallet window…" : o.inProgress ? "Finish accepting" : "Accept…"}
                </Button>
              </div>
            )}
            {result && <span style={{ fontSize: t.sm, color: result.ok ? c.ok : c.danger }}>{result.text}</span>}
          </div>
        );
      })}
    </Cell>
  );
}

function HeldCell({
  row,
  agentDid,
  names,
  profile,
  onOpen,
}: {
  row: LaneRow;
  agentDid: string;
  names: Readonly<Record<string, AgentName>>;
  profile: RoomProfileView | undefined;
  onOpen: (roomId: string) => void;
}) {
  const entry: RoomEntry | undefined = row.held;
  if (!entry) {
    return (
      <Cell filled={false}>
        {rowStage(row) === "awaiting-keys" ? (
          <span style={{ fontSize: t.sm, color: c.warn }}>
            Accepted — the room's keys have not reached your agent yet, so it is not in your rooms.
          </span>
        ) : (
          quiet("Not in your rooms")
        )}
      </Cell>
    );
  }
  const personal = entry.places.find((p) => p.personal?.label)?.personal?.label;
  const shown = roomDisplayName({ personal, profile, community: row.label });
  const s = standing(mostReadable(entry));
  const words = [...new Set(entry.places.map(placeWord).filter(Boolean))];
  return (
    <Cell filled>
      <button
        onClick={() => onOpen(entry.roomId)}
        style={{ all: "unset", cursor: "pointer", display: "grid", gap: 6 }}
        aria-label={`Open ${shown?.name ?? "this room"} in your rooms`}
      >
        <span style={{ fontSize: t.base, fontWeight: 600, color: c.accent, wordBreak: "break-word" }}>
          {shown?.name ?? "Unnamed room"}
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {words.map((w) => (
            <Pill key={w} tone="accent">
              {w}
            </Pill>
          ))}
          <span title={s.why}>
            <Pill tone={s.tone}>{s.label}</Pill>
          </span>
        </span>
        <span style={{ fontSize: t.xs, color: c.muted }}>
          as {entry.places.map((p) => memberLabel(p, agentDid, names)).join(" and ")}
        </span>
      </button>
    </Cell>
  );
}

function ShareCell({ row, shares }: { row: LaneRow; shares: RoomSharesState }) {
  if (row.shares.length === 0) {
    return (
      <Cell filled={false}>
        {quiet("Not shared")}
        {row.held && (
          <span style={{ fontSize: t.xs, color: c.faint }}>Its portal asks, in the wallet's window, when it wants it.</span>
        )}
      </Cell>
    );
  }
  return (
    <Cell filled>
      {row.shares.map((s: ShareRow) => (
        <div key={`${s.key}|${s.grant.member}`} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: t.base, fontWeight: 600 }}>{host(s.grant.origin)}</span>
            <span style={{ fontSize: t.xs, color: c.muted }}>
              {typeof s.grant.member === "string"
                ? `as ${shortDid(s.grant.member)}`
                : "shared before shares named an identity: the portal will ask again"}{" "}
              · until {new Date(s.grant.expiresAt).toLocaleDateString()}
            </span>
          </span>
          <Button kind="danger" onClick={() => void shares.revoke(s)}>
            Revoke
          </Button>
        </div>
      ))}
    </Cell>
  );
}

function LaneView({
  lane,
  agentDid,
  names,
  profiles,
  offers,
  shares,
  onOpen,
}: {
  lane: Lane;
  agentDid: string;
  names: Readonly<Record<string, AgentName>>;
  profiles: Readonly<Record<string, RoomProfileView>>;
  offers: RoomOffersState;
  shares: RoomSharesState;
  onOpen: (roomId: string) => void;
}) {
  const cv = lane.offers;
  const waiting = lane.rows.filter((r) => r.offers.some(isActionable)).length;
  return (
    <section
      style={{
        background: c.surface,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-lg)",
        padding: "16px 18px",
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: t.md, fontWeight: 650 }}>{communityName(lane.communityDid, names)}</h3>
        <Pill tone="accent">community</Pill>
        {waiting > 0 && <Pill tone="accent">{waiting} waiting</Pill>}
        {lane.portals.map((o) => (
          <span key={o} style={{ fontSize: t.xs, color: c.muted }}>
            portal {host(o)}
          </span>
        ))}
        <code
          style={{ fontFamily: font.mono, fontSize: t.xs, color: c.faint, wordBreak: "break-all", flex: "1 1 18rem", textAlign: "right" }}
        >
          {lane.communityDid}
        </code>
      </div>

      {cv?.error && <Note tone="danger">The wallet could not find where this community takes requests: {cv.error}</Note>}
      {cv && !cv.reachable && cv.endpointOrigin && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: t.sm, color: c.muted }}>
            The wallet may not reach {host(cv.endpointOrigin)} yet, so it has not asked this community for offers.
          </span>
          <Button onClick={() => void offers.allow(cv.endpointOrigin!)}>Allow {host(cv.endpointOrigin)}</Button>
        </div>
      )}
      {cv?.members
        .filter((m) => m.error)
        .map((m) => (
          <Note key={m.member} tone="danger">
            As <code title={m.member}>{shortDid(m.member)}</code>: {m.error}
          </Note>
        ))}

      {lane.rows.length === 0 ? (
        cv?.reachable && cv.members.every((m) => !m.error) ? (
          <div style={{ fontSize: t.sm, color: c.muted }}>No offers from this community.</div>
        ) : null
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: COLUMNS, gap: "8px 0", minWidth: 720 }}>
            {["Offered to you", "", "In your rooms", "", "Its portal can see"].map((h, i) => (
              <span
                key={i}
                style={{ fontSize: t.xs, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 650, color: c.faint }}
              >
                {h}
              </span>
            ))}
            {lane.rows.map((row) => (
              <div key={row.roomId} style={{ display: "contents" }}>
                <OfferCell row={row} offers={offers} />
                <Arrow on={row.offers.length > 0 && !!row.held} />
                <HeldCell row={row} agentDid={agentDid} names={names} profile={profiles[row.roomId]} onOpen={onOpen} />
                <Arrow on={!!row.held && row.shares.length > 0} />
                <ShareCell row={row} shares={shares} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function RoomCommunities({
  agentDid,
  offers,
  shares,
  entries,
  hosts,
  names,
  profiles,
  onOpen,
}: {
  agentDid: string;
  offers: RoomOffersState;
  shares: RoomSharesState;
  entries: readonly RoomEntry[];
  hosts: Readonly<Record<string, KnownRoomHost>>;
  names: Readonly<Record<string, AgentName>>;
  profiles: Readonly<Record<string, RoomProfileView>>;
  /** Open a held room in My rooms. */
  onOpen: (roomId: string) => void;
}) {
  const overview = offers.overview;
  const lanes = communityLanes({
    communities: overview?.communities ?? [],
    shares: shares.shares ?? [],
    entries,
    hosts,
    agentDid,
  });
  const noOffers = overview?.noOffers?.length ?? 0;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0, fontSize: t.sm, color: c.muted, maxWidth: "88ch", lineHeight: 1.55 }}>
        Each community you sign in to, and each room's path through it: what it offered you, whether your agent holds
        the room, and whether its portal may show it. Accepting joins as the identity the offer is addressed to, and you
        confirm each one in the wallet's own window first.
      </p>
      {offers.error && <Note tone="danger">Offers could not be read: {offers.error}</Note>}
      {overview === null && !offers.error && lanes.length === 0 ? (
        <div style={{ fontSize: t.sm, color: c.muted }}>Reading offers…</div>
      ) : lanes.length === 0 ? (
        noOffers > 0 ? (
          <div style={{ fontSize: t.sm, color: c.muted }}>
            None of the places you sign in to with this wallet offers rooms.
          </div>
        ) : (
          <Note>
            You do not sign in to any community with this wallet yet, so there is nobody to ask for offers. Sign in to a
            community's member portal with the wallet, and its offers appear here.
          </Note>
        )
      ) : (
        <>
          {lanes.map((l) => (
            <LaneView
              key={l.communityDid}
              lane={l}
              agentDid={agentDid}
              names={names}
              profiles={profiles}
              offers={offers}
              shares={shares}
              onOpen={onOpen}
            />
          ))}
          {noOffers > 0 && (
            <span style={{ fontSize: t.sm, color: c.faint }}>
              Also signed in to {noOffers} {noOffers === 1 ? "place" : "places"} that {noOffers === 1 ? "does" : "do"} not
              offer rooms.
            </span>
          )}
        </>
      )}
    </div>
  );
}
