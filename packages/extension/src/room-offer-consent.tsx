/// <reference types="chrome" />

// Accepting a community's offer of a room — the wallet's own window.
//
// Drawn from what the background stored (`RoomOfferConsentView`), never from a
// page: it names the community, the room (its label as the community wrote it,
// labelled as theirs, and its DID), the identity the member joins as, and what
// accepting does. A portal page can ask for this window; only the member can
// answer it. There is no "remember".

import { useState } from "react";

import { requestOriginPermission } from "./host-permissions.js";
import { acceptWords, type RoomOfferConsentView } from "./room-offers-policy.js";
import { Did } from "./ui.js";

function originHost(o: string): string {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
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

const primary: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 700,
  border: "none",
  borderRadius: 8,
  color: "var(--w-accent-ink)",
  background: "var(--w-accent)",
  cursor: "pointer",
};

function until(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function OfferConsent({ view, decide }: { view: RoomOfferConsentView; decide: (approved: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);

  async function allow(): Promise<void> {
    // The permission request must be the first await in the click, or the
    // gesture is spent (`host-permissions.ts`).
    const granted = await requestOriginPermission(view.needsOrigin!).catch(() => false);
    if (!granted) {
      setError(`The wallet needs to reach ${originHost(view.needsOrigin!)} to read this community's offers.`);
      return;
    }
    decide(true);
  }

  if (view.needsOrigin) {
    // Nothing has been read from the community yet, so there is no offer to
    // show: this window only lets the wallet ask. The offer itself is shown
    // in the next one, before anything is accepted.
    return (
      <>
        <strong style={{ fontSize: 14 }}>Let the wallet read this community's offers?</strong>
        <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
          {view.origin ? `${originHost(view.origin)} asks you to accept a room offered by ` : "To accept a room offered by "}
          <Did value={view.communityDid} />, the wallet needs to reach {originHost(view.needsOrigin)}, where the
          community takes requests. Nothing is accepted yet: the offer is shown to you next.
        </div>
        {error && <div style={{ color: "var(--w-danger)" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={() => void allow()} style={primary}>
            Allow {originHost(view.needsOrigin)}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <strong style={{ fontSize: 14 }}>{view.resume ? "Finish joining this room?" : "Join this room?"}</strong>
      <div style={{ color: "var(--w-muted)", lineHeight: 1.45 }}>
        {view.origin ? <>{originHost(view.origin)} asks you to accept </> : <>Accept </>}
        an offer from <Did value={view.communityDid} />. {acceptWords(view.visibility)}
        {view.resume ? " An earlier accept of this offer did not finish; this finishes it, with the same key package." : ""}
      </div>
      <div>
        <div style={label}>Room</div>
        <div style={card}>
          {view.label ? (
            <div style={{ fontWeight: 600, marginBottom: 4, wordBreak: "break-word" }} title="The name the community gave it">
              {view.label}
            </div>
          ) : null}
          <Did value={view.roomId} />
          <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 4 }}>
            {view.visibility} room · you may {view.actions.join(", ") || "—"} · offer valid until {until(view.validUntil)}
          </div>
        </div>
      </div>
      <div>
        <div style={label}>You join as</div>
        <div style={card}>
          <Did value={view.member} />
          <div style={{ fontSize: 11, color: "var(--w-muted)", marginTop: 4 }}>
            The identity you sign in to this community with, held by your agent. It signs the acceptance; the
            community sees it, and nothing of this wallet.
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button autoFocus onClick={() => decide(false)} style={{ padding: "8px 16px", fontSize: 13 }}>
          Not now
        </button>
        <button onClick={() => decide(true)} style={primary}>
          {view.resume ? "Finish joining" : "Accept and join"}
        </button>
      </div>
    </>
  );
}
