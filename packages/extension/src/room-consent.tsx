/// <reference types="chrome" />

// The two room prompts a portal page can raise (P7b; VTI `data-rooms-files.md`
// §8.5). Both are drawn by the wallet, from what the background stored — the
// page draws neither and can change neither.
//
//   - **Share**: the rooms the member's VTA holds, ticked where already shared
//     with this portal. The member chooses; the selection is the whole of what
//     is shared here afterwards. A page cannot see this list, only what it is
//     given.
//   - **Write**: one note or one file, in one room, signed as the member. The
//     prompt says what will be written, and there is no "remember" — except on a
//     reaction, which may offer one bounded, revocable grant: this portal may add
//     and take back the member's reactions in this one room for 30 minutes.

import { useEffect, useId, useState } from "react";

import { requestOriginPermission } from "./host-permissions.js";
import {
  ROOM_CONSENT_PREFIX,
  type RoomShareConsentView,
  type RecordGlimpse,
  type RoomShareRow,
  type RoomWriteConsentView,
  shareButtonWords,
  toggleShareRow,
  type SessionGrantOffer,
} from "./room-page-policy.js";
import { Did } from "./ui.js";
import { OfferConsent } from "./room-offer-consent.js";
import type { RoomOfferConsentView } from "./room-offers-policy.js";

function originHost(o: string): string {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

const label: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--w-muted)",
  marginBottom: 4,
};

const card: React.CSSProperties = {
  border: "1px solid var(--w-line)",
  borderRadius: 6,
  padding: 10,
  background: "var(--w-raised)",
};

const buttons: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 };

function Primary(props: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        padding: "8px 18px",
        fontSize: 13,
        fontWeight: 700,
        border: "none",
        borderRadius: 8,
        color: "var(--w-accent-ink)",
        background: "var(--w-accent)",
        opacity: props.disabled ? 0.45 : 1,
        cursor: props.disabled ? "not-allowed" : "pointer",
      }}
    >
      {props.children}
    </button>
  );
}

export function RoomConsent({
  consentId,
  decide,
}: {
  consentId: string;
  decide: (approved: boolean, selectedRooms?: string[], reactionGrant?: boolean, sessionGrant?: boolean) => void;
}) {
  const [view, setView] = useState<RoomShareConsentView | RoomWriteConsentView | RoomOfferConsentView | null>(null);
  useEffect(() => {
    const key = `${ROOM_CONSENT_PREFIX}${consentId}`;
    void chrome.storage.session.get(key).then((v: Record<string, unknown>) => {
      setView((v[key] as RoomShareConsentView | RoomWriteConsentView | RoomOfferConsentView) ?? null);
    });
  }, [consentId]);

  if (!view) return <div style={{ padding: 20, fontSize: 13 }}>Loading request…</div>;
  return (
    <div style={{ padding: 20, fontSize: 13, display: "grid", gap: 14 }}>
      {view.kind === "share" ? (
        <Share view={view} decide={decide} />
      ) : view.kind === "offer" ? (
        <OfferConsent view={view} decide={decide} />
      ) : (
        <Write
          view={view}
          decide={(ok, reactionGrant, sessionGrant) => decide(ok, undefined, reactionGrant, sessionGrant)}
        />
      )}
    </div>
  );
}

/** A member, briefly: a DID's method and its tail. */
function shortMember(did: string): string {
  return did.length > 48 ? `${did.slice(0, 24)}…${did.slice(-14)}` : did;
}

/** What a share row says about the member's place in the room. */
function roleWords(role: RoomShareRow["role"]): string {
  return role === "administers" ? "administers the room" : role === "member" ? "member" : "place not reported";
}

function Share({
  view,
  decide,
}: {
  view: RoomShareConsentView;
  decide: (approved: boolean, selectedRooms?: string[]) => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(view.rooms.filter((r) => r.ticked).map((r) => r.key)));
  const [error, setError] = useState<string | null>(null);
  const toggle = (key: string) => setTicked((prev) => toggleShareRow(view.rooms, prev, key));
  // A room offered as more than one identity is the one place the member must
  // choose who acts; say so beside it.
  const asMany = new Set(
    view.rooms.filter((r, i) => view.rooms.findIndex((o) => o.roomId === r.roomId) !== i).map((r) => r.roomId),
  );

  async function share(): Promise<void> {
    // The permission request must be the first await in the click, or the
    // gesture is spent (`host-permissions.ts`).
    if (view.needsOrigin) {
      const granted = await requestOriginPermission(view.needsOrigin).catch(() => false);
      if (!granted) {
        setError(`The wallet needs to reach ${originHost(view.needsOrigin)} to use these rooms.`);
        return;
      }
    }
    decide(true, [...ticked]);
  }

  return (
    <>
      <strong style={{ fontSize: 14 }}>Share rooms with {originHost(view.origin)}?</strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
        This is the member portal of <Did value={view.hostDid} />, by its DID document. Tick the rooms that belong
        to this community. The page will be able to <b>read</b> them, and to <b>ask</b> to add notes and files —
        each addition is shown to you here first. It sees no other room, and no key.
      </div>
      <div>
        <div style={label}>Rooms you hold as the identity you use here</div>
        {view.members.length === 0 ? (
          <div style={card}>
            You have not signed in to this community with an identity your agent holds, so there is no one to share a
            room as. Sign in to the portal with your wallet first.
          </div>
        ) : view.rooms.length === 0 ? (
          <div style={card}>Your agent holds no room as the identity you use here.</div>
        ) : (
          <div style={{ ...card, display: "grid", gap: 8, maxHeight: 300, overflow: "auto" }}>
            {view.rooms.map((r) => (
              <label key={r.key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={ticked.has(r.key)}
                  onChange={() => toggle(r.key)}
                  aria-label={`Share ${r.label ?? r.roomId} as ${r.member}`}
                />
                <span style={{ display: "grid", gap: 2 }}>
                  {/* A community's own room by the name its administrators gave
                      it, the DID beneath; any other room by its DID alone. */}
                  {r.label !== undefined && <strong style={{ fontSize: 13 }}>{r.label}</strong>}
                  <Did value={r.roomId} />
                  <span style={{ fontSize: 11 }} title={r.member}>
                    as <code>{shortMember(r.member)}</code>
                    {r.context ? ` · context ${r.context}` : ""} · {roleWords(r.role)}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--w-muted)" }}>
                    {r.shared ? "shared with this portal" : r.ticked ? "the page asked for this one" : "not shared"}
                    {asMany.has(r.roomId) ? " · you hold this room as more than one identity: tick the one to use here" : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {view.others > 0 && (
          <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 6 }}>
            {view.others === 1 ? "1 other room your agent holds is" : `${view.others} other rooms your agent holds are`}{" "}
            held only as other identities — the community's own among them, for a room it owns — and{" "}
            {view.others === 1 ? "is" : "are"} not offered to this page.
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--w-muted)" }}>
        Each room is checked with the community, as you, before it is shared. A private room is never shared with a
        portal: its host is not to learn who reads it. Shares last 30 days, and you can revoke them in the
        wallet's console.
      </div>
      {error && <div style={{ color: "var(--w-danger)" }}>{error}</div>}
      <div style={buttons}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Cancel
        </button>
        <Primary onClick={() => void share()}>{shareButtonWords(ticked.size)}</Primary>
      </div>
    </>
  );
}

/** The record a reply or a reaction is about, as the wallet read it. */
function Glimpse({ of }: { of: RecordGlimpse }) {
  return (
    <div style={{ ...card, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {of.author ? (
        <div style={{ fontSize: 11, color: "var(--w-muted)", marginBottom: 4 }}>
          By <Did value={of.author} />
        </div>
      ) : null}
      {of.excerpt || <span style={{ color: "var(--w-muted)" }}>(nothing to show)</span>}
    </div>
  );
}

/**
 * The "while this room is open" box a message or reaction prompt may offer: one
 * room, the one open page, messages and reactions only, never notes or files.
 */
function SessionBox({
  view,
  offer,
  checked,
  onChange,
}: {
  view: RoomWriteConsentView;
  offer: SessionGrantOffer;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const boxId = useId();
  const room = offer.roomLabel ? `“${offer.roomLabel}”` : "this room";
  return (
    <label htmlFor={boxId} style={{ display: "flex", gap: 8, alignItems: "flex-start", ...card }}>
      <input id={boxId} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ lineHeight: 1.4 }}>
        Send messages and reactions in {room} without asking while this room is open in {originHost(view.origin)}.
        <span style={{ display: "block", fontSize: 11, color: "var(--w-muted)" }}>
          Ends when you leave the room or close the tab, after 30 minutes without a message, or after 8 hours. Notes
          and files are always asked. The wallet's icon shows LIVE meanwhile; stop it any time from Communities.
        </span>
      </span>
    </label>
  );
}

function Write({
  view,
  decide,
}: {
  view: RoomWriteConsentView;
  decide: (approved: boolean, reactionGrant?: boolean, sessionGrant?: boolean) => void;
}) {
  const [session, setSession] = useState(false);
  if ("reaction" in view.what) return <React view={view} what={view.what} decide={decide} />;
  const offer = "message" in view.what ? view.what.session : undefined;
  const isFile = "file" in view.what;
  const isMessage = "message" in view.what;
  const replyingTo = "message" in view.what ? view.what.replyingTo : undefined;
  const thing = isFile ? "file" : isMessage ? (replyingTo ? "reply" : "message") : "note";
  return (
    <>
      <strong style={{ fontSize: 14 }}>
        {isMessage
          ? replyingTo
            ? "Send this reply to the room as you?"
            : "Send this message to the room as you?"
          : `Add a ${thing} to this room as you?`}
      </strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
        {originHost(view.origin)} asks to write to a room, signed as you. Every member of the room will read it as
        yours.
      </div>
      {view.visibility === "open" && (
        <div role="note" style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
          This room is <b>open</b>: {isFile ? "the file's record, and the key that opens it, are" : `the ${thing} is`}{" "}
          stored in the clear, so the room's host can read {isFile ? "the file" : "it"} as well as its members.
        </div>
      )}
      <div>
        <div style={label}>Room</div>
        <div style={card}>
          <Did value={view.roomId} />
          <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 4 }}>
            {view.visibility} room, hosted by <Did value={view.hostDid} />
          </div>
        </div>
      </div>
      <div>
        <div style={label}>Signed as</div>
        <div style={card}>
          <Did value={view.member} />
        </div>
      </div>
      {replyingTo ? (
        <div>
          <div style={label}>In reply to</div>
          <Glimpse of={replyingTo} />
        </div>
      ) : null}
      <div>
        <div style={label}>What will be written</div>
        <div style={{ ...card, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {"file" in view.what ? (
            <>
              <b>{view.what.name}</b> · {bytes(view.what.size)}
              {view.what.mediaType ? ` · ${view.what.mediaType}` : ""}
              {view.what.title ? <div>Title: {view.what.title}</div> : null}
            </>
          ) : "message" in view.what ? (
            <>
              {view.what.excerpt}
              <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 6 }}>
                {view.what.bodyChars} characters
              </div>
            </>
          ) : (
            <>
              <b>{view.what.title}</b>
              {view.what.excerpt ? <div style={{ marginTop: 6 }}>{view.what.excerpt}</div> : null}
              <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 6 }}>
                {view.what.bodyChars} characters
              </div>
            </>
          )}
        </div>
      </div>
      {offer ? <SessionBox view={view} offer={offer} checked={session} onChange={setSession} /> : null}
      <div style={buttons}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Deny
        </button>
        <Primary onClick={() => decide(true, undefined, offer ? session : undefined)}>
          {isMessage ? (replyingTo ? "Send reply" : "Send message") : `Add ${thing}`}
        </Primary>
      </div>
    </>
  );
}

/**
 * A reaction, or taking one back: compact, since it is one value on one record.
 * Where the background offers it, one unticked box lets this portal add and take
 * back the member's reactions in this one room for a bounded time — never
 * messages, notes or files, never another room, never renewed without this box.
 */
function React({
  view,
  what,
  decide,
}: {
  view: RoomWriteConsentView;
  what: Extract<RoomWriteConsentView["what"], { reaction: true }>;
  decide: (approved: boolean, reactionGrant?: boolean, sessionGrant?: boolean) => void;
}) {
  const [grant, setGrant] = useState(false);
  const [session, setSession] = useState(false);
  const boxId = useId();
  const room = what.grant?.roomLabel ? `“${what.grant.roomLabel}”` : "this room";
  return (
    <>
      <strong style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 22 }} aria-hidden="true">
          {what.value}
        </span>
        <span>
          {what.withdraw ? "Take back your reaction" : `React ${what.value}`} as you?
        </span>
      </strong>
      <Glimpse of={what.on} />
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45, fontSize: 12 }}>
        Asked by {originHost(view.origin)}. Every member of the room sees it as yours, signed as{" "}
        <Did value={view.member} />.
        {view.visibility === "open" ? " This room is open: its host can see it too." : ""}
      </div>
      {what.grant && (
        <label htmlFor={boxId} style={{ display: "flex", gap: 8, alignItems: "flex-start", ...card }}>
          <input id={boxId} type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} />
          <span style={{ lineHeight: 1.4 }}>
            Let {originHost(view.origin)} add and remove your reactions in {room} for {what.grant.minutes} minutes
            without asking.
            <span style={{ display: "block", fontSize: 11, color: "var(--w-muted)" }}>
              Reactions only — messages, notes and files are always asked. Stop it any time from Communities.
            </span>
          </span>
        </label>
      )}
      {what.session ? <SessionBox view={view} offer={what.session} checked={session} onChange={setSession} /> : null}
      <div style={{ ...buttons, marginTop: 4 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Deny
        </button>
        <Primary onClick={() => decide(true, what.grant ? grant : undefined, what.session ? session : undefined)}>{what.withdraw ? "Take back" : "React"}</Primary>
      </div>
    </>
  );
}
