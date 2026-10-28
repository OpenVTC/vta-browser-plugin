// Communities: each one as a lane, each room as a row with a three-step track.
//
//   ● Offered ──── ● Joined ──── ○ On its website
//
// The steps are three facts about one room, not a pipeline it moves along, so
// the room is named once and each fact is a dot: filled when it holds, ringed
// when it waits on the member (an offer to accept) or is stuck (accepted, keys
// not arrived), hollow when it does not hold — in words, never blank. "On its
// website" is a share with the community's member portal; the step's hint says
// what that lets the site do.
//
// This replaces two tabs, Offers and Shared with sites, which described one
// relationship from either end. The model is `community-lanes.ts`; this only
// draws it. Each column is a different source — the community's offer, the
// agent's key custody, this wallet's own grant — so a gap is drawn as the state
// it is (not offered here, keys not arrived yet, not shared) rather than left
// blank. The identities a room is held as are long and live in its detail.
//
// Accepting still raises the wallet's own window (`useRoomOffers`); revoking a
// share stops the portal reading the room at once and cannot recall what it was
// already shown.

import type { ReactNode } from "react";
import type { RoomProfileView } from "@openvtc/pnm-core/rooms";
import { displayAgentName, type AgentName } from "../../agent-name.js";
import { didHost } from "../../did-display.js";
import { isActionable, type OfferView } from "../../room-offers-policy.js";
import { Button, Did, Note, Pill } from "../../ui.js";
import { c, t } from "../../theme.js";
import { communityLanes, rowStage, type Lane, type LaneRow } from "../community-lanes.js";
import type { RoomEntry } from "../room-groups.js";
import type { KnownRoomHost } from "../room-hosts.js";
import { mostReadable } from "../room-groups.js";
import { placeWord, shortDid, standing } from "../room-words.js";
import { day, host, offerKey, type RoomOffersState } from "./rooms-offers.js";
import type { RoomSharesState, ShareRow } from "./rooms-shares.js";
import { roomDisplayName } from "./rooms-profile.js";

/**
 * What a lane is called: the site a member signs in to, which is the name they
 * know it by. The DID's own host is where its document lives, which can be
 * another party altogether (a DID-hosting service), so it comes last.
 */
function laneTitle(lane: Lane, names: Readonly<Record<string, AgentName>>): string {
  const site = lane.portals[0] ?? lane.offers?.endpointOrigin;
  if (site) return host(site);
  const n = names[lane.communityDid];
  return n ? displayAgentName(n) : (didHost(lane.communityDid) ?? shortDid(lane.communityDid));
}

type StepState = "done" | "waiting" | "warn" | "todo";

interface Step {
  label: string;
  /** Said on hover: what the step means, for the one whose name cannot carry it. */
  hint?: string;
  state: StepState;
  lines: ReactNode[];
}

const DOT: Record<StepState, React.CSSProperties> = {
  done: { background: c.ok, border: `2px solid ${c.ok}` },
  waiting: { background: c.surface, border: `4px solid ${c.accent}` },
  warn: { background: c.surface, border: `4px solid ${c.warn}` },
  todo: { background: c.surface, border: `2px solid ${c.line}` },
};

/** Three facts about one room, drawn as a track: done, waiting on you, or not yet. */
function Track({ steps }: { steps: Step[] }) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((st, i) => (
        <li key={st.label} style={{ display: "grid", gap: 4, alignContent: "start", minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center" }}>
            <span
              aria-hidden="true"
              style={{ width: 12, height: 12, borderRadius: "50%", boxSizing: "border-box", flex: "0 0 auto", ...DOT[st.state] }}
            />
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                style={{ flex: 1, height: 2, margin: "0 6px", background: st.state === "done" ? c.ok : c.line }}
              />
            )}
          </span>
          <span
            title={st.hint}
            style={{
              fontSize: t.sm,
              fontWeight: 600,
              color: st.state === "todo" ? c.faint : c.text,
              cursor: st.hint ? "help" : "default",
              textDecoration: st.hint ? "underline dotted" : "none",
              textUnderlineOffset: 3,
            }}
          >
            {st.label}
          </span>
          {st.lines.map((l, j) => (
            <span key={j} style={{ fontSize: t.xs, color: st.state === "warn" ? c.warn : c.muted, paddingRight: 12 }}>
              {l}
            </span>
          ))}
        </li>
      ))}
    </ol>
  );
}

function offeredStep(row: LaneRow): Step {
  const open = row.offers.find((o) => o.state === "offered");
  const unfinished = row.offers.find((o) => o.state === "unfinished");
  const readmit = row.offers.find((o) => o.state === "needsReadmission");
  const joined = row.offers.find((o) => o.state === "joined");
  const removed = row.offers.find((o) => o.state === "removed");
  if (unfinished) {
    return {
      label: "Offered",
      state: "warn",
      lines: [<Pill tone="warn">unfinished</Pill>, "accepted, here or elsewhere, and not finished — finish it here"],
    };
  }
  if (readmit) {
    return {
      label: "Offered",
      state: "warn",
      lines: [
        <Pill tone="danger">needs re-admission</Pill>,
        "accepted, but your agent never joined and the community no longer keeps what it needs: ask an administrator to re-admit you",
      ],
    };
  }
  if (open) {
    return {
      label: "Offered",
      state: "waiting",
      lines: [
        <>
          <Pill tone="accent">new</Pill> to <span title={open.member}>{shortDid(open.member)}</span>
        </>,
        `${open.visibility} · ${open.actions.join(", ")} · until ${day(open.validUntil)}`,
      ],
    };
  }
  if (joined) {
    return { label: "Offered", state: "done", lines: ["accepted", `until ${day(joined.validUntil)}`] };
  }
  if (removed) {
    return { label: "Offered", state: "todo", lines: [<Pill tone="off">removed</Pill>] };
  }
  return { label: "Offered", state: "todo", lines: ["not from an offer here"] };
}

function joinedStep(row: LaneRow): Step {
  const entry = row.held;
  if (entry) {
    const s = standing(mostReadable(entry));
    const words = [...new Set(entry.places.map(placeWord).filter(Boolean))].join(" · ");
    return {
      label: "Joined",
      state: "done",
      lines: [
        ...(words ? [words] : []),
        <span title={s.why} style={{ color: s.tone === "ok" ? c.ok : c.warn }}>
          {s.label}
        </span>,
      ],
    };
  }
  if (row.offers.some((o) => o.state === "needsReadmission")) {
    return { label: "Joined", state: "warn", lines: ["never — your agent did not join before the community stopped keeping the room's keys for you"] };
  }
  if (rowStage(row) === "awaiting-keys") {
    return {
      label: "Joined",
      state: "warn",
      lines: ["Accepted — the room's keys have not reached your agent yet, so it is not in your rooms."],
    };
  }
  return { label: "Joined", state: "todo", lines: ["not yet"] };
}

const WEBSITE_HINT =
  "The community's member site can list and read this room while you are signed in there. " +
  "Anything it asks to write is still confirmed in the wallet's own window.";

function websiteStep(row: LaneRow, shares: RoomSharesState): Step {
  if (row.shares.length === 0) {
    return { label: "On its website", hint: WEBSITE_HINT, state: "todo", lines: ["not shared"] };
  }
  return {
    label: "On its website",
    hint: WEBSITE_HINT,
    state: "done",
    lines: row.shares.flatMap((s: ShareRow) => [
      `${host(s.grant.origin)} · until ${new Date(s.grant.expiresAt).toLocaleDateString()}`,
      <button
        onClick={() => void shares.revoke(s)}
        style={{ font: "inherit", fontSize: t.xs, fontWeight: 600, padding: 0, border: "none", background: "transparent", color: c.danger, cursor: "pointer" }}
      >
        Stop sharing
      </button>,
    ]),
  };
}

function RoomRow({
  row,
  profile,
  offers,
  shares,
  onOpen,
}: {
  row: LaneRow;
  profile: RoomProfileView | undefined;
  offers: RoomOffersState;
  shares: RoomSharesState;
  onOpen: (roomId: string) => void;
}) {
  const entry: RoomEntry | undefined = row.held;
  const personal = entry?.places.find((p) => p.personal?.label)?.personal?.label;
  const name = roomDisplayName({ personal, profile, community: row.label })?.name ?? "Unnamed room";
  const actionable = row.offers.filter(isActionable);
  return (
    <div style={{ display: "grid", gap: 10, padding: "14px 0", borderTop: `1px solid ${c.lineSoft}` }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {entry ? (
          <button
            onClick={() => onOpen(entry.roomId)}
            aria-label={`Open ${name} in your rooms`}
            style={{ all: "unset", cursor: "pointer", fontSize: t.base, fontWeight: 650, color: c.accent, wordBreak: "break-word" }}
          >
            {name}
          </button>
        ) : (
          <span style={{ fontSize: t.base, fontWeight: 650, wordBreak: "break-word" }} title="The name the community gave it">
            {name}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {actionable.map((o) => {
          const k = offerKey(o);
          return (
            <Button key={k} kind="primary" disabled={offers.busy !== null} onClick={() => void offers.accept(o)}>
              {offers.busy === k
                ? "Confirm in the wallet window…"
                : o.state === "unfinished"
                  ? "Finish accepting"
                  : actionable.length > 1
                    ? `Accept as ${shortDid(o.member)}…`
                    : "Accept…"}
            </Button>
          );
        })}
      </div>
      {(() => {
        // What the community says the room is for (vtc/rooms/offers/list 0.4), as text only.
        const description = row.offers.find((o) => o.description)?.description;
        return description ? (
          <span
            style={{ fontSize: t.sm, color: c.text, wordBreak: "break-word", whiteSpace: "pre-line" }}
            title="What the community says the room is for"
          >
            {description}
          </span>
        ) : null;
      })()}
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 560 }}>
          <Track steps={[offeredStep(row), joinedStep(row), websiteStep(row, shares)]} />
        </div>
      </div>
      {row.offers.map((o) => {
        const result = offers.outcome[offerKey(o)];
        return result ? (
          <span key={offerKey(o)} style={{ fontSize: t.sm, color: result.ok ? c.ok : c.danger }}>
            {result.text}
          </span>
        ) : null;
      })}
    </div>
  );
}

function LaneView({
  lane,
  names,
  profiles,
  offers,
  shares,
  onOpen,
}: {
  lane: Lane;
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
        padding: "16px 18px 4px",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: t.md, fontWeight: 650 }}>{laneTitle(lane, names)}</h3>
        <Pill tone="accent">community</Pill>
        {waiting > 0 && <Pill tone="warn">{waiting} waiting on you</Pill>}
        <span style={{ flex: 1 }} />
        <Did value={lane.communityDid} size={t.xs} />
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
          <div style={{ fontSize: t.sm, color: c.muted, paddingBottom: 12 }}>No offers from this community.</div>
        ) : null
      ) : (
        <div>
          {lane.rows.map((row) => (
            <RoomRow
              key={row.roomId}
              row={row}
              profile={profiles[row.roomId]}
              offers={offers}
              shares={shares}
              onOpen={onOpen}
            />
          ))}
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
