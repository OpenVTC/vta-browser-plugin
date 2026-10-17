// A community's offers of its rooms, as the wallet shows and accepts them —
// the rules, with no `chrome.*`, so each is tested as it runs.
//
// A community that owns a room offers its members admission
// (`vtc/rooms/community/members/add`), and the member takes it up with
// `vtc/rooms/offers/{list,accept}/0.1`, signed as the DID the offer is addressed
// to by their own VTA (`rooms/keys/act/0.5`). The CLI does it with
// `pnm rooms offers list|accept`; the wallet does the same, from its console's
// Data rooms page and from the community's own member portal.
//
// ## Where offers come from: the communities the member signs in to
//
// Nothing tells the wallet which communities have offered it something. What it
// does know is where the member signs in: each `didSelfIssued` vault entry names
// the identity used (`principalDid`) and the community (`targets[].did`). That
// pair — community, member — is exactly what an offer is addressed by, so it is
// the whole of what is asked: never a community the member does not sign in to,
// never an identity they do not use there, and **never the community's own
// DID**, which a VTA may also hold (an administrator's agent holds the
// community's place in a room it owns) and which is not the member.
//
// ## What a page may see
//
// The member portal is the community's own page, and the offers it would show
// are the community's own to that member — so the portal may list them, through
// the wallet, as views the wallet built: the room, its label and tier, the
// actions, the dates. Never an offer's credentials. Accepting is the member's
// decision in the wallet's own window; the page only asks.

/**
 * The code of a party that makes no room offers: it advertises no
 * `TrustTaskHTTPS` service, or answers `vtc/rooms/offers/list` with
 * `unsupportedType` / `unsupportedVersion` (a DID-hosting service the member
 * signs in to, a community without rooms). Every party the member signs in to
 * is a source, so this is the ordinary answer of most of them — nothing the
 * member can act on, and never shown as an error.
 */
export const NO_ROOM_OFFERS = "noRoomOffers";

/** A `didSelfIssued` vault entry, as much of one as the sources need (`membersAt` reads the same). */
export interface SignInVaultEntryLike {
  secretKind: string;
  principalDid?: string;
  targets: ReadonlyArray<{ kind: string; did?: string }>;
}

/** One community the member signs in to, and the identities they use there. */
export interface OfferSource {
  communityDid: string;
  members: string[];
}

/**
 * Every (community, member) pair the wallet's sign-in entries name, grouped by
 * community. A member that is the community's own DID is dropped.
 */
export function offerSources(entries: readonly SignInVaultEntryLike[]): OfferSource[] {
  const by = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.secretKind !== "didSelfIssued") continue;
    const member = e.principalDid;
    if (typeof member !== "string" || !member.startsWith("did:")) continue;
    for (const t of e.targets) {
      if (t.kind !== "did" || typeof t.did !== "string" || !t.did.startsWith("did:")) continue;
      if (t.did === member) continue;
      if (!by.has(t.did)) by.set(t.did, new Set());
      by.get(t.did)!.add(member);
    }
  }
  return [...by].map(([communityDid, members]) => ({ communityDid, members: [...members] }));
}

/** Whether the wallet would ask `communityDid` for offers as `member`. */
export function isOfferSource(sources: readonly OfferSource[], communityDid: string, member: string): boolean {
  return member !== communityDid && sources.some((s) => s.communityDid === communityDid && s.members.includes(member));
}

/**
 * Where one room stands, as every surface shows it — the community's record
 * (`vtc/rooms/memberships/list`) beside the VTA's custody (`rooms/keys/list`):
 * `@openvtc/pnm-core/rooms`'s `roomStanding`. The portal, `pnm` and OpenVTC read
 * the same two records, so a room accepted in one shows the same in all of them.
 */
export type OfferStanding = "offered" | "joined" | "unfinished" | "needsReadmission" | "removed";

/** One room the community offered the member, as the wallet shows it: no credential, ever. */
export interface OfferView {
  communityDid: string;
  /** The identity the offer is addressed to, which accepting joins as. */
  member: string;
  roomId: string;
  /** The room's label, trimmed and bounded; `""` when it has none. */
  label: string;
  visibility: string;
  actions: string[];
  validUntil: string;
  offeredAt: string;
  /** The room's description, as its administrators wrote it, made safe to show; absent when it has none. */
  description?: string;
  admittedAt?: string;
  removedAt?: string;
  /** While a sealed room's acceptance can still be finished, from any surface. */
  repeatAcceptUntil?: string;
  state: OfferStanding;
}

/**
 * A room the member can still act on: an offer, or an acceptance begun anywhere
 * — here, in `pnm`, in OpenVTC — that accepting again finishes.
 */
export function isActionable(o: Pick<OfferView, "state">): boolean {
  return o.state === "offered" || o.state === "unfinished";
}

/** How many offers wait for the member — what the badge counts. */
export function openOfferCount(offers: readonly Pick<OfferView, "state">[]): number {
  return offers.filter(isActionable).length;
}

/** The longest label the wallet shows. */
export const OFFER_LABEL_MAX = 200;

/** A label as the community sent it, made safe to show: trimmed, bounded, shown and never interpreted. */
export function offerLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return [...raw.trim()].slice(0, OFFER_LABEL_MAX).join("");
}

/** The longest description the wallet shows (the schema's own bound). */
export const OFFER_DESCRIPTION_MAX = 1000;

/** A room's description as the community sent it, made safe to show; `undefined` when it has none. */
export function offerDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = [...raw.trim()].slice(0, OFFER_DESCRIPTION_MAX).join("");
  return text === "" ? undefined : text;
}

/** What accepting does, in the member's words — the confirm window and the console both say it. */
export function acceptWords(visibility: string): string {
  return visibility === "open"
    ? "The room is open: accepting records that you took up the offer. Your agent stores the room's membership " +
        "and authority credentials, so you can read and write there as this identity."
    : "Your agent stores the room's membership and authority credentials, makes a key package for you, and " +
        "joins the room's encrypted group with the Welcome the community sends back. Its members will see this " +
        "identity join. The room's keys stay in your agent.";
}

/** What the confirm window shows for one accept. Stored in session storage under the consent id. */
export interface RoomOfferConsentView {
  kind: "offer";
  /** The page that asked, when a portal asked; absent when the member clicked in the wallet's console. */
  origin?: string;
  communityDid: string;
  member: string;
  roomId: string;
  label: string;
  visibility: string;
  actions: string[];
  validUntil: string;
  /** What the room is for, as the community wrote it (bounded text); absent when it said nothing. */
  description?: string;
  /** An acceptance begun somewhere — here or on another surface — and not finished: this finishes it. */
  resume: boolean;
  /** The community's Trust-Task origin, when the wallet may not reach it yet: asked for in the click. */
  needsOrigin?: string;
}

/** A room the community offered, as the community's portal page may see it. */
export interface PageOfferView {
  roomId: string;
  member: string;
  label: string;
  visibility: string;
  actions: string[];
  validUntil: string;
  offeredAt: string;
  description?: string;
  admittedAt?: string;
  removedAt?: string;
  repeatAcceptUntil?: string;
  state: OfferStanding;
}

/** Member by member: nothing of the community's answer rides along. */
export function pageOfferView(o: OfferView): PageOfferView {
  return {
    roomId: o.roomId,
    member: o.member,
    label: o.label,
    visibility: o.visibility,
    actions: [...o.actions],
    validUntil: o.validUntil,
    offeredAt: o.offeredAt,
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...(o.admittedAt !== undefined ? { admittedAt: o.admittedAt } : {}),
    ...(o.removedAt !== undefined ? { removedAt: o.removedAt } : {}),
    ...(o.repeatAcceptUntil !== undefined ? { repeatAcceptUntil: o.repeatAcceptUntil } : {}),
    state: o.state,
  };
}

/**
 * The offer of `roomId` a portal's accept means: the one to `member` when the
 * page named one, else the only actionable one. Two identities with an offer of
 * one room and no `member` is refused: the wallet does not choose who joins.
 */
export function pickOffer(
  offers: readonly OfferView[],
  roomId: string,
  member?: string,
): { ok: true; offer: OfferView } | { ok: false; error: string } {
  const forRoom = offers.filter((o) => o.roomId === roomId && isActionable(o) && (member === undefined || o.member === member));
  if (forRoom.length === 1) return { ok: true, offer: forRoom[0]! };
  if (forRoom.length === 0) {
    return { ok: false, error: "There is no open offer of that room to you here, and nothing to finish." };
  }
  return {
    ok: false,
    error: "That room is offered to more than one identity you use here: name the one to join as (member).",
  };
}
