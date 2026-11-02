// A page's `window.vtaWallet.elections.*` — the background's half.
//
// A community's portal lists and shows its elections and asks the wallet to
// take the member's ticket or to vote (VTI-VOT-020 – 053). The portal is the
// community's own code and knows who is signed in, and the community is never
// trusted to learn how anyone voted or to link a ticket to a cast
// (verifiable-trust-infrastructure `community-voting-threat-model.md`). So:
//
// - **A ballot is filled in only in the wallet's own window.** The page gets
//   no choice, no cast, no receipt — and, from `vote`, not even whether a vote
//   was cast: only that the member answered the wallet's window, and whether a
//   ticket had to be taken first (which the community knows anyway). The same
//   window stays open and shows the cast step by step until the ballot box's
//   receipt is kept (`CastProgress`), and this wallet remembers that the member
//   voted — when, and how the ballot box answered, never a choice — so the next
//   ballot window can say so. The page is never told either.
// - **The cast never passes the community.** The member's VTA builds and signs
//   it under a key made for that cast alone, and the wallet posts it to the
//   ballot box's HTTPS door after a random pause (`elections-page-offscreen.ts`).
// - **Ticket and vote are apart in time.** The community knows when it issued a
//   ticket and the ballot box when a cast arrived; a vote asked for with no
//   ticket held takes the ticket and stops, and a ballot window opened soon
//   after a ticket says so.
//
// Every call passes these, in this order, before the member's agent is asked
// anything:
//
//   1. **The call is well formed** (`electionsPageParamsRefusal`).
//   2. **The page is the community's portal**: its browser-attested origin is
//      the origin of `hostDid`'s verified `SignInPortal`, and the wallet may
//      reach the community's endpoint.
//   3. **The member is the wallet's**: one of the identities the member signs
//      in with at this community, never one the page names that the wallet
//      does not hold.
//   4. For a ticket or a vote, **the person decides** in the wallet's window. A
//      closed window is a refusal.
//
// Written against injected dependencies, not `chrome.*`, so the gates are
// tested as they run.

import { ballotRefusal, castDelayMs, type ElectionBallot, type ElectionManifest, type ElectionShown } from "@openvtc/pnm-core/vtc";

import type {
  ElectionsPageOp,
  OffscreenElectionsPageOp,
  OffscreenElectionsPageResponse,
  PageElection,
  PageElectionQuestion,
  PageElectionView,
  PageTicketView,
  PageVoteView,
  RuntimeElectionsPageResponse,
} from "./bridge-protocol.js";

/** `chrome.storage.session` key prefix for an election window's view. */
export const ELECTION_CONSENT_PREFIX = "election-consent:";

/** `chrome.storage.session` key prefix for a ballot window's cast progress
 *  (`CastProgress`), written by the background as each step starts and ends. */
export const ELECTION_PROGRESS_PREFIX = "election-progress:";

/** A ballot window opened sooner than this after its ticket was taken says so:
 *  the community and the ballot box could pair the two by time. */
export const TICKET_TO_VOTE_GAP_MS = 60 * 60 * 1000;

/** The steps of a cast, in order, as the ballot window shows them. */
export const CAST_STEPS = ["check", "seal", "wait", "send", "receipt"] as const;
export type CastStep = (typeof CAST_STEPS)[number];

/** A vote this wallet cast: when, and how the ballot box answered. Never a choice. */
export interface RememberedVote {
  at: number;
  /** The ballot box's outcome: `replaced` when it replaced an earlier vote. */
  status: string;
  leafIndex?: number;
}

/** How far a cast has got. `wait` carries the pause's end, so the window counts
 *  it down and moves on to `send` when it is over: the post follows the pause
 *  inside one offscreen call. */
export type CastProgress =
  | { phase: "running"; step: CastStep; waitMs?: number; waitUntil?: number }
  | ({ phase: "done"; receiptNotKept?: string } & RememberedVote)
  | { phase: "failed"; step: CastStep; error: string };

/** What the person is shown in the wallet's window. */
export type ElectionConsentView =
  | {
      /** Take the member's ticket. `fromVote`: they asked to vote and hold none yet. */
      kind: "ticket";
      origin: string;
      communityName: string;
      member: string;
      election: PageElectionView;
      fromVote: boolean;
    }
  | {
      /** Fill in the ballot. The manifest and its digest are what the ballot binds to. */
      kind: "ballot";
      origin: string;
      communityName: string;
      member: string;
      election: PageElectionView;
      manifest: ElectionManifest;
      manifestDigest: string;
      /** The ballot box's HTTPS origin: where the wallet sends the cast. */
      boxOrigin: string;
      /** The wallet holds no host permission for `boxOrigin` yet: the window asks first. */
      needsReach: boolean;
      /** When this wallet took the ticket, if it did so recently. */
      ticketTakenAt?: number;
      /** The vote this wallet remembers casting in this election, if any. */
      voted?: RememberedVote;
      /** Whether a new vote would replace it: the election allows it, and voting is open. */
      canRevote: boolean;
    }
  | {
      /** How a vote went, when its ballot window was closed before the end:
       *  only a failure is shown this way (a vote that went in is remembered,
       *  and the next ballot window says so). Never seen by the page. */
      kind: "cast";
      communityName: string;
      electionTitle: string;
      outcome: { ok: true; status: string; leafIndex?: number } | { ok: false; error: string };
    };

/** The active VTA connection, as the background reads it. */
export interface ActiveVta {
  vtaDid: string;
  restBaseUrl?: string;
}

export interface ElectionsPageDeps {
  active(): Promise<{ ok: true; vta: ActiveVta } | { ok: false; error: string }>;
  offscreen(vta: ActiveVta, op: OffscreenElectionsPageOp): Promise<OffscreenElectionsPageResponse>;
  /** Whether the wallet holds a host permission for `url`'s origin. */
  canReach(url: string): Promise<boolean>;
  /** Raise a window and wait for its decision. A closed window is a denial.
   *  `window` names the window, for `progress`; it may still be open. */
  prompt(view: ElectionConsentView): Promise<{ approved: boolean; ballot?: unknown; window?: string }>;
  /** Show a ballot window how its cast is going. `false` once the window is
   *  gone: the cast goes on regardless. */
  progress(window: string, state: CastProgress): Promise<boolean>;
  /** When this wallet last took the ticket for `key`, if it remembers. */
  ticketTakenAt(key: string): Promise<number | undefined>;
  rememberTicket(key: string, at: number): Promise<void>;
  /** The vote this wallet cast for `key`, if it remembers one. */
  votedAt(key: string): Promise<RememberedVote | undefined>;
  rememberVote(key: string, vote: RememberedVote): Promise<void>;
  /** The pause before a cast is posted; defaults to `castDelayMs()`. */
  castDelayMs?(): number;
  now(): number;
}

const MAX_DID = 2048;
const ELECTION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function isDid(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("did:") && v.length <= MAX_DID;
}

/** Why `raw` is not a call this channel serves, or `null`. Members other than
 *  those named are refused, so nothing extra reaches the work. */
export function electionsPageParamsRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "the call must be an object";
  const p = raw as Record<string, unknown>;
  const allowed =
    p.op === "list"
      ? ["op", "hostDid", "member"]
      : p.op === "show" || p.op === "takeTicket" || p.op === "vote"
        ? ["op", "hostDid", "electionId", "member"]
        : null;
  if (!allowed) return "unknown elections operation";
  for (const k of Object.keys(p)) {
    if (!allowed.includes(k)) return `${String(p.op)} takes no \`${k}\``;
  }
  if (!isDid(p.hostDid)) return "hostDid must be a DID";
  if (p.op !== "list" && (typeof p.electionId !== "string" || !ELECTION_ID.test(p.electionId))) {
    return "electionId must be an election identifier";
  }
  if (p.member !== undefined && !isDid(p.member)) return "member must be a DID";
  return null;
}

/** An election as the page may show it: what is asked and how it is run — not
 *  the voting parameters, the trustees' ceremony or the board's checkpoints. */
export function pageElectionViewOf(shown: ElectionShown): PageElectionView {
  const m = shown.manifest;
  const d = shown.disclosure;
  const questions: PageElectionQuestion[] = m.questions.map((q) => {
    const base = {
      key: q.key,
      type: q.type,
      ...(q.text !== undefined ? { text: q.text } : {}),
      optional: q.optional,
      options: q.type === "text" ? [] : q.options.map((o) => ({ key: o.key, ...(o.label !== undefined ? { label: o.label } : {}) })),
    };
    switch (q.type) {
      case "choice":
        return { ...base, minSelections: q.minSelections, maxSelections: q.maxSelections };
      case "ranking":
        return { ...base, partial: q.partial };
      case "score":
        return { ...base, min: q.min, max: q.max };
      default:
        return { ...base, maxLength: q.maxLength };
    }
  });
  return {
    electionId: m.electionId,
    ...(named(m.title) ? { title: m.title } : {}),
    ...(m.description !== undefined ? { description: m.description } : {}),
    state: shown.state,
    secrecy: m.secrecy,
    registrationOpensAt: m.registrationOpensAt,
    votingOpensAt: m.votingOpensAt,
    votingClosesAt: m.votingClosesAt,
    binding: m.binding,
    questions,
    disclosure: {
      ballotBox: d.ballotBox,
      ballotBoxOperator: d.ballotBoxOperator,
      sameOperator: d.sameOperator,
      boardVisibility: d.boardVisibility,
      revote: d.revote,
      auditors: [...d.auditors],
    },
    ...(typeof m.textReleaseThreshold === "number" ? { textReleaseThreshold: m.textReleaseThreshold } : {}),
    ...(shown.ticketsIssued !== undefined ? { ticketsIssued: shown.ticketsIssued } : {}),
    ...(shown.certified ? { certified: { certifiedAt: shown.certified.certifiedAt, result: shown.certified.result } } : {}),
  };
}

/** A title worth showing. The console's manifest builder starts from `title: ""`, and an
 *  empty title would leave the member nothing to recognise the election by; with none, the
 *  page and the wallet's windows name it by its id. */
function named(title: unknown): title is string {
  return typeof title === "string" && title.trim() !== "";
}

function pageElectionOf(e: Record<string, unknown>): PageElection {
  return {
    electionId: String(e.electionId),
    ...(named(e.title) ? { title: e.title } : {}),
    state: String(e.state),
    votingOpensAt: String(e.votingOpensAt),
    votingClosesAt: String(e.votingClosesAt),
    binding: e.binding === true,
    ticketHeld: e.ticketHeld === true,
  };
}

/** Where a ticket's time is remembered: per member, community and election. */
export function ticketKey(hostDid: string, member: string, electionId: string): string {
  return `${hostDid}\n${member}\n${electionId}`;
}

/** How long a community's resolved portal is trusted before it is resolved again. */
const PORTAL_CACHE_MS = 5 * 60 * 1000;

class ElectionsPageRefusal extends Error {}

interface Identity {
  did: string;
  communityName: string;
}

export class ElectionsPageGates {
  private readonly portals = new Map<string, { portalOrigin: string; endpoint: string; at: number }>();
  /** Casts under way, so the background's work outlives the page's call (tests await it). */
  readonly casting = new Set<Promise<void>>();

  constructor(private readonly deps: ElectionsPageDeps) {}

  private async offscreen(vta: ActiveVta, op: OffscreenElectionsPageOp): Promise<unknown> {
    const res = await this.deps.offscreen(vta, op);
    if (!res.ok) throw new ElectionsPageRefusal(res.error);
    return res.result;
  }

  private async portal(vta: ActiveVta, hostDid: string): Promise<{ portalOrigin: string; endpoint: string }> {
    const now = this.deps.now();
    const hit = this.portals.get(hostDid);
    if (hit && now - hit.at < PORTAL_CACHE_MS) return hit;
    const got = (await this.offscreen(vta, { op: "portal", hostDid })) as { portalOrigin: string; endpoint: string };
    this.portals.set(hostDid, { ...got, at: now });
    return got;
  }

  /** One `elections.*` call from a page at `origin` (browser-attested). */
  async handle(origin: string, raw: unknown): Promise<RuntimeElectionsPageResponse> {
    try {
      const malformed = electionsPageParamsRefusal(raw);
      if (malformed) return { ok: false, error: malformed };
      const p = raw as ElectionsPageOp;
      const { vta, who } = await this.gate(origin, p);
      switch (p.op) {
        case "list":
          return { ok: true, result: await this.list(vta, p.hostDid, who) };
        case "show":
          return { ok: true, result: pageElectionViewOf(await this.show(vta, p.hostDid, who, p.electionId)) };
        case "takeTicket":
          return { ok: true, result: await this.takeTicket(origin, vta, p.hostDid, who, p.electionId, false) };
        case "vote":
          return { ok: true, result: await this.vote(origin, vta, p.hostDid, who, p.electionId) };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Gates 2 and 3: the page is the portal, and the identity is the wallet's. */
  private async gate(origin: string, p: ElectionsPageOp): Promise<{ vta: ActiveVta; who: Identity }> {
    const active = await this.deps.active();
    if (!active.ok) throw new ElectionsPageRefusal(active.error);
    const vta = active.vta;
    const { portalOrigin, endpoint } = await this.portal(vta, p.hostDid);
    if (origin !== portalOrigin) {
      throw new ElectionsPageRefusal(
        `${origin} is not ${p.hostDid}'s portal: its DID document names ${portalOrigin}. ` +
          `A page can reach a member's elections only from the portal the community's own DID document names.`,
      );
    }
    if (!(await this.deps.canReach(endpoint))) {
      throw new ElectionsPageRefusal(
        `The wallet may not reach ${new URL(endpoint).origin} yet. Allow it from the wallet's popup, then try again.`,
      );
    }
    const members = ((await this.offscreen(vta, { op: "members", hostDid: p.hostDid })) as Identity[]).filter(
      (m) => m.did !== p.hostDid,
    );
    let who: Identity | undefined;
    if (p.member !== undefined) {
      who = members.find((m) => m.did === p.member);
      if (!who) throw new ElectionsPageRefusal("The wallet holds no such identity for this community.");
    } else if (members.length === 1) {
      who = members[0]!;
    } else {
      throw new ElectionsPageRefusal(
        members.length === 0
          ? "The wallet holds no identity you use at this community."
          : "You use more than one identity at this community: sign in with the one to vote as.",
      );
    }
    return { vta, who };
  }

  private async list(vta: ActiveVta, hostDid: string, who: Identity): Promise<{ elections: PageElection[] }> {
    const listed = (await this.offscreen(vta, { op: "list", hostDid, member: who.did })) as { elections?: unknown[] };
    return { elections: (listed.elections ?? []).map((e) => pageElectionOf(e as Record<string, unknown>)) };
  }

  private async show(vta: ActiveVta, hostDid: string, who: Identity, electionId: string): Promise<ElectionShown> {
    return (await this.offscreen(vta, { op: "show", hostDid, member: who.did, electionId })) as ElectionShown;
  }

  private async takeTicket(
    origin: string,
    vta: ActiveVta,
    hostDid: string,
    who: Identity,
    electionId: string,
    fromVote: boolean,
  ): Promise<PageTicketView> {
    const shown = await this.show(vta, hostDid, who, electionId);
    const decided = await this.deps.prompt({
      kind: "ticket",
      origin,
      communityName: who.communityName,
      member: who.did,
      election: pageElectionViewOf(shown),
      fromVote,
    });
    if (!decided.approved) throw new ElectionsPageRefusal("You did not take a ticket.");
    const got = (await this.offscreen(vta, { op: "takeTicket", hostDid, member: who.did, electionId })) as {
      taken: boolean;
    };
    if (got.taken) await this.deps.rememberTicket(ticketKey(hostDid, who.did, electionId), this.deps.now());
    return { ticketHeld: true, taken: got.taken };
  }

  private async vote(origin: string, vta: ActiveVta, hostDid: string, who: Identity, electionId: string): Promise<PageVoteView> {
    // Whether the community issued the ticket, from the member's own list.
    const listed = await this.list(vta, hostDid, who);
    const mine = listed.elections.find((e) => e.electionId === electionId);
    if (!mine) throw new ElectionsPageRefusal("No such election is open to you at this community.");
    if (!mine.ticketHeld) {
      // Take it and stop: a cast sent straight after its ticket can be paired
      // with it by time (CONVENTIONS §6 item 3).
      await this.takeTicket(origin, vta, hostDid, who, electionId, true);
      return { ticketTaken: true };
    }

    const shown = await this.show(vta, hostDid, who, electionId);
    const { endpoint } = (await this.offscreen(vta, { op: "ballotBox", ballotBox: shown.manifest.ballotBox })) as {
      endpoint: string;
    };
    const key = ticketKey(hostDid, who.did, electionId);
    const takenAt = await this.deps.ticketTakenAt(key);
    const recent = takenAt !== undefined && this.deps.now() - takenAt < TICKET_TO_VOTE_GAP_MS;
    const voted = await this.deps.votedAt(key);
    const election = pageElectionViewOf(shown);
    // No host permission for the ballot box is not a refusal: the window asks
    // for it, from the member's own click (`host-permissions.ts`).
    const decided = await this.deps.prompt({
      kind: "ballot",
      origin,
      communityName: who.communityName,
      member: who.did,
      election,
      manifest: shown.manifest,
      manifestDigest: shown.manifestDigest,
      boxOrigin: new URL(endpoint).origin,
      needsReach: !(await this.deps.canReach(endpoint)),
      ...(recent ? { ticketTakenAt: takenAt } : {}),
      ...(voted ? { voted } : {}),
      canRevote: election.disclosure.revote === "replace" && shown.state === "voting",
    });
    // Whatever the member did in the window, the page hears the same.
    if (!decided.approved || decided.ballot === undefined) return { ticketTaken: false };

    // Not awaited by the page: the cast waits a random pause before it goes,
    // and the window shows each step.
    const work = this.cast(vta, hostDid, who, electionId, shown, endpoint, decided.ballot as ElectionBallot, decided.window)
      .catch(() => undefined)
      .finally(() => this.casting.delete(work));
    this.casting.add(work);
    return { ticketTaken: false };
  }

  /** The cast, step by step, reported to the ballot window `window`. A window
   *  closed early does not stop it; a failure it can no longer show opens one. */
  private async cast(
    vta: ActiveVta,
    hostDid: string,
    who: Identity,
    electionId: string,
    shown: ElectionShown,
    endpoint: string,
    ballot: ElectionBallot,
    window: string | undefined,
  ): Promise<void> {
    let open = window !== undefined;
    const report = async (state: CastProgress): Promise<void> => {
      if (!open || window === undefined) return;
      open = await this.deps.progress(window, state).catch(() => false);
    };
    const host = new URL(endpoint).host;
    let step: CastStep = "check";
    try {
      await report({ phase: "running", step });
      const refused = ballotRefusal(shown.manifest, shown.manifestDigest, ballot);
      if (refused) throw new ElectionsPageRefusal(refused);
      if (!(await this.deps.canReach(endpoint))) {
        throw new ElectionsPageRefusal(
          `The wallet may not reach the ballot box at ${host}, so nothing was sent. Vote again and allow it when asked.`,
        );
      }

      step = "seal";
      await report({ phase: "running", step });
      const prepared = (await this.offscreen(vta, { op: "castPrepare", hostDid, member: who.did, electionId, ballot })) as {
        castDocument: Record<string, unknown>;
        endpoint: string;
        ballotBox: string;
      };
      if (prepared.endpoint !== endpoint && !(await this.deps.canReach(prepared.endpoint))) {
        throw new ElectionsPageRefusal(
          `The ballot box now names another door (${new URL(prepared.endpoint).host}), which the wallet may not reach. Vote again.`,
        );
      }

      step = "wait";
      const delayMs = (this.deps.castDelayMs ?? castDelayMs)();
      await report({ phase: "running", step, waitMs: delayMs, waitUntil: this.deps.now() + delayMs });
      const { receipt } = (await this.offscreen(vta, {
        op: "castPost",
        castDocument: prepared.castDocument,
        ballotBox: prepared.ballotBox,
        endpoint: prepared.endpoint,
        delayMs,
      }).catch((e: unknown) => {
        step = "send";
        throw e;
      })) as { receipt: Record<string, unknown> };

      // The ballot box counted it: what follows cannot undo that.
      step = "receipt";
      await report({ phase: "running", step });
      const said = (receipt.payload ?? {}) as { outcome?: unknown; leafIndex?: unknown };
      let status = typeof said.outcome === "string" ? said.outcome : "counted";
      let leafIndex = typeof said.leafIndex === "number" ? said.leafIndex : undefined;
      let receiptNotKept: string | undefined;
      try {
        const kept = (await this.offscreen(vta, { op: "castKeep", hostDid, member: who.did, electionId, receipt })) as {
          status?: string;
          leafIndex?: number;
        };
        if (typeof said.outcome !== "string" && typeof kept.status === "string") status = kept.status;
        if (typeof kept.leafIndex === "number") leafIndex = kept.leafIndex;
      } catch (e) {
        receiptNotKept = e instanceof Error ? e.message : String(e);
      }
      const vote: RememberedVote = { at: this.deps.now(), status, ...(leafIndex !== undefined ? { leafIndex } : {}) };
      await this.deps.rememberVote(ticketKey(hostDid, who.did, electionId), vote).catch(() => undefined);
      await report({ phase: "done", ...vote, ...(receiptNotKept !== undefined ? { receiptNotKept } : {}) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await report({ phase: "failed", step, error });
      if (!open) {
        await this.deps.prompt({
          kind: "cast",
          communityName: who.communityName,
          electionTitle: named(shown.manifest.title) ? shown.manifest.title : electionId,
          outcome: { ok: false, error },
        });
      }
    }
  }
}
