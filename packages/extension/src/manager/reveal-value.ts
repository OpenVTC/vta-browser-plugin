// Asking the agent for one sensitive value, at the moment a person asks to see it.
//
// ## Why this exists at all
//
// `persona/attribute/list` answers a values request with the metadata of every
// attribute resolving to `sensitivity: high` and the plaintext of none, unless
// the caller also sets `includeSensitive`. The console never set it, so those
// values never arrived — and the pane masked the placeholder that stood in for
// them. A card read `••••` beside a *Show* button, pressing *Show* said "not on
// this page", and a strip underneath explained that the agent "has already sent
// this value here", which was the one thing that had not happened.
//
// The masking was not wrong so much as pointed at nothing. The specification is
// blunt about which half matters: "a consumer that masks a value it has already
// received defends a screen; it does not keep a card number out of a log, a
// crash dump or a process's memory. Ignoring this member and masking
// client-side is a conforming implementation of nothing."
//
// ## One value, on a press, and not a pool
//
// So the pane keeps listing without sensitive values, and *Show* becomes the
// request. Until it is pressed the plaintext is genuinely not in the page —
// which is what makes the mask a control rather than a curtain — and pressing
// it fetches exactly the one attribute a person is looking at.
//
// The obvious shortcut is to set `includeSensitive` on the pane's own listing.
// It is three lines, it makes every *Show* instant, and it puts every passport
// number and card number the holder owns into a React tree for as long as the
// tab is open, on the reasoning that they might press one of the buttons. That
// is the decorative version with extra steps.
//
// ## Narrowed by type, matched by id
//
// There is no `attribute/get` in the vocabulary — `list`, `put`, `delete` — so
// the narrowest question available is `typePrefix` set to the attribute's own
// type. That can return siblings (two `phone.mobile` entries), which is why the
// answer is matched on `attributeId` and never on position. A prefix is a byte
// comparison at the agent (SPEC: "the maintainer MUST NOT interpret the value
// further"), so passing a whole type is a legal, and the tightest, prefix.

import { personaAttributeList, type PoolAttribute } from "@openvtc/pnm-core/admin";
import type { TrustTaskSender } from "@openvtc/pnm-core";
import type { Parties } from "./use-vta.js";

/** What the caller already holds about the attribute it wants revealed: the
 *  metadata listing gave it both, and neither is the value. */
export interface RevealTarget {
  attributeId: string;
  type: string;
}

/**
 * The plaintext of one attribute, asked for explicitly.
 *
 * Throws when the agent answers without it. That is deliberate: a caller that
 * received `undefined` would render "not on this page" again and the person
 * would press *Show* a second time, learning nothing. The two ways it happens
 * are worth telling apart in the message a surface shows — the attribute is
 * gone, or the agent declined to widen the listing — and both are the agent
 * saying no, rather than this function failing to ask.
 */
export async function revealAttributeValue(
  sender: TrustTaskSender,
  parties: Parties,
  target: RevealTarget,
): Promise<unknown> {
  const listed: PoolAttribute[] = await personaAttributeList(sender, {
    ...parties,
    typePrefix: target.type,
    includeValues: true,
    includeSensitive: true,
  });
  const found = listed.find((a) => a.attributeId === target.attributeId);
  if (!found) {
    throw new Error("your agent no longer lists this attribute");
  }
  if (found.value === undefined) {
    // `stale` is the specification's own discriminator for an absent value on
    // a credential-backed attribute, and it is a different sentence: the value
    // could not be re-derived, so there is nothing being withheld.
    throw new Error(
      found.stale === true
        ? `its backing credential could not be re-derived (${found.staleReason ?? "stale"})`
        : "your agent held the value back",
    );
  }
  return found.value;
}
