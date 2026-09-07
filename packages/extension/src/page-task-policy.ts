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

/** The Trust Task family a page may never drive directly. */
const PERSONA_PREFIX = "https://trusttasks.org/spec/persona/";

/**
 * Why a page may not run `type_uri`, or `null` when it may.
 *
 * A string rather than a bool so the refusal can say what to do instead: a
 * developer who gets "not permitted" and no route writes a workaround, and the
 * workaround is usually worse than the thing that was refused.
 */
export function pageTaskRefusal(typeUri: string): string | null {
  if (!typeUri.startsWith(PERSONA_PREFIX)) return null;
  return (
    `${typeUri} cannot be requested by a page. The persona family carries the ` +
    "holder's own identity, and a generic task prompt cannot tell them what a " +
    "disclosure would reveal. Ask for a disclosure through the wallet's " +
    "disclosure flow, which shows the holder exactly what would be sent, to " +
    "whom, and what it would let you link — and returns the presentation " +
    "rather than the underlying values."
  );
}
