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
