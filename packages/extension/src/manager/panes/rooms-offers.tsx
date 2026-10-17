// A community's offers of its rooms, on the console's Data rooms page.
//
// A community that owns a room offers its members admission; until now a member
// took one up only with `pnm rooms offers list|accept`. This reads the offers of
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
// `rooms-communities.tsx` draws them, each beside the room it became and the
// portal it is shared with.
//
// A party the member signs in to that makes no room offers — a DID-hosting
// service, a community without rooms (`noOffers`) — is left off the view: it is
// not a failure and there is nothing to do about it. A community that does
// serve offers and failed keeps its error, named as whoever produced it.
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
import type { OfferView } from "../../room-offers-policy.js";
import { sendToBackground } from "../../send-message.js";

/** How often an open console reads the offers again. */
export const OFFERS_POLL_MS = 5 * 60 * 1000;

export function host(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function short(did: string): string {
  return did.length > 44 ? `${did.slice(0, 22)}…${did.slice(-14)}` : did;
}

export function day(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString();
}

export const offerKey = (o: Pick<OfferView, "communityDid" | "member" | "roomId">) => `${o.communityDid}|${o.member}|${o.roomId}`;

/** What happened to one accept, in words. */
export function acceptedWords(r: OfferAcceptedView): string {
  if (r.joined) {
    return `Joined${r.epoch !== undefined ? ` at room epoch ${r.epoch}` : ""}${r.resumed ? " (finished an earlier accept)" : ""}. Your agent holds the room's keys now: it is in your rooms.`;
  }
  return "Accepted. The room is open, so there is no group to join: your agent holds its credentials.";
}

/** One offer's last accept, in words, keyed by `offerKey`. */
export type OfferOutcomes = Record<string, { ok: boolean; text: string }>;

export interface RoomOffersState {
  overview: OffersOverview | null;
  error: string | null;
  /** The offer an accept is running for, by `offerKey`. */
  busy: string | null;
  outcome: OfferOutcomes;
  accept: (o: OfferView) => Promise<void>;
  /** Ask for the host permission a community's endpoint needs. The first await in the click. */
  allow: (origin: string) => Promise<void>;
}

/**
 * The offers, read when the console opens and every five minutes while it
 * stays open, and accepting one. Owned by the pane rather than the tab that
 * draws it: its open count is the tab's badge, whichever tab is showing.
 */
export function useRoomOffers({ onAccepted }: { onAccepted?: () => void } = {}): RoomOffersState {
  const [overview, setOverview] = useState<OffersOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OfferOutcomes>({});
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

  const allow = useCallback(
    async (origin: string): Promise<void> => {
      // The permission request must be the first await in the click, or the
      // gesture is spent (`host-permissions.ts`).
      const granted = await requestOriginPermission(origin).catch(() => false);
      if (granted) await load(true);
      else setError(`The wallet was not allowed to reach ${host(origin)}, so it cannot read that community's offers.`);
    },
    [load],
  );

  const accept = useCallback(
    async (o: OfferView): Promise<void> => {
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
        if (live.current) {
          setOutcome((prev) => ({ ...prev, [k]: { ok: false, text: e instanceof Error ? e.message : String(e) } }));
        }
      } finally {
        if (live.current) setBusy(null);
      }
    },
    [load, onAccepted],
  );

  return { overview, error, busy, outcome, accept, allow };
}
