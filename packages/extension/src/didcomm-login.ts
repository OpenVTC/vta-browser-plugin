// What `window.vtaWallet.loginDidcomm` hands back, and when it refuses.
//
// The page-facing method is deprecated legacy sign-in, kept working unchanged
// for every page that already calls it (sign-in contract C7). Underneath, the
// sign-in it runs is `auth/challenge` then a signed `auth/authenticate`
// (`loginViaTrustTask`), because the did-hosting RP no longer serves the bare
// DIDComm authenticate (affinidi-webvh-service #213). So the result the page
// receives is mapped from an `RpSession` here, in one place, into the
// `LoginResult` shape it always had.
//
// Kept free of `chrome.*` so the shape is testable without the extension.

import type { LoginResult } from "./bridge-protocol.js";

/** The parts of the RP's session `loginDidcomm` reports. */
export interface DidcommRpSession {
  accessToken: string;
  refreshToken?: string;
  sessionId: string;
}

/**
 * The page-level result of a DIDComm sign-in: exactly the members it has
 * always carried, `accessToken`, `refreshToken`, `sessionId`, `holderDid` and
 * `timings`.
 *
 * `refreshToken` is a string on the wire. The RP may not rotate one on login,
 * and an empty string says "none" more honestly than a fabricated value would.
 * Nothing else from the session (its scope, its expiry) is added: a page that
 * deep-compares the result, or forwards it, sees what it saw before.
 */
export function didcommLoginResult(
  session: DidcommRpSession,
  holderDid: string,
  timings: { label: string; ms: number }[],
): LoginResult {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken ?? "",
    sessionId: session.sessionId,
    holderDid,
    timings,
  };
}

/**
 * Why a DIDComm sign-in is refused for this origin, or `undefined` when it is
 * not.
 *
 * A per-site persona cannot sign in over DIDComm or TSP. The RP acts on a
 * document from those transports only when its proven signer is the transport
 * sender (affinidi-webvh-service #213; the VTA and VTC apply the same rule,
 * VTI #1739), and the wallet cannot send as the persona: the persona's keys,
 * keyAgreement included, live at the VTA and never leave it. A persona signs
 * in over REST instead, where the VTA signs for it.
 */
export function didcommLoginRefusal(entryId: string | undefined): string | undefined {
  if (!entryId) return undefined;
  return (
    "a persona cannot sign in over DIDComm or TSP: the document must be sent by its signer, " +
    "and the persona's keys stay at the agent. Use the REST sign-in for this site"
  );
}
