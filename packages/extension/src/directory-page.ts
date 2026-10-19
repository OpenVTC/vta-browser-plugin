// A page's `window.vtaWallet.directory.*` — the background's half.
//
// `vtc/directory/card/publish/0.1`: the member publishes their directory card
// beyond the community, as a card they signed. Everything a page asks passes
// these, in this order, before anything is signed:
//
//   1. **The call is well formed** (`directoryPageParamsRefusal`).
//   2. **The page is the community's portal**: its browser-attested origin is
//      the origin of `hostDid`'s verified `SignInPortal` (`portalRefusal`), and
//      the wallet may reach the community's endpoint.
//   3. **The member is the wallet's**: one of the identities the member signs
//      in with at this community, never one the page names that the wallet
//      does not hold.
//   4. **The person decides**, in the wallet's own window, seeing every value
//      the card will carry and that anyone — outside the community too — can
//      read it (VTI-REG-004 item 2). A closed window is a refusal.
//
// Only then is the card signed by the member's agent and sent. What goes back
// is where the card stands; an error is a sentence.
//
// Written against injected dependencies, not `chrome.*`, so the gates are
// tested as they run.

import type {
  DirectoryPageOp,
  OffscreenDirectoryPageOp,
  OffscreenDirectoryPageResponse,
  PagePublishedCardView,
  RuntimeDirectoryPageResponse,
} from "./bridge-protocol.js";

/** `chrome.storage.session` key prefix for a publish prompt's view. */
export const DIRECTORY_CONSENT_PREFIX = "directory-consent:";

/** What the person is shown before their card is published. */
export interface DirectoryPublishConsentView {
  kind: "publishCard";
  /** The portal that asked. */
  origin: string;
  hostDid: string;
  /** The community as the member's wallet names it. */
  communityName: string;
  /** The DID the card is signed as. */
  member: string;
  /** What publishing means, in the person's words. */
  meaning: string[];
  /** Every value the card carries, one line each; empty when it shows nothing. */
  values: string[];
  closing: string;
}

/** The active VTA connection, as the background reads it. */
export interface ActiveVta {
  vtaDid: string;
  restBaseUrl?: string;
}

export interface DirectoryPageDeps {
  active(): Promise<{ ok: true; vta: ActiveVta } | { ok: false; error: string }>;
  offscreen(vta: ActiveVta, op: OffscreenDirectoryPageOp): Promise<OffscreenDirectoryPageResponse>;
  /** Whether the wallet holds a host permission for `url`'s origin. */
  canReach(url: string): Promise<boolean>;
  /** Raise the publish prompt and wait. A closed window is a denial. */
  prompt(view: DirectoryPublishConsentView): Promise<{ approved: boolean }>;
  now(): number;
}

const MAX_DID = 2048;

function isDid(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("did:") && v.length <= MAX_DID;
}

/** Why `raw` is not a call this channel serves, or `null`. Members other than
 *  those named are refused, so nothing extra reaches the work. */
export function directoryPageParamsRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "the call must be an object";
  const p = raw as Record<string, unknown>;
  if (p.op !== "publishCard") return "unknown directory operation";
  for (const k of Object.keys(p)) {
    if (!["op", "hostDid", "member"].includes(k)) return `publishCard takes no \`${k}\``;
  }
  if (!isDid(p.hostDid)) return "hostDid must be a DID";
  if (p.member !== undefined && !isDid(p.member)) return "member must be a DID";
  return null;
}

/** Why the page at `origin` may not speak for `hostDid`, or `null` when it may. */
export function portalRefusal(origin: string, hostDid: string, portalOrigin: string): string | null {
  if (origin === portalOrigin) return null;
  return (
    `${origin} is not ${hostDid}'s portal: its DID document names ${portalOrigin}. ` +
    `A page can publish a member's card only from the portal the community's own DID document names.`
  );
}

/** How long a community's resolved portal is trusted before it is resolved again. */
const PORTAL_CACHE_MS = 5 * 60 * 1000;

class DirectoryPageRefusal extends Error {}

export class DirectoryPageGates {
  private readonly portals = new Map<string, { portalOrigin: string; endpoint: string; at: number }>();

  constructor(private readonly deps: DirectoryPageDeps) {}

  private async offscreen(vta: ActiveVta, op: OffscreenDirectoryPageOp): Promise<unknown> {
    const res = await this.deps.offscreen(vta, op);
    if (!res.ok) throw new DirectoryPageRefusal(res.error);
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

  /** One `directory.*` call from a page at `origin` (browser-attested). */
  async handle(origin: string, raw: unknown): Promise<RuntimeDirectoryPageResponse> {
    try {
      const malformed = directoryPageParamsRefusal(raw);
      if (malformed) return { ok: false, error: malformed };
      return { ok: true, result: await this.publishCard(origin, raw as DirectoryPageOp) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async publishCard(origin: string, p: DirectoryPageOp): Promise<PagePublishedCardView> {
    // Gate 2.
    const active = await this.deps.active();
    if (!active.ok) throw new DirectoryPageRefusal(active.error);
    const vta = active.vta;
    const { portalOrigin, endpoint } = await this.portal(vta, p.hostDid);
    const refusal = portalRefusal(origin, p.hostDid, portalOrigin);
    if (refusal) throw new DirectoryPageRefusal(refusal);
    if (!(await this.deps.canReach(endpoint))) {
      throw new DirectoryPageRefusal(
        `The wallet may not reach ${new URL(endpoint).origin} yet. Allow it from the wallet's popup, then try again.`,
      );
    }

    // Gate 3: the wallet's identities here, never one the page made up.
    const members = ((await this.offscreen(vta, { op: "members", hostDid: p.hostDid })) as string[]).filter(
      (m) => m !== p.hostDid,
    );
    let member: string;
    if (p.member !== undefined) {
      if (!members.includes(p.member)) {
        throw new DirectoryPageRefusal("The wallet holds no such identity for this community.");
      }
      member = p.member;
    } else if (members.length === 1) {
      member = members[0]!;
    } else {
      throw new DirectoryPageRefusal(
        members.length === 0
          ? "The wallet holds no identity you use at this community."
          : "You use more than one identity at this community: sign in with the one whose card to publish.",
      );
    }

    // Read the card as the member and build what would be signed.
    const prepared = (await this.offscreen(vta, { op: "prepare", hostDid: p.hostDid, member })) as {
      card: Record<string, unknown>;
      revision: number;
      communityName: string;
      said: { meaning: string[]; values: string[]; closing: string };
    };

    // Gate 4.
    const decided = await this.deps.prompt({
      kind: "publishCard",
      origin,
      hostDid: p.hostDid,
      communityName: prepared.communityName,
      member,
      meaning: prepared.said.meaning,
      values: prepared.said.values,
      closing: prepared.said.closing,
    });
    if (!decided.approved) throw new DirectoryPageRefusal("You did not publish your card.");

    // Copied member by member: the card `prepare` built, nothing the page sent.
    return (await this.offscreen(vta, {
      op: "publish",
      hostDid: p.hostDid,
      member,
      card: prepared.card,
      revision: prepared.revision,
    })) as PagePublishedCardView;
  }
}
