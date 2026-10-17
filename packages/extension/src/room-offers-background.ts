// A community's offers of its rooms — the background's half.
//
// Two callers, one rule set:
//
//   - **The console** (an extension page, gated on `sender.url` before this is
//     reached) lists the offers of every community the member signs in to, and
//     accepts one.
//   - **The community's own member portal** (through `RoomPageGates`, which has
//     already held the page to the origin of the community's verified
//     `SignInPortal`) lists that community's offers to the identities the
//     member uses there, and asks to accept one.
//
// Either way an accept runs only after the member confirms it in the wallet's
// own window — which names the community, the room, the identity it joins as
// and what accepting does — and the work runs in the offscreen document. The
// page never sees an offer's credentials, a key package or a Welcome.
//
// Reading is bounded: one community's offers to one identity are read at most
// once a minute (a forced refresh, every ten seconds), and the console polls
// every few minutes while it is open. This module imports no `rooms/*` task:
// the background bundle must name none (CI checks), so the work is the
// offscreen document's.
//
// Written against injected dependencies, not `chrome.*`, so it is tested as it runs.

import type {
  OfferAcceptedView,
  OffersCommunityView,
  OffersOverview,
  OffscreenRoomOffersOp,
  OffscreenRoomOffersResponse,
} from "./bridge-protocol.js";
import {
  isOfferSource,
  NO_ROOM_OFFERS,
  openOfferCount,
  pageOfferView,
  pickOffer,
  type OfferSource,
  type OfferView,
  type PageOfferView,
  type RoomOfferConsentView,
} from "./room-offers-policy.js";

/** The active VTA connection, as the background reads it. */
export interface OffersVta {
  vtaDid: string;
  restBaseUrl?: string;
}

export interface RoomOffersDeps {
  active(): Promise<{ ok: true; vta: OffersVta } | { ok: false; error: string }>;
  offscreen(vta: OffersVta, op: OffscreenRoomOffersOp): Promise<OffscreenRoomOffersResponse>;
  /** Whether the wallet holds a host permission for `url`'s origin. */
  canReach(url: string): Promise<boolean>;
  /** Raise the accept window and wait. A closed window is a refusal. */
  prompt(view: RoomOfferConsentView): Promise<{ approved: boolean }>;
  /** Remember the room names an offer listing carried (`room-names:`), for the rooms panes. */
  rememberNames?(vtaDid: string, communityDid: string, names: Record<string, { label: string; visibility?: string }>): Promise<void>;
  /** The badge's count of offers waiting. */
  setOpenCount?(vtaDid: string, count: number): Promise<void>;
  now(): number;
}

/** A refusal with the stable code the core or the gate gave it (R3.7). */
export class RoomOffersRefusal extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RoomOffersRefusal";
  }
}

/** How long one community's offers to one identity stand before they are read again. */
export const OFFERS_LIST_INTERVAL_MS = 60 * 1000;
/** The floor a forced refresh still respects. */
export const OFFERS_FORCE_INTERVAL_MS = 10 * 1000;
/** How long a community's resolved endpoint stands. */
const ENDPOINT_CACHE_MS = 5 * 60 * 1000;

type Listed = { at: number; offers: OfferView[] } | { at: number; error: string; code?: string };

export class RoomOffers {
  private readonly endpoints = new Map<string, { endpoint?: string; error?: string; code?: string; at: number }>();
  private readonly lists = new Map<string, Listed>();
  private readonly accepting = new Set<string>();

  constructor(private readonly deps: RoomOffersDeps) {}

  private async offscreen(vta: OffersVta, op: OffscreenRoomOffersOp): Promise<unknown> {
    const res = await this.deps.offscreen(vta, op);
    if (!res.ok) throw new RoomOffersRefusal(res.error, res.code);
    return res.result;
  }

  private async vta(): Promise<OffersVta> {
    const active = await this.deps.active();
    if (!active.ok) throw new RoomOffersRefusal(active.error);
    return active.vta;
  }

  private async endpoint(vta: OffersVta, communityDid: string): Promise<{ endpoint?: string; error?: string; code?: string }> {
    const now = this.deps.now();
    const hit = this.endpoints.get(communityDid);
    if (hit && now - hit.at < ENDPOINT_CACHE_MS) return hit;
    let got: { endpoint?: string; error?: string; code?: string };
    try {
      got = { endpoint: ((await this.offscreen(vta, { op: "endpoint", communityDid })) as { endpoint: string }).endpoint };
    } catch (e) {
      got = {
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof RoomOffersRefusal && e.code ? { code: e.code } : {}),
      };
    }
    this.endpoints.set(communityDid, { ...got, at: now });
    return got;
  }

  private key(vta: OffersVta, communityDid: string, member: string): string {
    return `${vta.vtaDid}|${communityDid}|${member}`;
  }

  /** One community's offers to one identity, read at most once per interval. */
  private async listed(vta: OffersVta, communityDid: string, member: string, force: boolean): Promise<Listed> {
    const now = this.deps.now();
    const k = this.key(vta, communityDid, member);
    const hit = this.lists.get(k);
    const floor = force ? OFFERS_FORCE_INTERVAL_MS : OFFERS_LIST_INTERVAL_MS;
    if (hit && now - hit.at < floor) return hit;
    let next: Listed;
    try {
      const offers = (await this.offscreen(vta, { op: "list", communityDid, member })) as OfferView[];
      next = { at: now, offers };
      const names: Record<string, { label: string; visibility?: string }> = {};
      for (const o of offers) if (o.label !== "") names[o.roomId] = { label: o.label, visibility: o.visibility };
      if (Object.keys(names).length > 0) await this.deps.rememberNames?.(vta.vtaDid, communityDid, names).catch(() => {});
    } catch (e) {
      next = {
        at: now,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof RoomOffersRefusal && e.code ? { code: e.code } : {}),
      };
    }
    this.lists.set(k, next);
    return next;
  }

  /** Every community the member signs in to, and its offers to each identity used there. */
  async overview(opts: { force?: boolean } = {}): Promise<OffersOverview> {
    const vta = await this.vta();
    const sources = (await this.offscreen(vta, { op: "sources" })) as OfferSource[];
    const communities: OffersCommunityView[] = [];
    // Parties the member signs in to that make no room offers (a DID-hosting
    // service, a community without rooms): left off the card, since there is
    // nothing there for the member to see or do.
    const noOffers: string[] = [];
    for (const s of sources) {
      const ep = await this.endpoint(vta, s.communityDid);
      if (!ep.endpoint && ep.code === NO_ROOM_OFFERS) {
        noOffers.push(s.communityDid);
        continue;
      }
      if (!ep.endpoint) {
        communities.push({ communityDid: s.communityDid, reachable: false, error: ep.error ?? "no endpoint", members: [] });
        continue;
      }
      const endpointOrigin = new URL(ep.endpoint).origin;
      // Nothing is read from a community the member has not let the wallet reach.
      if (!(await this.deps.canReach(ep.endpoint))) {
        communities.push({ communityDid: s.communityDid, endpointOrigin, reachable: false, members: [] });
        continue;
      }
      const members: OffersCommunityView["members"] = [];
      for (const member of s.members) {
        const l = await this.listed(vta, s.communityDid, member, opts.force === true);
        if ("error" in l && l.code === NO_ROOM_OFFERS) continue;
        members.push("offers" in l ? { member, offers: l.offers } : { member, offers: [], error: l.error, ...(l.code ? { code: l.code } : {}) });
      }
      // Every identity was told the party makes no room offers: the party is
      // not a community with rooms. A community that serves offers and failed
      // for one identity keeps its error.
      if (members.length === 0 && s.members.length > 0) {
        noOffers.push(s.communityDid);
        continue;
      }
      communities.push({ communityDid: s.communityDid, endpointOrigin, reachable: true, members });
    }
    const openCount = openOfferCount(communities.flatMap((c) => c.members.flatMap((m) => m.offers)));
    await this.deps.setOpenCount?.(vta.vtaDid, openCount).catch(() => {});
    return { vtaDid: vta.vtaDid, communities, noOffers, openCount, readAt: new Date(this.deps.now()).toISOString() };
  }

  /**
   * One community's offers to the identities the member uses there, for its
   * own portal page. `members` is the wallet's record of those identities
   * (never the page's word), without the community's own DID. A member whose
   * offers could not be read contributes nothing; a community the wallet may
   * not reach yet shows none.
   */
  async forPortal(vta: OffersVta, hostDid: string, members: readonly string[]): Promise<{ offers: PageOfferView[]; needsOrigin?: string }> {
    const ep = await this.endpoint(vta, hostDid);
    // A party that takes no room requests has no offers to show: an empty list, not a refusal.
    if (!ep.endpoint && ep.code === NO_ROOM_OFFERS) return { offers: [] };
    if (!ep.endpoint) throw new RoomOffersRefusal(`the wallet could not find where ${hostDid} takes requests`);
    if (!(await this.deps.canReach(ep.endpoint))) return { offers: [], needsOrigin: new URL(ep.endpoint).origin };
    const offers: PageOfferView[] = [];
    for (const member of new Set(members)) {
      if (member === hostDid) continue;
      const l = await this.listed(vta, hostDid, member, false);
      if ("offers" in l) offers.push(...l.offers.map(pageOfferView));
    }
    return { offers };
  }

  /**
   * Accept one offer, once the member confirms it. `origin` is the portal page
   * that asked (browser-attested), absent when the member clicked in the
   * console. `members` restricts who may be joined as (the portal's identities
   * at that community); the console's caller is checked against the wallet's
   * sign-in record instead.
   */
  async accept(req: {
    communityDid: string;
    roomId: string;
    member?: string;
    origin?: string;
    vta?: OffersVta;
    members?: readonly string[];
  }): Promise<OfferAcceptedView> {
    const vta = req.vta ?? (await this.vta());
    let members = req.members;
    if (!members) {
      const sources = (await this.offscreen(vta, { op: "sources" })) as OfferSource[];
      if (req.member === undefined || !isOfferSource(sources, req.communityDid, req.member)) {
        throw new RoomOffersRefusal(`${req.member ?? "(no identity)"} is not an identity you sign in to ${req.communityDid} with`);
      }
      members = [req.member];
    }
    members = members.filter((m) => m !== req.communityDid);

    const ep = await this.endpoint(vta, req.communityDid);
    if (!ep.endpoint) {
      throw new RoomOffersRefusal(ep.error ?? `the wallet could not find where ${req.communityDid} takes requests`, ep.code);
    }
    const reach = await this.deps.canReach(ep.endpoint);

    // The offer as the community lists it now, so the window shows what is accepted.
    const offers: OfferView[] = [];
    if (reach) {
      for (const m of members) {
        if (req.member !== undefined && m !== req.member) continue;
        const l = await this.listed(vta, req.communityDid, m, true);
        if ("offers" in l) offers.push(...l.offers);
        else if (req.member !== undefined) throw new RoomOffersRefusal(l.error, l.code);
      }
    }
    if (!reach) {
      // Not read yet: the window asks for the origin in its click, then it is read.
      const view = await this.deps.prompt({
        kind: "offer",
        ...(req.origin !== undefined ? { origin: req.origin } : {}),
        communityDid: req.communityDid,
        member: req.member ?? members[0] ?? "",
        roomId: req.roomId,
        label: "",
        visibility: "",
        actions: [],
        validUntil: "",
        resume: false,
        needsOrigin: new URL(ep.endpoint).origin,
      });
      if (!view.approved) throw new RoomOffersRefusal("the member did not allow the wallet to reach the community", "declined");
      return this.accept({ ...req, vta, members });
    }
    const picked = pickOffer(offers, req.roomId, req.member);
    if (!picked.ok) throw new RoomOffersRefusal(picked.error, "noOffer");
    const offer = picked.offer;

    const k = `${this.key(vta, offer.communityDid, offer.member)}|${offer.roomId}`;
    if (this.accepting.has(k)) throw new RoomOffersRefusal("this offer is being accepted already", "busy");
    this.accepting.add(k);
    try {
      const decision = await this.deps.prompt({
        kind: "offer",
        ...(req.origin !== undefined ? { origin: req.origin } : {}),
        communityDid: offer.communityDid,
        member: offer.member,
        roomId: offer.roomId,
        label: offer.label,
        visibility: offer.visibility,
        actions: offer.actions,
        validUntil: offer.validUntil,
        resume: offer.inProgress,
      });
      if (!decision.approved) throw new RoomOffersRefusal("the member declined the offer here; it stays open", "declined");
      try {
        const result = (await this.offscreen(vta, {
          op: "accept",
          communityDid: offer.communityDid,
          member: offer.member,
          roomId: offer.roomId,
        })) as OfferAcceptedView;
        return result;
      } finally {
        // Whatever happened, the next listing reads afresh.
        this.lists.delete(this.key(vta, offer.communityDid, offer.member));
      }
    } finally {
      this.accepting.delete(k);
    }
  }
}
