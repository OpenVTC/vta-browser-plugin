// A member's forge account at a community (`git-ns/account/link/0.1`,
// `git-ns/account/unlink/0.1`): the account on a forge — GitHub, a Forgejo —
// the community's bridge gives the forge roles the member's git rights call
// for.
//
// A link binds an account the forge then treats as the member's, so it is the
// member's own signature, never a portal sign-in key's (`auth/oob/grant/0.2`
// consumer item 6). The wallet signs it as the member after asking them, and
// keeps where to authorise it — and any device code — in its own window: a page
// that held the code could complete the authorisation with an account of its
// own choosing.

import { TYPE_URI as ACCOUNT_LINK } from "../specs/git-ns/account/link/0.1/payload.js";
import type { Response as AccountLinkResponse } from "../specs/git-ns/account/link/0.1/payload.js";
import { TYPE_URI as ACCOUNT_UNLINK } from "../specs/git-ns/account/unlink/0.1/payload.js";
import type { Response as AccountUnlinkResponse } from "../specs/git-ns/account/unlink/0.1/payload.js";

import { OobReplyInvalidError, type OobDocument } from "./oob-sign-in.js";

export type { AccountLinkResponse, AccountUnlinkResponse };
export { ACCOUNT_LINK, ACCOUNT_UNLINK };

/** A forge host as the specification spells one: lowercase DNS, no scheme. */
const FORGE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isForgeHost(v: unknown): v is string {
  return typeof v === "string" && v.length >= 3 && v.length <= 253 && FORGE_HOST.test(v);
}

/** A forge's own identifier for an account. */
export function isForgeId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 64;
}

function envelope<P>(type: string, issuer: string, recipient: string, payload: P): OobDocument<P> {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    issuer,
    recipient,
    issuedAt: new Date().toISOString(),
    payload,
  };
}

/** `git-ns/account/link`, unsigned, as the member. */
export function buildAccountLink(memberDid: string, vtcDid: string, forge: string): OobDocument<{ forge: string }> {
  return envelope(ACCOUNT_LINK, memberDid, vtcDid, { forge });
}

/** `git-ns/account/unlink`, unsigned, as the member. `accountId` is the account
 *  as last read, so a request made before a re-link removes nothing. */
export function buildAccountUnlink(
  memberDid: string,
  vtcDid: string,
  forge: string,
  accountId?: string,
): OobDocument<{ forge: string; accountId?: string }> {
  return envelope(ACCOUNT_UNLINK, memberDid, vtcDid, accountId === undefined ? { forge } : { forge, accountId });
}

/** Where to authorise a link, from `link`'s answer. The URL must be `https:`,
 *  in its parsed form: the wallet opens it. */
export function linkStartedOf(res: unknown): AccountLinkResponse {
  const r = res as Partial<AccountLinkResponse> | undefined;
  if (!r || typeof r.linkId !== "string" || r.linkId === "" || r.linkId.length > 128) {
    throw new OobReplyInvalidError("account/link: no linkId");
  }
  if (typeof r.expiresAt !== "string" || Number.isNaN(Date.parse(r.expiresAt))) {
    throw new OobReplyInvalidError("account/link: no expiresAt");
  }
  let url: URL;
  try {
    url = new URL(String(r.url));
  } catch {
    throw new OobReplyInvalidError("account/link: url is not a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new OobReplyInvalidError("account/link: url is not a plain https URL");
  }
  if (r.userCode !== undefined && (typeof r.userCode !== "string" || r.userCode === "" || r.userCode.length > 64)) {
    throw new OobReplyInvalidError("account/link: userCode is not a code");
  }
  return {
    linkId: r.linkId,
    url: url.href,
    expiresAt: r.expiresAt,
    ...(r.userCode !== undefined ? { userCode: r.userCode } : {}),
  };
}

/** The account that was unlinked, from `unlink`'s answer. */
export function unlinkedOf(res: unknown): AccountUnlinkResponse {
  const r = res as Partial<AccountUnlinkResponse> | undefined;
  const a = r?.unlinked;
  if (!a || !isForgeHost(a.forge) || !isForgeId(a.id) || typeof a.login !== "string") {
    throw new OobReplyInvalidError("account/unlink: no unlinked account");
  }
  if (typeof r?.unlinkedAt !== "string") throw new OobReplyInvalidError("account/unlink: no unlinkedAt");
  return { unlinked: { forge: a.forge, id: a.id, login: a.login }, unlinkedAt: r.unlinkedAt };
}
