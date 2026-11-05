// The error a page's `window.vtaWallet.*` call rejects with: a human `message`
// and a machine-readable `code` (docs/page-bridge-errors.md).
//
// A portal must tell one refusal from another — "the community shows you no
// such election", "you declined in the wallet", "unlock the wallet" — and the
// message is prose this wallet rewords whenever it likes. Matching it is the
// failure R3.7 forbids. So every rejection on the page channels carries a
// `code`, and the code is one of two things:
//
// - **a Trust Task error code**, by its local part (`vtc/elections/show:
//   electionUnknown` → `electionUnknown`; a §8.3 standard code as it is), when
//   the community or the member's agent refused; or
// - **a wallet code** from `WALLET_ERROR_CODES`, for what the wallet itself
//   decided or ran into.
//
// No wallet code is a framework standard code (a test holds this). One shares
// its name with an extended code: `declined` (`auth/oob/redeem`,
// `vetting/request`), which means the same there — and neither task answers on
// a page channel — so a page switches on `code` without asking who said it.
// `declined` is also the name the room offers used already, which portals
// match on.
//
// What a code may carry: a fixed name, never data. It is checked against
// `PAGE_CODE` before it leaves the wallet, so a refusing party cannot put
// anything into it the page would not already read in the message — no
// credential, no choice, no persona detail (VTI-NTF-063, VTI-VOT-090).

import type { RoomOfferErrorCode } from "@openvtc/pnm-core/rooms";
import type { RoomFileError } from "@openvtc/pnm-core/rooms/files";

/**
 * The wallet's own codes, and what each means to a page. Stable: a name here is
 * a contract with every portal, so one is added, never renamed or reused.
 */
export const WALLET_ERROR_CODES = {
  /** The call is not one this channel serves: an unknown method or operation,
   *  a member it does not take, a value of the wrong shape. Fix the call. */
  invalidCall: "The call is not one this channel serves.",
  /** The page's origin may not make this call: the browser attested none, or it
   *  is not the portal the community's own DID document names. */
  originNotPermitted: "This page's origin may not make this call.",
  /** The wallet is connected to no agent, or to one it has no way to reach. */
  notConnected: "The wallet is not connected to an agent.",
  /** The wallet is locked. Ask the member to unlock it from the wallet's
   *  popup; the page hears `vtawallet:unlocked` when they do. */
  walletLocked: "The wallet is locked.",
  /** The wallet has not been allowed to reach the community's (or the room
   *  host's) endpoint. The member allows it from the wallet. */
  hostPermissionRequired: "The wallet may not reach the endpoint yet.",
  /** The wallet holds no identity the member uses at this community, or not
   *  the one the page named as `member`. */
  identityUnknown: "The wallet holds no such identity for this community.",
  /** The member uses more than one identity at this community and the page
   *  named none: pass `member`. */
  identityAmbiguous: "The member uses more than one identity here.",
  /** The member declined, or closed the wallet's window, without agreeing.
   *  Their choice, not a failure to show. */
  declined: "The member declined in the wallet.",
  /** A room the page asked about is not shared with it, or its share ran out:
   *  ask the member to share it again (`rooms.choose`). */
  notShared: "The room is not shared with this page.",
  /** Rooms: the community lists no such offer to the member now. */
  offerNotListed: "The community lists no such room offer to the member.",
  /** Rooms: this offer is being accepted already, from another surface. */
  offerInProgress: "The offer is being accepted already.",
  /** The member holds no membership credential issued by the party an election
   *  is put to, so they are not a member of that party here. */
  membershipNotHeld: "The member holds no membership credential of that party.",
  /** The member's wallet holds no credential the request can be met with (a
   *  directory field filled from a credential). */
  credentialNotHeld: "The member holds no credential that fits.",
  /** The credential would disclose more than the member agreed to in the
   *  wallet's window; nothing was presented. */
  disclosureExceeded: "The credential would disclose more than the member agreed to.",
  /** The election's roll changed between the member's decision and the claim;
   *  nothing was presented. Read the election again. */
  rollChanged: "The election's roll changed; nothing was presented.",
  /** The agent, the community or the host did not answer in time. */
  timedOut: "No answer arrived in time.",
  /** The wallet could not reach the agent, the community or the host. */
  unreachable: "The wallet could not reach the party it needed.",
  /** The wallet itself did not answer: its background or offscreen document
   *  was not running, or the transfer's port closed. Retrying may work. */
  walletUnavailable: "The wallet did not answer.",
  /** Anything not yet given a code of its own. Show the message. */
  unclassified: "The wallet gave this failure no code.",
} as const;

export type WalletErrorCode = keyof typeof WALLET_ERROR_CODES;

/**
 * The codes the wallet's rooms engine gives a failed offer acceptance or file
 * transfer (`@openvtc/pnm-core` `RoomOfferErrorCode`, `RoomFileError`), which
 * `rooms.acceptOffer`, `rooms.getFile` and `rooms.putFile` reject with. Some
 * are the Trust Task code the host or the member's agent refused with
 * (`notAMember`, `offerExpired`, `tooLarge`, …); the rest are the engine's own
 * reading of what went wrong. Listed here so the documentation is checked
 * against the engine: a code the core adds fails to compile below until it is
 * named here, and the document's table is checked against this list.
 */
export const ROOMS_WORK_CODES = [
  "actUnsupported",
  "noRoomOffers",
  "communityRefused",
  "capability",
  "notPersona",
  "keyPackageNotHeld",
  "notAMember",
  "notFound",
  "offerExpired",
  "alreadyAccepted",
  "admissionPending",
  "keyHolderRefused",
  "keyPackageInvalid",
  "welcomeMissing",
  "joinFailed",
  "noAnswer",
  "filesDisabled",
  "tooLarge",
  "noFile",
  "blobNotNamed",
  "hostMisbehaved",
  "notVerified",
  "versionRace",
  "aborted",
] as const satisfies readonly (RoomOfferErrorCode | RoomFileError["code"])[];

/** `never` unless every engine code but `other` is in `ROOMS_WORK_CODES`. */
type UnlistedRoomsCode = Exclude<RoomOfferErrorCode | RoomFileError["code"], "other" | (typeof ROOMS_WORK_CODES)[number]>;
const roomsCodesListed: [UnlistedRoomsCode] extends [never] ? true : UnlistedRoomsCode = true;
void roomsCodesListed;

/** A Trust Task error code's local part (§8.5), or a wallet code. */
export type PageErrorCode = WalletErrorCode | (string & {});

/** What a code may look like: one camelCase name, short. */
export const PAGE_CODE = /^[a-z][A-Za-z0-9]{0,63}$/;

export function isWalletErrorCode(code: string): code is WalletErrorCode {
  return Object.hasOwn(WALLET_ERROR_CODES, code);
}

/** The failure shape every page-channel response carries. */
export interface PageFailure {
  ok: false;
  error: string;
  code: PageErrorCode;
}

/** A refusal the wallet decided, with its code. */
export class PageRefusal extends Error {
  constructor(
    message: string,
    readonly code: PageErrorCode,
  ) {
    super(message);
    this.name = "PageRefusal";
  }
}

/** The local part of a Trust Task error code (`<slug>:<local>` → `<local>`), if
 *  it is a code at all. */
export function trustTaskLocalCode(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const local = raw.slice(raw.lastIndexOf(":") + 1);
  return PAGE_CODE.test(local) ? local : undefined;
}

/**
 * The code a failure carries to the page, read off the error itself — never off
 * its message.
 *
 * In order: a code the error names (`PageRefusal`, the channels' own refusal
 * classes, `OobRefusedError`, `CastRefusedError`, the rooms errors); the Trust
 * Task code a `VtaClientError` carries in `details.code`; a transport failure
 * of the client (`e.client.timeout`, `e.client.network`); a locked wallet. A
 * failure none of these names is `unclassified`.
 */
export function pageErrorCode(e: unknown): PageErrorCode {
  if (!e || typeof e !== "object") return "unclassified";
  const err = e as { name?: unknown; code?: unknown; details?: unknown };
  if (err.name === "WalletLockedError") return "walletLocked";
  // A Trust Task refusal relayed by a VTA client: the refusing party's code.
  const details = err.details && typeof err.details === "object" ? (err.details as { code?: unknown }) : undefined;
  const fromDetails = trustTaskLocalCode(details?.code);
  if (fromDetails) return fromDetails;
  if (err.code === "e.client.timeout") return "timedOut";
  if (err.code === "e.client.network") return "unreachable";
  // A code the error names itself. `other` is a classifier's "none of these".
  const own = trustTaskLocalCode(err.code);
  if (own && own !== "other") return own;
  return "unclassified";
}

/** `e` as a page-channel failure: its message, unchanged, and its code. */
export function pageFailure(e: unknown): PageFailure {
  return { ok: false, error: e instanceof Error ? e.message : String(e), code: pageErrorCode(e) };
}

/**
 * The code to forward from a reply another wallet context sent: kept when it
 * is a code, else `fallback`. A reply is only data until checked; this is where
 * a code that is not a single name stops.
 */
export function forwardedCode(raw: unknown, fallback: PageErrorCode = "unclassified"): PageErrorCode {
  return typeof raw === "string" && PAGE_CODE.test(raw) ? raw : fallback;
}
