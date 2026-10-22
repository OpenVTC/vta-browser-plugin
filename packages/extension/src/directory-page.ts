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
// `marks`, `mark`, `putList` and `deleteList` reach the member's own marks on
// other members — stars, petnames, lists — which live in the member's own
// agent and never at the community (`persona/contact/*/1.1`). Gates 1 – 3 are
// the same; gate 4 differs. The portal page is the community's own code, so
// whatever the wallet hands it the community could read: before the first
// mark reaches a community's portal, the wallet asks the person once whether
// that portal may show and change them, and remembers the answer for that
// community and that portal origin until they withdraw it in the wallet. Only
// contacts linked to that community's directory are ever handed over.
//
// `presentCredential` fills the member's `credential`-sourced fields — a
// verified employer, a registration — from a credential their agent holds
// (`vtc/directory/card/present/0.1`). Gates 1 – 3 are the same; then the wallet
// reads what the fields ask of a credential and finds the member's credentials
// that answer it, and gate 4 is the person choosing one, seeing the community,
// the fields and every claim it will disclose. A credential that cannot hide a
// claim the fields do not read is asked about again, naming those claims,
// before anything is presented: a presentation discloses to the community
// whatever it carries, and the agent records every one it makes.
//
// Written against injected dependencies, not `chrome.*`, so the gates are
// tested as they run.

import type {
  DirectoryPageOp,
  PageMarksView,
  PageVerifiedFieldsView,
  PreparedPresent,
  OffscreenDirectoryPageOp,
  OffscreenDirectoryPageResponse,
  PagePublishedCardView,
  RuntimeDirectoryPageResponse,
} from "./bridge-protocol.js";

/** `chrome.storage.session` key prefix for a publish prompt's view. */
export const DIRECTORY_CONSENT_PREFIX = "directory-consent:";

/** `chrome.storage.local` key prefix for a community's leave to show the
 *  member's marks: `<prefix><hostDid>` → [`MarksGrant`]. */
export const MARKS_GRANT_PREFIX = "directory-marks-grant:";

/** The member let a community's portal show and change their marks. */
export interface MarksGrant {
  hostDid: string;
  /** The portal origin it was given to; another origin is asked afresh. */
  portalOrigin: string;
  communityName: string;
  grantedAt: number;
}

/** What the person is shown before a community's portal first sees their marks. */
export interface DirectoryMarksConsentView {
  kind: "marksAccess";
  origin: string;
  hostDid: string;
  communityName: string;
}

/** What the person is shown before a credential is presented to fill fields. */
export interface DirectoryPresentConsentView {
  kind: "presentCredential";
  origin: string;
  hostDid: string;
  communityName: string;
  /** The DID the presentation is made for, and signed as. */
  member: string;
  /** The fields it fills, with the community's labels. */
  fields: Array<{ key: string; label: string }>;
  /** Every claim it discloses. */
  claims: string[];
  /** The credentials the person may choose among; one is chosen. */
  candidates: Array<{ id: string; issuerDid?: string; types: string[]; validUntil?: string }>;
}

/** What the person is shown when the chosen credential cannot hide claims the
 *  fields do not read. */
export interface DirectoryOverDiscloseConsentView {
  kind: "presentOverDisclose";
  origin: string;
  hostDid: string;
  communityName: string;
  /** The claims it would disclose beyond those the fields read. */
  undisclosed: string[];
  claims: string[];
}

/** Every directory prompt. */
export type DirectoryConsentView =
  | DirectoryPublishConsentView
  | DirectoryMarksConsentView
  | DirectoryPresentConsentView
  | DirectoryOverDiscloseConsentView;

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
  /** Raise the prompt and wait. A closed window is a denial. A credential
   *  prompt answers with the credential chosen. */
  prompt(view: DirectoryConsentView): Promise<{ approved: boolean; selectedCredential?: string }>;
  /** The member's leave for `hostDid`'s portal to show their marks, if any. */
  marksGrant(hostDid: string): Promise<MarksGrant | null>;
  saveMarksGrant(grant: MarksGrant): Promise<void>;
  now(): number;
}

const MAX_DID = 2048;

/** A field key, as `vtc/directory/_shared`'s `FieldKey`. */
const FIELD_KEY = /^([a-z][a-z0-9-]*\.)*[a-z][a-zA-Z0-9]{0,63}$/;

function isDid(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("did:") && v.length <= MAX_DID;
}

/** A list or entry id the agent and the directory mint: short, URL-safe. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** One line, no control characters, as the spec's `Petname` / `ListName`. */
const LINE = /^[^\u0000-\u001F\u007F]+$/;

const MEMBERS: Record<DirectoryPageOp["op"], string[]> = {
  publishCard: ["op", "hostDid", "member"],
  marks: ["op", "hostDid", "member"],
  mark: ["op", "hostDid", "member", "entryId", "starred", "petname", "removePetname", "lists"],
  putList: ["op", "hostDid", "member", "listId", "name", "colour"],
  deleteList: ["op", "hostDid", "member", "listId"],
  presentCredential: ["op", "hostDid", "member", "fields"],
};

/** Why `raw` is not a call this channel serves, or `null`. Members other than
 *  those named are refused, so nothing extra reaches the work. */
export function directoryPageParamsRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "the call must be an object";
  const p = raw as Record<string, unknown>;
  const allowed = MEMBERS[p.op as DirectoryPageOp["op"]];
  if (!allowed || typeof p.op !== "string") return "unknown directory operation";
  for (const k of Object.keys(p)) {
    if (!allowed.includes(k)) return `${p.op} takes no \`${k}\``;
  }
  if (!isDid(p.hostDid)) return "hostDid must be a DID";
  if (p.member !== undefined && !isDid(p.member)) return "member must be a DID";
  switch (p.op) {
    case "mark": {
      if (typeof p.entryId !== "string" || !ID.test(p.entryId)) return "entryId must be a directory entry id";
      if (p.starred !== undefined && typeof p.starred !== "boolean") return "starred must be true or false";
      if (p.petname !== undefined && (typeof p.petname !== "string" || p.petname.length > 128 || !LINE.test(p.petname))) {
        return "petname must be one line of at most 128 characters";
      }
      if (p.removePetname !== undefined && p.removePetname !== true) return "removePetname must be true";
      if (p.petname !== undefined && p.removePetname) return "give a petname or remove it, not both";
      if (
        p.lists !== undefined &&
        (!Array.isArray(p.lists) || p.lists.length > 64 || !p.lists.every((l) => typeof l === "string" && ID.test(l)))
      ) {
        return "lists must be at most 64 list ids";
      }
      if (p.starred === undefined && p.petname === undefined && !p.removePetname && p.lists === undefined) {
        return "mark changes nothing";
      }
      return null;
    }
    case "putList":
      if (p.listId !== undefined && (typeof p.listId !== "string" || !ID.test(p.listId))) return "listId must be a list id";
      if (p.listId === undefined && p.name === undefined) return "a new list has a name";
      if (p.name !== undefined && (typeof p.name !== "string" || p.name.length > 64 || !LINE.test(p.name))) {
        return "name must be one line of at most 64 characters";
      }
      if (p.colour !== undefined && (typeof p.colour !== "string" || !/^#[0-9a-f]{6}$/.test(p.colour))) {
        return "colour must be #rrggbb, lowercase";
      }
      return null;
    case "deleteList":
      if (typeof p.listId !== "string" || !ID.test(p.listId)) return "listId must be a list id";
      return null;
    case "presentCredential":
      if (
        !Array.isArray(p.fields) ||
        p.fields.length < 1 ||
        p.fields.length > 16 ||
        !p.fields.every((f) => typeof f === "string" && f.length <= 128 && FIELD_KEY.test(f)) ||
        new Set(p.fields).size !== p.fields.length
      ) {
        return "fields must be 1 to 16 distinct directory field keys";
      }
      return null;
    default:
      return null;
  }
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
      const p = raw as DirectoryPageOp;
      if (p.op === "publishCard") return { ok: true, result: await this.publishCard(origin, p) };
      if (p.op === "presentCredential") return { ok: true, result: await this.presentCredential(origin, p) };
      return { ok: true, result: (await this.marks(origin, p)) as PageMarksView };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Gates 2 and 3: the page is the community's portal, and the member is one
   *  of the wallet's identities there. */
  private async admit(
    origin: string,
    p: { hostDid: string; member?: string },
  ): Promise<{ vta: ActiveVta; member: string; portalOrigin: string }> {
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
          : "You use more than one identity at this community: sign in with the one you are using here.",
      );
    }
    return { vta, member, portalOrigin };
  }

  /** The member's own marks (module docs): gates 1 – 3, then the community's
   *  leave, asked for once. */
  private async marks(
    origin: string,
    p: Exclude<DirectoryPageOp, { op: "publishCard" | "presentCredential" }>,
  ): Promise<unknown> {
    const { vta, member, portalOrigin } = await this.admit(origin, p);
    const grant = await this.deps.marksGrant(p.hostDid);
    if (!grant || grant.portalOrigin !== portalOrigin) {
      const named = await this.offscreen(vta, { op: "communityName", hostDid: p.hostDid, member });
      const name = typeof named === "string" && named ? named : "This community";
      const decided = await this.deps.prompt({ kind: "marksAccess", origin, hostDid: p.hostDid, communityName: name });
      if (!decided.approved) {
        throw new DirectoryPageRefusal("You did not let this community's portal show your marks.");
      }
      await this.deps.saveMarksGrant({
        hostDid: p.hostDid,
        portalOrigin,
        communityName: name,
        grantedAt: this.deps.now(),
      });
    }
    switch (p.op) {
      case "marks":
        return this.offscreen(vta, { op: "marks", hostDid: p.hostDid, member });
      case "mark":
        return this.offscreen(vta, {
          op: "mark",
          hostDid: p.hostDid,
          member,
          entryId: p.entryId,
          ...(p.starred !== undefined ? { starred: p.starred } : {}),
          ...(p.petname !== undefined ? { petname: p.petname } : {}),
          ...(p.removePetname ? { removePetname: true as const } : {}),
          ...(p.lists !== undefined ? { lists: [...p.lists] } : {}),
        });
      case "putList":
        return this.offscreen(vta, {
          op: "putList",
          hostDid: p.hostDid,
          member,
          ...(p.listId !== undefined ? { listId: p.listId } : {}),
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.colour !== undefined ? { colour: p.colour } : {}),
        });
      case "deleteList":
        return this.offscreen(vta, { op: "deleteList", hostDid: p.hostDid, member, listId: p.listId });
    }
  }

  private async publishCard(origin: string, p: Extract<DirectoryPageOp, { op: "publishCard" }>): Promise<PagePublishedCardView> {
    const { vta, member } = await this.admit(origin, p);

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
  /** Fill credential-sourced fields (module docs): gates 1 – 3, then the
   *  person's choice of credential, and again for anything it cannot hide. */
  private async presentCredential(
    origin: string,
    p: Extract<DirectoryPageOp, { op: "presentCredential" }>,
  ): Promise<PageVerifiedFieldsView> {
    const { vta, member } = await this.admit(origin, p);
    const prepared = (await this.offscreen(vta, {
      op: "preparePresent",
      hostDid: p.hostDid,
      member,
      fields: [...p.fields],
    })) as PreparedPresent;

    // Gate 4: the person picks one of the credentials offered, and sees every
    // claim it discloses. An answer naming any other is a refusal.
    const decided = await this.deps.prompt({
      kind: "presentCredential",
      origin,
      hostDid: p.hostDid,
      communityName: prepared.communityName,
      member,
      fields: prepared.fields,
      claims: prepared.claims,
      candidates: prepared.candidates,
    });
    const chosen = prepared.candidates.find((c) => c.id === decided.selectedCredential);
    if (!decided.approved || !chosen) throw new DirectoryPageRefusal("You did not present a credential.");

    const present = (claims: string[]) =>
      this.offscreen(vta, {
        op: "present",
        hostDid: p.hostDid,
        member,
        fields: [...p.fields],
        credentialId: chosen.id,
        claims,
      }) as Promise<PageVerifiedFieldsView | { undisclosed: string[] }>;
    let answer = await present(prepared.claims);
    if ("undisclosed" in answer) {
      // The credential cannot hide these: presenting it shows them too.
      const undisclosed = answer.undisclosed;
      const again = await this.deps.prompt({
        kind: "presentOverDisclose",
        origin,
        hostDid: p.hostDid,
        communityName: prepared.communityName,
        undisclosed,
        claims: prepared.claims,
      });
      if (!again.approved) throw new DirectoryPageRefusal("You did not present the credential.");
      answer = await present([...prepared.claims, ...undisclosed.filter((c) => !prepared.claims.includes(c))]);
      if ("undisclosed" in answer) {
        throw new DirectoryPageRefusal("The credential still discloses more than you agreed to. Nothing was presented.");
      }
    }
    return answer;
  }
}
