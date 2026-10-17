// A community's offers of its rooms, on the console's Data rooms page.
//
// A community that owns a room offers its members admission; until now a member
// took one up only with `pnm rooms offers list|accept`. This lists the offers of
// every community the member signs in to with the wallet (by the wallet's own
// sign-in record), as each identity they use there, and accepts one — after
// the member confirms it in the wallet's own window, which names the community,
// the room, the identity it joins as and what accepting does.
//
// The console sends intents only (`RUNTIME_ROOM_OFFERS`). The background
// decides and raises the window; the offscreen document does the work, as the
// CLI does it (`room-offers-offscreen.ts`). Nothing here sees an offer's
// credentials, a key package or a Welcome.
//
// The list is read when the page opens and every five minutes while it stays
// open; the background reads one community's offers to one identity at most
// once a minute whatever asks.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  RUNTIME_ROOM_OFFERS,
  type OfferAcceptedView,
  type OffersOverview,
  type RuntimeRoomOffersResponse,
} from "../../bridge-protocol.js";
import { requestOriginPermission } from "../../host-permissions.js";
import { isActionable, type OfferView } from "../../room-offers-policy.js";
import { sendToBackground } from "../../send-message.js";
import { Button, Did, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";

/** How often an open console reads the offers again. */
export const OFFERS_POLL_MS = 5 * 60 * 1000;

function host(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function short(did: string): string {
  return did.length > 44 ? `${did.slice(0, 22)}…${did.slice(-14)}` : did;
}

function day(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString();
}

const offerKey = (o: Pick<OfferView, "communityDid" | "member" | "roomId">) => `${o.communityDid}|${o.member}|${o.roomId}`;

/** What happened to one accept, in words. */
function acceptedWords(r: OfferAcceptedView): string {
  if (r.joined) {
    return `Joined${r.epoch !== undefined ? ` at room epoch ${r.epoch}` : ""}${r.resumed ? " (finished an earlier accept)" : ""}. Your agent holds the room's keys now: it is listed below.`;
  }
  return "Accepted. The room is open, so there is no group to join: your agent holds its credentials.";
}

export function RoomOffers({ onAccepted }: { onAccepted?: () => void }) {
  const [overview, setOverview] = useState<OffersOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, { ok: boolean; text: string }>>({});
  const live = useRef(true);

  const load = useCallback(async (force = false) => {
    try {
      const res = await sendToBackground<RuntimeRoomOffersResponse>({
        type: RUNTIME_ROOM_OFFERS,
        params: { op: "overview", ...(force ? { force: true } : {}) },
      });
      if (!live.current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setOverview(res.result as OffersOverview);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => void load(), OFFERS_POLL_MS);
    // Under Node (the render tests) a pending interval would hold the process
    // open; a browser's timer id has no `unref` and this does nothing there.
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [load]);

  async function allow(origin: string): Promise<void> {
    // The permission request must be the first await in the click, or the
    // gesture is spent (`host-permissions.ts`).
    const granted = await requestOriginPermission(origin).catch(() => false);
    if (granted) await load(true);
    else setError(`The wallet was not allowed to reach ${host(origin)}, so it cannot read that community's offers.`);
  }

  async function accept(o: OfferView): Promise<void> {
    const k = offerKey(o);
    setBusy(k);
    setOutcome((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });
    try {
      const res = await sendToBackground<RuntimeRoomOffersResponse>({
        type: RUNTIME_ROOM_OFFERS,
        params: { op: "accept", communityDid: o.communityDid, member: o.member, roomId: o.roomId },
      });
      if (!live.current) return;
      if (res.ok) {
        setOutcome((prev) => ({ ...prev, [k]: { ok: true, text: acceptedWords(res.result as OfferAcceptedView) } }));
        onAccepted?.();
      } else {
        setOutcome((prev) => ({
          ...prev,
          [k]: { ok: false, text: res.code === "declined" ? "Not accepted. The offer stays open." : res.error },
        }));
      }
      await load(true);
    } catch (e) {
      if (live.current) setOutcome((prev) => ({ ...prev, [k]: { ok: false, text: e instanceof Error ? e.message : String(e) } }));
    } finally {
      if (live.current) setBusy(null);
    }
  }

  const communities = overview?.communities ?? [];
  return (
    <Panel
      title={`Offers${overview && overview.openCount > 0 ? ` (${overview.openCount})` : ""}`}
      description="Rooms the communities you sign in to have offered you. Accepting joins the room as the identity the
        offer is addressed to; you confirm each one in the wallet's own window first."
    >
      {error && <Note tone="danger">Offers could not be read: {error}</Note>}
      {overview === null ? (
        error ? null : <div style={{ fontSize: t.sm, color: c.muted }}>Reading offers…</div>
      ) : communities.length === 0 ? (
        <Note>
          You do not sign in to any community with this wallet yet, so there is nobody to ask for offers. Sign in to a
          community's member portal with the wallet, and its offers appear here.
        </Note>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {communities.map((cv) => {
            const offers = cv.members.flatMap((m) => m.offers);
            return (
              <div key={cv.communityDid} style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: t.sm, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ color: c.muted }}>From</span>
                  <Did value={cv.communityDid} />
                </div>
                {cv.error && <Note tone="danger">The wallet could not find where this community takes requests: {cv.error}</Note>}
                {!cv.reachable && cv.endpointOrigin && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: t.sm, color: c.muted }}>
                      The wallet may not reach {host(cv.endpointOrigin)} yet, so it has not asked this community.
                    </span>
                    <Button onClick={() => void allow(cv.endpointOrigin!)}>Allow {host(cv.endpointOrigin)}</Button>
                  </div>
                )}
                {cv.members
                  .filter((m) => m.error)
                  .map((m) => (
                    <Note key={m.member} tone="danger">
                      As <code title={m.member}>{short(m.member)}</code>: {m.error}
                    </Note>
                  ))}
                {cv.reachable && offers.length === 0 && cv.members.every((m) => !m.error) && (
                  <div style={{ fontSize: t.sm, color: c.muted }}>No offers from this community.</div>
                )}
                {offers.map((o) => {
                  const k = offerKey(o);
                  const result = outcome[k];
                  return (
                    <div
                      key={k}
                      style={{
                        border: `1px solid ${c.line}`,
                        borderRadius: "var(--w-r-sm)",
                        padding: "8px 10px",
                        display: "grid",
                        gap: 4,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                          {o.label !== "" && (
                            <span style={{ fontSize: t.sm, fontWeight: 600, wordBreak: "break-word" }} title="The name the community gave it">
                              {o.label}
                            </span>
                          )}
                          <code style={{ fontFamily: font.mono, fontSize: t.xs, wordBreak: "break-all", color: c.muted }}>
                            {o.roomId}
                          </code>
                          <span style={{ fontSize: t.xs, color: c.muted }}>
                            {o.visibility} · {o.actions.join(", ")} · valid until {day(o.validUntil)} · as{" "}
                            <code title={o.member}>{short(o.member)}</code>
                            {o.state === "accepted" && !o.inProgress ? " · accepted" : ""}
                            {o.inProgress ? " · an accept began here and did not finish" : ""}
                          </span>
                        </div>
                        {isActionable(o) && (
                          <Button kind="primary" disabled={busy !== null} onClick={() => void accept(o)}>
                            {busy === k ? "Confirm in the wallet window…" : o.inProgress ? "Finish accepting" : "Accept"}
                          </Button>
                        )}
                      </div>
                      {result && (
                        <div style={{ fontSize: t.sm, color: result.ok ? c.ok : c.danger }}>{result.text}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
