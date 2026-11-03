/// <reference types="chrome" />

// The work behind a page's `window.vtaWallet.elections.*` — the offscreen
// document's half.
//
// The background has already checked that the page is the community's portal
// and which of the member's identities it is for (`elections-page.ts`), and
// for a ticket or a vote the person decided in the wallet's window. This module
// asks the member's VTA and carries what it returns:
//
// - a read or the ticket request goes to the community exactly as the VTA
//   signed it as the member (`vta/pcs/voter/{read,register}`), and the reply is
//   believed only once it is the community's;
// - a cast goes to the ballot box exactly as the VTA built it under a key made
//   for that cast alone, after a random pause, and the receipt goes back to the
//   VTA (`voter/receipt`). Nothing here sends a ballot or a cast to the
//   community. The reference is `pnm elections`. It runs as three operations
//   (`castPrepare`, `castPost`, `castKeep`) so the background can show the
//   member each step as it happens; the pause is the background's to choose
//   (`castDelayMs`), and is capped here.
// - under a credential roll (VTI-VOT-025), the VTA presents the member's
//   membership credential issued by exactly the roll's `memberOf` — in the
//   ticket claim, and in a read of an election put to a member party's members
//   (VTI-VOT-015) — and only where the background says the member chose to
//   (`presentFor`, `readAs`; VTI-VOT-016). The credential is picked here from
//   the member's vault, by its issuer; its handle never leaves this document.

import { credVaultQuery } from "@openvtc/pnm-core";
import {
  ELECTION_KIND,
  notificationsListAll,
  notificationsShow,
  notifiedElectionOf,
  type NotifiedElection,
} from "@openvtc/pnm-core/notifications";
import { resolveDidDocument } from "@openvtc/pnm-core/didcomm";
import { trustTaskBaseFromDocument, trustTaskUrl, type TrustTaskSender } from "@openvtc/pnm-core/vta";
import {
  OobRefusedError,
  ballotRefusal,
  MAX_CAST_DELAY_MS,
  membershipCredentialFor,
  pcsCast,
  pcsVoterAccept,
  pcsVoterRead,
  pcsVoterReceipt,
  pcsVoterRegister,
  postCast,
  postCommunityTask,
  rollCredentialOf,
  type ElectionBallot,
  type ElectionShown,
  type OobDocument,
  type ReadPresenting,
  type VoterTarget,
} from "@openvtc/pnm-core/vtc";

import type { ElectionReadAs, OffscreenElectionsPageOp } from "./bridge-protocol.js";
import {
  identitiesAt,
  resolveCommunity,
  type DirectoryIdentity,
  type VerifiedCommunity,
} from "./directory-page-offscreen.js";

export interface ElectionsPageDeps {
  /** The member's VTA session, and the wallet's identity and the VTA as its
   *  Trust Tasks address them. */
  agent(vtaDid: string, restBaseUrl?: string): Promise<{ sender: TrustTaskSender; holder: { did: string }; service: { did: string } }>;
  /** The member's `didSelfIssued` vault entries. */
  identities(vtaDid: string, restBaseUrl?: string): Promise<DirectoryIdentity[]>;
  /** The VTA context the member's identity `did` lives in: where their voter keys are derived. */
  contextOf(vtaDid: string, restBaseUrl: string | undefined, did: string): Promise<string | null>;
  /** The community, resolved and verified afresh. Defaults to its DID document. */
  community?(hostDid: string): Promise<VerifiedCommunity>;
  /** A DID document, for the ballot box. Defaults to resolving it. */
  resolve?(did: string): Promise<Record<string, unknown>>;
  fetch?: typeof fetch;
  /** The pause before a cast goes, and before a document the community answered
   *  `indeterminate` is resent; defaults to a real one. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** A refusal in the person's words, with the refusing party's code (its local
 *  name) for the background to switch on. */
export class ElectionsWorkError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ElectionsWorkError";
  }
}

/** The local name of a VTA refusal's Trust Task error code (`details.code`). */
function vtaRefusalCode(e: unknown): string | undefined {
  const code = (e as { details?: { code?: unknown } } | null)?.details?.code;
  return typeof code === "string" ? code.slice(code.lastIndexOf(":") + 1) : undefined;
}

/** What the community or the VTA said, in the person's words. */
function refusalWords(e: unknown, community: string): Error {
  if (e instanceof ElectionsWorkError) return e;
  const text = e instanceof Error ? e.message : String(e);
  if (e instanceof OobRefusedError) {
    const local = e.code.slice(e.code.lastIndexOf(":") + 1);
    const said: Record<string, string> = {
      electionUnknown: `${community} shows you no such election — it may not be open to you.`,
      indeterminate: `${community} could not check your membership credential just now: its issuer's DID document or status list could not be read. Nothing was recorded. Try again in a little while.`,
      presentationRequired: `${community} needs your membership credential to give you a ticket for this election.`,
      membershipNotProven: `${community} did not accept your membership credential for this election.`,
      membershipRevoked: `Your membership credential for this election has been revoked.`,
      rollUntrusted: `${community} no longer accepts the party this election's roll names. Ask the community about it.`,
      notOpen: "Tickets for this election are not being issued now.",
      alreadyIssued: `${community} has issued your ticket for this election already.`,
      notEligible: "This election's roll does not admit you.",
      manifestMismatch: `${community} changed this election while you were taking your ticket. Try again.`,
      permissionDenied: `${community} doesn't count you as an active member.`,
    };
    return new ElectionsWorkError(said[local] ?? `${community} refused (${e.code}).`, local);
  }
  const vta = vtaRefusalCode(e);
  const vtaSaid: Record<string, string> = {
    membershipCredentialMismatch: "Your agent will present only a membership credential issued by the party this election names, and that one was not.",
    membershipCredentialUnusable: "Your agent cannot present that membership credential: it is not in your vault, not about you, revoked or out of date.",
    membershipCredentialRequired: "This election's roll asks for your membership credential, and none was given to your agent.",
  };
  if (vta && vtaSaid[vta]) return new ElectionsWorkError(vtaSaid[vta]!, vta);
  if (/memberNotHeld/.test(text)) {
    return new Error("Your agent holds no key of the identity you signed in with that you may act as.");
  }
  return e instanceof Error ? e : new Error(text);
}

/** The ballot box's cast door, `<TrustTaskHTTPS base>/trust-tasks`, from its DID document. */
export async function ballotBoxEndpoint(
  ballotBox: string,
  resolve: (did: string) => Promise<Record<string, unknown>> = resolveDidDocument,
): Promise<string> {
  const base = trustTaskBaseFromDocument(await resolve(ballotBox));
  if (!base) throw new Error(`The ballot box ${ballotBox} advertises no HTTPS door to cast on.`);
  return trustTaskUrl(base);
}

/** The member's voter reads and credentials at one community, as `target`. */
async function voterWork(
  deps: ElectionsPageDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  target: VoterTarget,
  now: () => number,
  community: (hostDid: string) => Promise<VerifiedCommunity>,
) {
  const verified = await community(target.community);
  const sendOpts = {
    vtcDid: target.community,
    vtcDocument: verified.document,
    trustTaskEndpoint: verified.endpoint,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    // The wait before a document the community could not yet check goes again.
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  const { sender, holder, service } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
  const agent = { holder, service };

  /** The member's membership credential issued by exactly `memberOf`, about
   *  them: its vault handle, or `null` when they hold none. */
  const membership = async (memberOf: string): Promise<string | null> => {
    const held = await credVaultQuery(sender, { holder, service, issuerDid: memberOf, subjectDid: target.member, status: "valid" });
    return membershipCredentialFor(held, memberOf, now());
  };
  const noMembership = (memberOf: string) =>
    new ElectionsWorkError(`You don't hold a membership credential issued by ${memberOf}, so you are not a member of that party here.`, "membershipNotHeld");
  const presenting = async (readAs: ElectionReadAs | undefined): Promise<ReadPresenting | undefined> => {
    if (!readAs) return undefined;
    const handle = await membership(readAs.memberOf);
    if (!handle) throw noMembership(readAs.memberOf);
    return { membershipCredential: handle, memberOf: readAs.memberOf };
  };

  /** A document the VTA signed as the member, sent to the community unchanged. */
  const toCommunity = async <P>(doc: unknown, label: string): Promise<P> => {
    const reply = await postCommunityTask<P>(doc as OobDocument, sendOpts, label, "authentication");
    return reply.payload;
  };
  const read = async <P>(which: "list" | "show", payload: Record<string, unknown>, readAs?: ElectionReadAs): Promise<P> => {
    // A presenting read is a fresh document each time: the community accepts a
    // presentation in one document once (show/0.6 item 8).
    const signed = await pcsVoterRead(sender, agent, target, which, payload, await presenting(readAs));
    return toCommunity<P>(signed.document, `vtc/elections/${which}`);
  };
  const show = (electionId: string, readAs?: ElectionReadAs) => read<ElectionShown>("show", { electionId }, readAs);
  return { sender, agent, membership, noMembership, toCommunity, read, show };
}

/** Run one elections operation. Throws with a message fit for the person. */
export async function runElectionsPageOp(
  deps: ElectionsPageDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  op: OffscreenElectionsPageOp,
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const community = (hostDid: string) => (deps.community ?? ((d) => resolveCommunity(d, now)))(hostDid);
  if (op.op === "portal") {
    const { portalOrigin, endpoint } = await community(op.hostDid);
    return { portalOrigin, endpoint };
  }
  if (op.op === "ballotBox") {
    return { endpoint: await ballotBoxEndpoint(op.ballotBox, deps.resolve) };
  }
  if (op.op === "castPost") {
    // So the cast's arrival is not timed to anything the community saw.
    const delay = Math.min(Math.max(0, Math.floor(Number(op.delayMs) || 0)), MAX_CAST_DELAY_MS);
    await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
    const receipt = await postCast(op.castDocument, {
      ballotBox: op.ballotBox,
      endpoint: op.endpoint,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    return { receipt };
  }
  // An election the member was notified of (VTI-NTF-063), opened from the
  // wallet's own view: the community, the election and the member it was
  // addressed to come from the notification the VTA holds — read afresh here,
  // never taken from the caller — and the member need not sign in to that
  // community at all (a member of a party the community's roll names).
  if (op.op === "notifiedTarget" || op.op === "notifiedShow" || op.op === "notifiedMembership") {
    const { sender, holder, service } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
    const held = notifiedElectionOf((await notificationsShow(sender, { holder, service }, op.contextId, op.recordId)).item);
    if (!held) throw new ElectionsWorkError("That notification is not of an election.", "notAnElection");
    if (op.op === "notifiedTarget") {
      const { endpoint } = await community(held.community);
      return { ...held, endpoint };
    }
    if (held.status === "withdrawn") {
      throw new ElectionsWorkError("The community withdrew this election: it is cancelled, or no longer open to you.", "withdrawn");
    }
    const target: VoterTarget = { contextId: held.contextId, community: held.community, member: held.addressee };
    const work = await voterWork(deps, vta, target, now, community);
    try {
      if (op.op === "notifiedMembership") return { held: (await work.membership(held.audience)) !== null };
      return await work.show(held.electionId, op.present ? { memberOf: held.audience } : undefined);
    } catch (e) {
      throw refusalWords(e, "The community");
    }
  }

  const entries = identitiesAt(await deps.identities(vta.vtaDid, vta.restBaseUrl), op.hostDid);
  if (op.op === "members") {
    return entries.map((e) => ({ did: e.principalDid as string, communityName: e.label?.trim() || "This community" }));
  }

  const entry = entries.find((e) => e.principalDid === op.member);
  if (!entry) throw new Error("The wallet holds no such identity for this community.");
  const name = entry.label?.trim() || "This community";
  const contextId = await deps.contextOf(vta.vtaDid, vta.restBaseUrl, op.member);
  if (!contextId) throw new Error("Your agent does not list the identity you signed in with, so it cannot vote as it.");
  const target: VoterTarget = { contextId, community: op.hostDid, member: op.member };

  if (op.op === "notified") {
    // The notifications of this community's elections the VTA holds in the
    // context of the identity the member uses there (VTI-NTF-050, VTI-NTF-063).
    // A read of the member's own agent: nothing is sent to the community or to
    // anyone else because of it (VTI-NTF-053).
    const { sender, holder, service } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
    const held = await notificationsListAll(sender, { holder, service }, contextId, { kind: ELECTION_KIND, heldBy: op.hostDid });
    return held
      .map(notifiedElectionOf)
      .filter((n): n is NotifiedElection => n !== null && n.community === op.hostDid);
  }

  const { sender, agent, membership, noMembership, toCommunity, read, show } = await voterWork(deps, vta, target, now, community);

  try {
    switch (op.op) {
      case "list":
        return await read("list", {});
      case "show":
        return await show(op.electionId, op.readAs);
      case "membership":
        return { held: (await membership(op.memberOf)) !== null };
      case "takeTicket": {
        const shown = await show(op.electionId, op.readAs);
        // Under a credential roll the claim presents the member's credential for
        // `roll.memberOf` — only the one the member was told of and chose to
        // show (VTI-VOT-016, VTI-VOT-025).
        const roll = rollCredentialOf(shown);
        let credential: string | undefined;
        if (roll) {
          if (op.presentFor !== roll.memberOf) {
            throw new ElectionsWorkError(
              `${name} changed whose membership this election's ticket asks for. Nothing was presented; open the election again.`,
              "rollChanged",
            );
          }
          credential = (await membership(roll.memberOf)) ?? undefined;
          if (!credential) throw noMembership(roll.memberOf);
        }
        let registered;
        try {
          registered = await pcsVoterRegister(sender, agent, target, shown, credential);
        } catch (e) {
          // The agent holds this election's ticket already.
          if (/ticketHeld/.test(e instanceof Error ? e.message : String(e))) return { taken: false };
          throw e;
        }
        if (registered.manifestDigest !== shown.manifestDigest) {
          throw new Error(`Your agent computed another digest for this election than ${name} shows. No ticket was taken.`);
        }
        if (!registered.ticketDocument) throw new Error("Your agent did not sign the ticket request as you.");
        const issued = await toCommunity<Record<string, unknown>>(registered.ticketDocument, "vtc/elections/tickets/issue");
        const { ext: _ext, ...response } = issued;
        await pcsVoterAccept(sender, agent, target, op.electionId, shown.parameters, response);
        return { taken: true };
      }
      case "castPrepare": {
        const shown = await show(op.electionId, op.readAs);
        const ballot = op.ballot as ElectionBallot;
        const refused = ballotRefusal(shown.manifest, shown.manifestDigest, ballot);
        if (refused) throw new Error(`${refused} ${name} may have changed the election since you filled it in.`);
        const endpoint = await ballotBoxEndpoint(shown.manifest.ballotBox, deps.resolve);
        const { castDocument } = await pcsCast(sender, agent, target, shown, ballot);
        return { castDocument, endpoint, ballotBox: shown.manifest.ballotBox };
      }
      case "castKeep": {
        const kept = await pcsVoterReceipt(sender, agent, target, op.electionId, op.receipt);
        return { status: kept.status, ...(kept.leafIndex !== undefined ? { leafIndex: kept.leafIndex } : {}) };
      }
    }
  } catch (e) {
    throw refusalWords(e, name);
  }
}
