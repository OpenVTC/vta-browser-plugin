// A page's `window.vtaWallet.git.*` — the background's half.
//
// `git-ns/account/link/0.1` and `git-ns/account/unlink/0.1`: the member links
// their account on a forge to their DID at a community, or removes it, so the
// community's bridge gives that account the forge roles the member's git
// rights call for — or withdraws them. A portal sign-in key may never sign
// either (`auth/oob/grant/0.3` consumer item 6): a link binds the account the
// forge then treats as the member's. So a page asks, and everything it asks
// passes these, in this order, before anything is signed:
//
//   1. **The call is well formed** (`gitPageParamsRefusal`).
//   2. **The page is the community's portal**: its browser-attested origin is
//      the origin of `hostDid`'s verified `SignInPortal` (`portalRefusal`), and
//      the wallet may reach the community's endpoint.
//   3. **The member is the wallet's**: one of the identities the member signs
//      in with at this community, never one the page names that the wallet
//      does not hold.
//   4. **The person decides**, in the wallet's own window, seeing which forge,
//      which identity and what the community will do with the account. A
//      closed window is a refusal.
//
// Only then does the member's agent sign the document and the wallet send it.
// For a link, the forge's authorisation page is opened by the wallet and any
// device code is shown in the wallet's window: the page gets the link's id and
// its expiry, to follow it with `git-ns/account/link-status`, and never the
// code — a page holding it could finish the authorisation with an account of
// its own choosing. An error is a sentence.
//
// Written against injected dependencies, not `chrome.*`, so the gates are
// tested as they run.

import { isForgeHost, isForgeId } from "@openvtc/pnm-core/vtc";

import type {
  GitPageOp,
  OffscreenGitPageOp,
  OffscreenGitPageResponse,
  PageGitLinkView,
  PageGitUnlinkView,
  RuntimeGitPageResponse,
} from "./bridge-protocol.js";

/** `chrome.storage.session` key prefix for a git prompt's view. */
export const GIT_CONSENT_PREFIX = "git-consent:";

/** What the person is shown in the wallet's window. */
export type GitConsentView =
  | {
      kind: "linkAccount" | "unlinkAccount";
      /** The portal that asked. */
      origin: string;
      hostDid: string;
      /** The community as the member's wallet names it. */
      communityName: string;
      /** The DID the document is signed as. */
      member: string;
      forge: string;
      /** For an unlink, the account the page last read, when it named one. */
      accountId?: string;
    }
  | {
      /** After a link was begun: where to authorise it, and the code to type. */
      kind: "authorise";
      communityName: string;
      forge: string;
      url: string;
      userCode?: string;
      expiresAt: string;
    };

/** The active VTA connection, as the background reads it. */
export interface ActiveVta {
  vtaDid: string;
  restBaseUrl?: string;
}

export interface GitPageDeps {
  active(): Promise<{ ok: true; vta: ActiveVta } | { ok: false; error: string }>;
  offscreen(vta: ActiveVta, op: OffscreenGitPageOp): Promise<OffscreenGitPageResponse>;
  /** Whether the wallet holds a host permission for `url`'s origin. */
  canReach(url: string): Promise<boolean>;
  /** Raise a prompt and wait. A closed window is a denial. */
  prompt(view: GitConsentView): Promise<{ approved: boolean }>;
  /** Open the forge's authorisation page, already checked to be `https:`. */
  openForge(url: string): Promise<void>;
  now(): number;
}

const MAX_DID = 2048;

function isDid(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("did:") && v.length <= MAX_DID;
}

/** Why `raw` is not a call this channel serves, or `null`. Members other than
 *  those named are refused, so nothing extra reaches the work. */
export function gitPageParamsRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "the call must be an object";
  const p = raw as Record<string, unknown>;
  const allowed =
    p.op === "linkAccount"
      ? ["op", "hostDid", "forge", "member"]
      : p.op === "unlinkAccount"
        ? ["op", "hostDid", "forge", "accountId", "member"]
        : null;
  if (!allowed) return "unknown git operation";
  for (const k of Object.keys(p)) {
    if (!allowed.includes(k)) return `${p.op} takes no \`${k}\``;
  }
  if (!isDid(p.hostDid)) return "hostDid must be a DID";
  if (!isForgeHost(p.forge)) return "forge must be a forge host, such as github.com";
  if (p.accountId !== undefined && !isForgeId(p.accountId)) return "accountId must be a forge account id";
  if (p.member !== undefined && !isDid(p.member)) return "member must be a DID";
  return null;
}

/** Why the page at `origin` may not speak for `hostDid`, or `null` when it may. */
export function portalRefusal(origin: string, hostDid: string, portalOrigin: string): string | null {
  if (origin === portalOrigin) return null;
  return (
    `${origin} is not ${hostDid}'s portal: its DID document names ${portalOrigin}. ` +
    `A page can link a member's forge account only from the portal the community's own DID document names.`
  );
}

/** How long a community's resolved portal is trusted before it is resolved again. */
const PORTAL_CACHE_MS = 5 * 60 * 1000;

class GitPageRefusal extends Error {}

interface Identity {
  did: string;
  communityName: string;
}

export class GitPageGates {
  private readonly portals = new Map<string, { portalOrigin: string; endpoint: string; at: number }>();

  constructor(private readonly deps: GitPageDeps) {}

  private async offscreen(vta: ActiveVta, op: OffscreenGitPageOp): Promise<unknown> {
    const res = await this.deps.offscreen(vta, op);
    if (!res.ok) throw new GitPageRefusal(res.error);
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

  /** One `git.*` call from a page at `origin` (browser-attested). */
  async handle(origin: string, raw: unknown): Promise<RuntimeGitPageResponse> {
    try {
      const malformed = gitPageParamsRefusal(raw);
      if (malformed) return { ok: false, error: malformed };
      const p = raw as GitPageOp;
      return {
        ok: true,
        result: p.op === "linkAccount" ? await this.link(origin, p) : await this.unlink(origin, p),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Gates 2 and 3: the page is the portal, and the identity is the wallet's. */
  private async gate(origin: string, p: GitPageOp): Promise<{ vta: ActiveVta; who: Identity }> {
    const active = await this.deps.active();
    if (!active.ok) throw new GitPageRefusal(active.error);
    const vta = active.vta;
    const { portalOrigin, endpoint } = await this.portal(vta, p.hostDid);
    const refusal = portalRefusal(origin, p.hostDid, portalOrigin);
    if (refusal) throw new GitPageRefusal(refusal);
    if (!(await this.deps.canReach(endpoint))) {
      throw new GitPageRefusal(
        `The wallet may not reach ${new URL(endpoint).origin} yet. Allow it from the wallet's popup, then try again.`,
      );
    }
    const members = ((await this.offscreen(vta, { op: "members", hostDid: p.hostDid })) as Identity[]).filter(
      (m) => m.did !== p.hostDid,
    );
    let who: Identity | undefined;
    if (p.member !== undefined) {
      who = members.find((m) => m.did === p.member);
      if (!who) throw new GitPageRefusal("The wallet holds no such identity for this community.");
    } else if (members.length === 1) {
      who = members[0]!;
    } else {
      throw new GitPageRefusal(
        members.length === 0
          ? "The wallet holds no identity you use at this community."
          : "You use more than one identity at this community: sign in with the one to link.",
      );
    }
    return { vta, who };
  }

  private async link(origin: string, p: Extract<GitPageOp, { op: "linkAccount" }>): Promise<PageGitLinkView> {
    const { vta, who } = await this.gate(origin, p);
    // Gate 4.
    const decided = await this.deps.prompt({
      kind: "linkAccount",
      origin,
      hostDid: p.hostDid,
      communityName: who.communityName,
      member: who.did,
      forge: p.forge,
    });
    if (!decided.approved) throw new GitPageRefusal("You did not link an account.");

    const started = (await this.offscreen(vta, {
      op: "link",
      hostDid: p.hostDid,
      member: who.did,
      forge: p.forge,
    })) as { linkId: string; url: string; userCode?: string; expiresAt: string };

    // Where to authorise it goes to the wallet's window and a tab the wallet
    // opens, never to the page. Neither is waited for: the page follows the
    // link with `link-status`.
    await this.deps.openForge(started.url);
    void this.deps.prompt({
      kind: "authorise",
      communityName: who.communityName,
      forge: p.forge,
      url: started.url,
      ...(started.userCode !== undefined ? { userCode: started.userCode } : {}),
      expiresAt: started.expiresAt,
    });
    return { linkId: started.linkId, expiresAt: started.expiresAt };
  }

  private async unlink(origin: string, p: Extract<GitPageOp, { op: "unlinkAccount" }>): Promise<PageGitUnlinkView> {
    const { vta, who } = await this.gate(origin, p);
    const decided = await this.deps.prompt({
      kind: "unlinkAccount",
      origin,
      hostDid: p.hostDid,
      communityName: who.communityName,
      member: who.did,
      forge: p.forge,
      ...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
    });
    if (!decided.approved) throw new GitPageRefusal("You did not unlink the account.");
    return (await this.offscreen(vta, {
      op: "unlink",
      hostDid: p.hostDid,
      member: who.did,
      forge: p.forge,
      ...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
    })) as PageGitUnlinkView;
  }
}
