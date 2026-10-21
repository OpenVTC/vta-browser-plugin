/// <reference types="chrome" />

// The work behind a page's `window.vtaWallet.git.*` — the offscreen document's
// half.
//
// The background has already checked that the page is the community's portal
// and which of the member's identities it is for (`git-page.ts`), and the
// person approved. This module has the member's agent sign
// `git-ns/account/link` or `git-ns/account/unlink` as the vault entry they sign
// in with, and sends it to the community; every reply is checked against the
// community's verified DID document, and a link's answer must name an `https:`
// page to authorise it.

import { vaultSignTrustTask } from "@openvtc/pnm-core";
import {
  OobRefusedError,
  assertSignedAsSent,
  buildAccountLink,
  buildAccountUnlink,
  linkStartedOf,
  postCommunityTask,
  unlinkedOf,
  type OobDocument,
} from "@openvtc/pnm-core/vtc";

import type { OffscreenGitPageOp } from "./bridge-protocol.js";
import { identitiesAt, resolveCommunity, type DirectoryPageDeps } from "./directory-page-offscreen.js";

/** The same as the directory's: the member's agent, their identities, and the
 *  community resolved and verified afresh. */
export type GitPageDeps = Pick<DirectoryPageDeps, "agent" | "identities" | "community" | "fetch" | "now">;

/** What the community said, in the person's words. Never the raw code alone. */
function refusalWords(e: unknown, community: string, forge: string): Error {
  if (!(e instanceof OobRefusedError)) return e instanceof Error ? e : new Error(String(e));
  const local = e.code.slice(e.code.lastIndexOf(":") + 1);
  const said: Record<string, string> = {
    unsupportedForge: `${community} has no bridge on ${forge} to link an account through.`,
    notLinked: `No account is linked on ${forge} — or it changed since the page read it. Reload and try again.`,
    permissionDenied: `${community} doesn't count you as an active member.`,
  };
  return new Error(said[local] ?? `${community} refused (${e.code}).`);
}

/** Run one git operation. Throws with a message fit for the page. */
export async function runGitPageOp(
  deps: GitPageDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  op: OffscreenGitPageOp,
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const community = (hostDid: string) => (deps.community ?? ((d) => resolveCommunity(d, now)))(hostDid);
  if (op.op === "portal") {
    const { portalOrigin, endpoint } = await community(op.hostDid);
    return { portalOrigin, endpoint };
  }
  const entries = identitiesAt(await deps.identities(vta.vtaDid, vta.restBaseUrl), op.hostDid);
  if (op.op === "members") {
    return entries.map((e) => ({ did: e.principalDid as string, communityName: e.label?.trim() || "This community" }));
  }

  const entry = entries.find((e) => e.principalDid === op.member);
  if (!entry) throw new Error("The wallet holds no such identity for this community.");
  const name = entry.label?.trim() || "This community";
  const verified = await community(op.hostDid);
  const sendOpts = {
    vtcDid: op.hostDid,
    vtcDocument: verified.document,
    trustTaskEndpoint: verified.endpoint,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  const { sender, holder, service } = await deps.agent(vta.vtaDid, vta.restBaseUrl);

  // One document to the community, as the member.
  const asMember = async (unsigned: OobDocument, label: string): Promise<unknown> => {
    const { signedEnvelope } = await vaultSignTrustTask(sender, {
      holder,
      service,
      entryId: entry.id,
      unsignedEnvelope: unsigned as never,
    });
    const signed = assertSignedAsSent(unsigned, signedEnvelope, "authentication");
    const reply = await postCommunityTask<unknown>(signed, sendOpts, label, "authentication");
    return reply.doc.payload;
  };

  try {
    if (op.op === "link") {
      return linkStartedOf(await asMember(buildAccountLink(op.member, op.hostDid, op.forge), "git-ns/account/link"));
    }
    return unlinkedOf(
      await asMember(buildAccountUnlink(op.member, op.hostDid, op.forge, op.accountId), "git-ns/account/unlink"),
    );
  } catch (e) {
    throw refusalWords(e, name, op.forge);
  }
}
