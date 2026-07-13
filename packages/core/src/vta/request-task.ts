// The generic page → VTA task relay.
//
// A relying party proposes `(typeUri, payload)`. That is *all* it proposes. The
// device mints the envelope — `id`, `issuedAt`, `issuer`, `recipient` — inside
// its own trust boundary, stamps the browser-attested origin, and sends it under
// its own authentication.
//
// ## Why the device mints the envelope
//
// The obvious shape is for the page to hand over a complete Trust Task and for
// the wallet to sign it. That is what `vault/sign-trust-task` does, and it is
// exactly what must not happen here. Counter-signing an RP-authored envelope
// means the wallet attests to a document it did not write: the RP chooses the
// issuer, the recipient, the expiry, the id — every field the VTA will
// subsequently trust *because the wallet signed it*. The wallet becomes a
// notary for claims it never checked.
//
// So the page's input is reduced to the only two things it is entitled to
// propose: what kind of task, and with what payload. Everything that carries
// authority is written by the device.
//
// ## What this does NOT decide
//
// Nothing about whether the task is *allowed*. That is the VTA's job, and
// deliberately so — it holds the keys, it is the Policy Decision Point and the
// Policy Enforcement Point, and it is the only component in this picture that a
// compromised page or a compromised extension cannot speak for. A relay that
// tried to make authorization decisions locally would be a second, weaker copy
// of the policy engine, running in the least trustworthy place.
//
// The relay's whole job is to carry a proposal honestly and to lie about
// nothing.

import { buildTrustTask } from "./trust-task.js";
import type { VtaSession } from "./session.js";

/**
 * Framework `ext` key carrying the origin of the page that proposed the task.
 *
 * Written by the *device*, from the value the browser attested — never from
 * anything the page said about itself. It rides in `payload.ext` (the
 * framework's designated extension slot), which means it is inside the payload
 * digest: the origin a human is shown when they approve is bound to the payload
 * that executes, and cannot be swapped afterwards.
 */
export const ORIGIN_EXT_KEY = "openvtc.origin";

export interface RequestTaskArgs {
  /** Type URI of the task the page is proposing. */
  type: string;
  /** The page's proposed payload. Carried verbatim — the VTA validates it
   *  against the task's schema, which is closed, so nothing can ride along. */
  payload: Record<string, unknown>;
  /** This device's holder DID — the envelope's issuer. */
  holderDid: string;
  /** The VTA this device is enrolled with — the envelope's recipient. */
  vtaDid: string;
  /**
   * The origin the *browser* attributed to the proposing page.
   *
   * Not optional in spirit: a caller with no attested origin should not be
   * relaying at all. It is typed as optional only because a non-browser caller
   * (a CLI, a test) has no origin to give, and inventing one would be worse
   * than omitting it.
   */
  origin?: string;
}

/**
 * Relay one proposed task to the VTA and return whatever it says.
 *
 * Including a rejection. A `requireConsent` reject is not an error to be
 * swallowed — it carries the signed consent requests the approver must see, and
 * the digest the requesting surface must display for the cross-device match. A
 * relay that turned it into `throw new Error("denied")` would discard the
 * entire informed-consent flow at the last hop.
 */
export async function requestTask<Res>(
  session: VtaSession,
  args: RequestTaskArgs,
): Promise<Res> {
  const payload: Record<string, unknown> = { ...args.payload };

  if (args.origin) {
    const ext = { ...((payload.ext as Record<string, unknown> | undefined) ?? {}) };
    // The device's stamp wins. A page that set this key itself is either
    // confused or lying, and in neither case is its answer the right one.
    ext[ORIGIN_EXT_KEY] = args.origin;
    payload.ext = ext;
  }

  const envelope = buildTrustTask(args.type, payload, {
    issuer: args.holderDid,
    recipient: args.vtaDid,
  });

  return session.send<Res>(envelope);
}
