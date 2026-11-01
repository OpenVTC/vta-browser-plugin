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
//   community. The reference is `pnm elections`.

import { resolveDidDocument } from "@openvtc/pnm-core/didcomm";
import { trustTaskBaseFromDocument, trustTaskUrl, type TrustTaskSender } from "@openvtc/pnm-core/vta";
import {
  OobRefusedError,
  ballotRefusal,
  castDelayMs,
  pcsCast,
  pcsVoterAccept,
  pcsVoterRead,
  pcsVoterReceipt,
  pcsVoterRegister,
  postCast,
  postCommunityTask,
  type ElectionBallot,
  type ElectionShown,
  type OobDocument,
  type VoterTarget,
} from "@openvtc/pnm-core/vtc";

import type { OffscreenElectionsPageOp } from "./bridge-protocol.js";
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
  /** The pause before a cast goes; defaults to a real one. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** What the community or the VTA said, in the person's words. */
function refusalWords(e: unknown, community: string): Error {
  const text = e instanceof Error ? e.message : String(e);
  if (e instanceof OobRefusedError) {
    const local = e.code.slice(e.code.lastIndexOf(":") + 1);
    const said: Record<string, string> = {
      electionUnknown: `${community} shows you no such election — it may not be open to you.`,
      notOpen: "Tickets for this election are not being issued now.",
      alreadyIssued: `${community} has issued your ticket for this election already.`,
      notEligible: "This election's roll does not admit you.",
      manifestMismatch: `${community} changed this election while you were taking your ticket. Try again.`,
      permissionDenied: `${community} doesn't count you as an active member.`,
    };
    return new Error(said[local] ?? `${community} refused (${e.code}).`);
  }
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
  const verified = await community(op.hostDid);
  const sendOpts = {
    vtcDid: op.hostDid,
    vtcDocument: verified.document,
    trustTaskEndpoint: verified.endpoint,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  const { sender, holder, service } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
  const agent = { holder, service };

  /** A document the VTA signed as the member, sent to the community unchanged. */
  const toCommunity = async <P>(doc: unknown, label: string): Promise<P> => {
    const reply = await postCommunityTask<P>(doc as OobDocument, sendOpts, label, "authentication");
    return reply.payload;
  };
  const read = async <P>(which: "list" | "show", payload: Record<string, unknown>): Promise<P> => {
    const signed = await pcsVoterRead(sender, agent, target, which, payload);
    return toCommunity<P>(signed.document, `vtc/elections/${which}`);
  };

  try {
    switch (op.op) {
      case "list":
        return await read("list", {});
      case "show":
        return await read<ElectionShown>("show", { electionId: op.electionId });
      case "takeTicket": {
        const shown = await read<ElectionShown>("show", { electionId: op.electionId });
        let registered;
        try {
          registered = await pcsVoterRegister(sender, agent, target, shown);
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
      case "cast": {
        const shown = await read<ElectionShown>("show", { electionId: op.electionId });
        const ballot = op.ballot as ElectionBallot;
        const refused = ballotRefusal(shown.manifest, shown.manifestDigest, ballot);
        if (refused) throw new Error(`${refused} ${name} may have changed the election since you filled it in.`);
        const endpoint = await ballotBoxEndpoint(shown.manifest.ballotBox, deps.resolve);
        const { castDocument } = await pcsCast(sender, agent, target, shown, ballot);
        // So the cast's arrival is not timed to anything the community saw.
        await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(castDelayMs());
        const receipt = await postCast(castDocument, {
          ballotBox: shown.manifest.ballotBox,
          endpoint,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        const kept = await pcsVoterReceipt(sender, agent, target, op.electionId, receipt);
        const outcome = (receipt.payload as { outcome?: unknown } | undefined)?.outcome;
        return { status: typeof outcome === "string" ? outcome : kept.status, leafIndex: kept.leafIndex };
      }
    }
  } catch (e) {
    throw refusalWords(e, name);
  }
}
