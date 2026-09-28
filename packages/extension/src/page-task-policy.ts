// Which Trust Tasks a *web page* may ask the wallet to run.
//
// `window.vtaWallet.requestTask({ type, payload })` takes an arbitrary task URI
// from the page and returns the VTA's reply to it, behind one generic consent
// prompt:
//
//     send a "Persona Disclosure Preview" request to your VTA
//
// That prompt names the task. It does not name what would be disclosed, to
// whom, how linkable it would make the holder, or what the chosen renderer
// would drop — because at that point the wallet has not asked yet, and the
// prompt is the same sentence for every task there is.
//
// For most tasks that is the right trade: the VTA is the authority, its own
// policy engine answers `requireConsent` where a task needs more, and a
// per-signature dialog for everything trains people to click through. For the
// persona family it is not, and the reason is specific rather than a matter of
// degree.
//
// **A page is a verifier.** `persona/disclosure/preview` returns the holder's
// claim VALUES, and `requestTask` hands the VTA's reply straight back to the
// caller — so a site that got the holder past one vague prompt would receive
// their name, their address and their phone number, having shown them none of
// it. The task is documented as "signs nothing and sends nothing", and that is
// true of the VTA; it says nothing about a wallet that then gives the answer to
// a web page. `contact/*` is the same shape pointed at other people: the
// holder's record of what their peers disclosed to them.
//
// So the family is refused here, and the refusal names the route that exists
// instead. This is the same reasoning the bundle guards use for `admin/*` —
// origin trust is not capability trust — applied to a surface where the
// authority being borrowed is the holder's own identity.
//
// **`rooms/*` is the second family, for the same reason at three different
// strengths.** `rooms/keys/open` returns the PLAINTEXT of a sealed record —
// the room's whole design keeps that from the host, and handing it to a web
// page behind one prompt gives it away to a party with less standing than the
// host. `rooms/keys/list` is the room's membership seen from the holder's side,
// which on a `private` room is the single fact the tier exists to withhold.
// And `rooms/owner/*` mints credentials in the ROOM's name: a page that got an
// owner past one generic prompt could issue itself membership, or authority to
// admin the room, and the room would be right to honour it.
//
// The refusal is the family, not those three, because the boundary is "a page
// is not a member" rather than a judgement about particular verbs.

/**
 * The task families a page may never drive directly, with what to say instead.
 *
 * A list rather than a chain of `if`s: a family added here needs a reason
 * written down beside it, and the reason is what the developer reads.
 */
const REFUSED: { prefix: string; why: string }[] = [
  {
    prefix: "https://trusttasks.org/spec/persona/",
    why:
      "The persona family carries the holder's own identity, and a generic task " +
      "prompt cannot tell them what a disclosure would reveal. Ask for a " +
      "disclosure through the wallet's disclosure flow, which shows the holder " +
      "exactly what would be sent, to whom, and what it would let you link — and " +
      "returns the presentation rather than the underlying values.",
  },
  {
    prefix: "https://trusttasks.org/spec/rooms/",
    why:
      "A data room is governed by credentials the room itself issued, and a page " +
      "holds none of them. Reading a record returns plaintext the room withholds " +
      "even from its host; listing keys discloses what the holder is a member of; " +
      "and the owner verbs mint credentials in the room's name, which is authority " +
      "to admit or promote. A member drives their rooms from their own wallet, " +
      "where the screen can say which room, which epoch, and what is being given.",
  },
  // A mediator's own operations surface (`@openvtc/pnm-core/mediator`). A page
  // routing one of these to an agent would be misaddressed anyway — they are
  // served by the relay, not the agent — but the refusal is about what they
  // disclose, and is the same whichever party answered: the traffic monitor is
  // a live feed of who this holder talks to, and the queue views say who has
  // not collected what.
  {
    prefix: "https://trusttasks.org/spec/messaging/",
    why:
      "The messaging family is the relay's operations surface: its queues, its " +
      "accounts and a live feed of whom the holder exchanges messages with. A page " +
      "has no use for any of it that the holder should be asked to approve; the " +
      "holder inspects their own relay from the wallet's console.",
  },
];

/**
 * Why a page may not run `type_uri`, or `null` when it may.
 *
 * A string rather than a bool so the refusal can say what to do instead: a
 * developer who gets "not permitted" and no route writes a workaround, and the
 * workaround is usually worse than the thing that was refused.
 */
export function pageTaskRefusal(typeUri: string): string | null {
  const hit = REFUSED.find((r) => typeUri.startsWith(r.prefix));
  return hit ? `${typeUri} cannot be requested by a page. ${hit.why}` : null;
}

// ── What a page may ask the wallet to *sign* ────────────────────────────────
//
// `window.vtaWallet.signTrustTask({ envelope })` signs a page-built document
// with the holder key, for `proofPurpose: authentication` — the holder's own
// request to a relying party. A relying party that binds proofs to key roles
// accepts that as the holder speaking, so a signature a page obtains is a
// request the holder has made. The per-call prompt names the task type and the
// recipient; this refuses the shapes no prompt could make safe:
//
// - **No recipient.** An unaddressed signature is good at every party that
//   accepts the holder's key; the recipient is what binds it to one audience.
// - **The holder's own agent.** A page drives the agent through `requestTask`,
//   where the agent's policy engine and the refusals above apply. A signed
//   document addressed straight to the agent would step around both.
// - **Approvals.** A step-up approve-request or approve-response is only ever
//   built by the wallet's own step-up ceremony, after it has verified the
//   relying party's signed request and asked the human on its verified reason.
// - **A sign-in.** An `auth/authenticate` document is a login, and from 0.2 it
//   can bind a page-held session key that then acts as the holder for the
//   whole session. A login goes through `login()`, whose prompt says so and is
//   never skipped for a session key. Signed here, it would get the generic
//   "Sign <type>" prompt instead, which says neither.
// - **The families a page may not request** (above), for the same reasons.

const APPROVAL_PREFIX = "https://trusttasks.org/spec/auth/step-up/approve-";
const AUTHENTICATE_PREFIX = "https://trusttasks.org/spec/auth/authenticate/";

/**
 * Why a page may not have the wallet sign `envelope`, or `null` when it may.
 * `ownAgentDid` is the active connection's agent DID.
 */
export function pageSignRefusal(envelope: unknown, ownAgentDid: string): string | null {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return "signTrustTask needs a Trust Task document to sign.";
  }
  const { type, recipient } = envelope as { type?: unknown; recipient?: unknown };
  if (typeof type !== "string" || type === "") {
    return "signTrustTask needs a document with a type.";
  }
  if (typeof recipient !== "string" || recipient === "") {
    return `${type} names no recipient. A page-signed document must be addressed to the party it is for, or the signature is good at any party that accepts the holder's key.`;
  }
  if (recipient === ownAgentDid) {
    return `${type} is addressed to the holder's own agent. A page asks the agent through requestTask, where the agent's policy applies; the wallet does not sign documents to it on a page's behalf.`;
  }
  if (type.startsWith(APPROVAL_PREFIX)) {
    return `${type} cannot be signed for a page. A step-up approval is built only by the wallet's step-up flow (stepUpVta), which verifies the relying party's request and asks the holder first.`;
  }
  if (type.startsWith(AUTHENTICATE_PREFIX)) {
    return `${type} cannot be signed for a page. A sign-in, and any session key it binds, goes through login(), whose prompt tells the holder what the site will be able to do.`;
  }
  return pageTaskRefusal(type);
}

// ── Which relying party a page may have the holder key used for ─────────────
//
// `pageSignRefusal` requires a recipient, but any recipient: a page the user
// approved could still get a signature addressed to a *different* relying
// party, and present it there as the holder's own request. `stepUpVta` had the
// same gap — the page named the base URL and RP DID, so an approved page could
// steer an aal2 approval at a party the human never signed in to from it.
//
// The binding already exists. A login pins the browser-attested origin to the
// RP DID the human approved (`origin-pin.ts`, M5), and a REST login pins the
// base URL it went to beside it. Both page paths are held to that pin:
//
// - `signTrustTask` signs only a document whose `recipient` is the pinned RP
//   DID for the requesting origin.
// - `stepUpVta` runs only against the pinned RP DID and the pinned base URL.
// - No pin means no signature and no step-up. Neither path pins on first use:
//   the only place a pin is seeded is a login the human approved, so the rule
//   stays login's rule — the human confirms the origin ↔ RP pairing once, on the
//   prompt that exists to show it.
//
// The pin is looked up by exact origin. A subdomain, a lookalike host, or the
// same host on another scheme or port is a different origin, and has no pin.

/** What a page's origin is pinned to (mirrors `OriginPin` in `origin-pin.ts`,
 *  restated here so this module stays free of `chrome.*`). */
export interface PageRpPin {
  rpDid: string;
  baseUrl?: string;
}

/**
 * A base URL in the one spelling pins are compared in: scheme, host and port as
 * the URL parser canonicalizes them, and the path without trailing slashes.
 * `null` for anything that is not a plain http(s) base — credentials, a query
 * or a fragment have no place in one, and a comparison that ignored them would
 * be comparing something other than where the request goes.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function unpinned(origin: string, what: string): string {
  return (
    `${origin} has no relying party pinned, so the wallet will not ${what} for it. ` +
    `Sign in from this site first: the login prompt is where the site's relying party ` +
    `is shown and confirmed, and it pins that pairing.`
  );
}

/**
 * Why the page at `origin` may not have a document addressed to `recipient`
 * signed, or `null` when it may. `pin` is `readOriginPin(origin)`.
 */
export function pageSignBindingRefusal(
  origin: string,
  pin: PageRpPin | undefined,
  recipient: string,
): string | null {
  if (!pin) return unpinned(origin, "sign documents");
  if (recipient !== pin.rpDid) {
    return (
      `The document is addressed to ${recipient}, but ${origin} is pinned to the relying ` +
      `party ${pin.rpDid}. A page can only have documents signed for the relying party it ` +
      `was signed in to.`
    );
  }
  return null;
}

/**
 * Why the page at `origin` may not start a step-up against `params`, or `null`
 * when it may. `pin` is `readOriginPin(origin)`.
 */
export function pageStepUpBindingRefusal(
  origin: string,
  pin: PageRpPin | undefined,
  params: { rpDid: string; baseUrl: string },
): string | null {
  if (!pin) return unpinned(origin, "step up a session");
  if (params.rpDid !== pin.rpDid) {
    return (
      `Step-up names the relying party ${params.rpDid}, but ${origin} is pinned to ` +
      `${pin.rpDid}. A page can only step up its session at the relying party it was ` +
      `signed in to.`
    );
  }
  if (!pin.baseUrl) {
    return (
      `${origin} has no relying-party base URL pinned: its sign-in named none. Sign in ` +
      `from this site with login() so the base URL step-up will use is shown and confirmed.`
    );
  }
  const requested = normalizeBaseUrl(params.baseUrl);
  if (requested !== pin.baseUrl) {
    return (
      `Step-up names the base URL ${params.baseUrl}, but ${origin} is pinned to ` +
      `${pin.baseUrl}. A page can only step up against the base URL it signed in with.`
    );
  }
  return null;
}
