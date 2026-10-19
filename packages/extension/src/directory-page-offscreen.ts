/// <reference types="chrome" />

// The work behind a page's `window.vtaWallet.directory.publishCard` — the
// offscreen document's half.
//
// The background has already checked that the page is the community's portal
// and which of the member's identities it is for (`directory-page.ts`). This
// module reads the member's card as them, builds the card to sign
// (`@openvtc/pnm-core/vtc`'s `buildExternalCard`), and — once the person
// approved it in the wallet's window — has their agent sign it as their DID
// (`keys/sign-document`) and sends it to the community (`card/publish`).
//
// Every document to the community is the member's, signed by their agent as
// the vault entry they sign in with; every reply is checked against the
// community's verified DID document. Nothing the agent returns is sent on
// unless it is exactly what was asked for, with a proof added.

import { CONTACT_METHODS, vaultSignTrustTask, type TrustTaskSender } from "@openvtc/pnm-core";
import {
  OobRefusedError,
  agentSignCard,
  assertSignedAsSent,
  buildCardPublish,
  buildCardShow,
  buildExternalCard,
  buildFieldsList,
  describeExternalCard,
  memberSigningKey,
  postCommunityTask,
  publishedStateOf,
  resolveCommunityDocument,
  selectSignInServices,
  verifyDomainLinkage,
  type DirectoryCard,
  type FieldDefinition,
  type OobDocument,
} from "@openvtc/pnm-core/vtc";

import type { OffscreenDirectoryPageOp, PagePublishedCardView } from "./bridge-protocol.js";

/** A `didSelfIssued` vault entry, as much of one as this needs. */
export interface DirectoryIdentity {
  id: string;
  label?: string;
  principalDid?: string;
  targets: ReadonlyArray<{ kind: string; did?: string }>;
}

/** A community, from its verified DID document. */
export interface VerifiedCommunity {
  portalOrigin: string;
  endpoint: string;
  document: Record<string, unknown>;
}

type SignTaskParties = Pick<Parameters<typeof vaultSignTrustTask>[1], "holder" | "service">;

export interface DirectoryPageDeps {
  /** The member's VTA session, and the wallet's identity and the VTA as its
   *  Trust Tasks address them. */
  agent(vtaDid: string, restBaseUrl?: string): Promise<{ sender: TrustTaskSender } & SignTaskParties>;
  /** The member's `didSelfIssued` vault entries. */
  identities(vtaDid: string, restBaseUrl?: string): Promise<DirectoryIdentity[]>;
  /** The community, resolved and verified afresh. Defaults to its DID document. */
  community?(hostDid: string): Promise<VerifiedCommunity>;
  /** The member DID's current document, for a DID that is not a `did:key`.
   *  Defaults to resolving and verifying it as a contact DID is. */
  memberDocument?(did: string): Promise<Record<string, unknown> | null>;
  /** The fetch the community is reached with. */
  fetch?: typeof fetch;
  now?(): number;
}

/** The community's portal, endpoint and verified document — as the trigger-link
 *  sign-in resolves them. A domain-linked contact must also be linked by its
 *  portal's DID Configuration. */
export async function resolveCommunity(hostDid: string, now: () => number = Date.now): Promise<VerifiedCommunity> {
  const resolved = await resolveCommunityDocument(hostDid, { contactMethods: CONTACT_METHODS });
  if (!resolved.ok) throw new Error(`${hostDid}'s DID document could not be verified (${resolved.reason})`);
  const selected = selectSignInServices(resolved.doc);
  if (!selected.ok) throw new Error(`${hostDid}'s DID document names no usable ${selected.service} service`);
  if (resolved.route === "domain-linked") {
    const linkage = await verifyDomainLinkage({
      did: hostDid,
      didDocument: resolved.doc,
      origin: selected.services.portalOrigin,
      now: now(),
    });
    if (!linkage.ok) throw new Error(`${selected.services.portalOrigin} is not linked to ${hostDid}`);
  }
  return {
    portalOrigin: selected.services.portalOrigin,
    endpoint: selected.services.trustTaskEndpoint,
    document: resolved.doc,
  };
}

/** A member DID's current document, resolved and verified; `null` when it cannot be. */
async function memberDocumentOf(did: string): Promise<Record<string, unknown> | null> {
  const resolved = await resolveCommunityDocument(did, { contactMethods: CONTACT_METHODS });
  return resolved.ok ? resolved.doc : null;
}

/** The identities the member signs in with at `hostDid`, never `hostDid` itself. */
export function identitiesAt(entries: readonly DirectoryIdentity[], hostDid: string): DirectoryIdentity[] {
  return entries.filter(
    (e) =>
      typeof e.principalDid === "string" &&
      e.principalDid !== hostDid &&
      e.targets.some((t) => t.kind === "did" && t.did === hostDid),
  );
}

/** What the community said, in the person's words. Never the raw code alone. */
function refusalWords(e: unknown, community: string): Error {
  if (!(e instanceof OobRefusedError)) return e instanceof Error ? e : new Error(String(e));
  const local = e.code.slice(e.code.lastIndexOf(":") + 1);
  const said: Record<string, string> = {
    consentRequired: `${community} doesn't publish your card while you haven't agreed to be listed in its trust registry.`,
    notAvailable: `${community} doesn't publish members' cards beyond the community.`,
    superseded: "Your card changed while you were deciding. Try again to publish what it shows now.",
    cardMismatch: `${community} says the card doesn't match what your card shows anyone — its own rules may keep some of it private. Nothing was published.`,
    signatureInvalid: `${community} couldn't verify your signature on the card. Nothing was published.`,
    notMember: `${community} doesn't count you as an active member.`,
  };
  return new Error(said[local] ?? `${community} didn't publish your card (${e.code}).`);
}

/** Run one directory operation. Throws with a message fit for the page. */
export async function runDirectoryPageOp(
  deps: DirectoryPageDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  op: OffscreenDirectoryPageOp,
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const community = (hostDid: string) => (deps.community ?? ((d) => resolveCommunity(d, now)))(hostDid);
  if (op.op === "portal") {
    const { portalOrigin, endpoint } = await community(op.hostDid);
    return { portalOrigin, endpoint };
  }
  const entries = identitiesAt(await deps.identities(vta.vtaDid, vta.restBaseUrl), op.hostDid);
  if (op.op === "members") return entries.map((e) => e.principalDid as string);

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
  const parties = { holder: { did: holder.did }, service: { did: service.did } };

  // One document to the community, as the member.
  const asMember = async <P>(unsigned: OobDocument, label: string): Promise<P> => {
    const { signedEnvelope } = await vaultSignTrustTask(sender, {
      holder,
      service,
      entryId: entry.id,
      unsignedEnvelope: unsigned as never,
    });
    const signed = assertSignedAsSent(unsigned, signedEnvelope, "authentication");
    const reply = await postCommunityTask<P>(signed, sendOpts, label, "authentication");
    return reply.doc.payload as P;
  };

  if (op.op === "prepare") {
    try {
      const { card } = await asMember<{ card: DirectoryCard }>(
        buildCardShow(op.member, op.hostDid),
        "vtc/directory/card/show",
      );
      const { fields } = await asMember<{ fields: FieldDefinition[] }>(
        buildFieldsList(op.member, op.hostDid),
        "vtc/directory/fields/list",
      );
      const draft = buildExternalCard(op.member, card, fields);
      return {
        card: draft.card,
        revision: draft.revision,
        communityName: name,
        said: describeExternalCard(name, draft),
      };
    } catch (e) {
      throw refusalWords(e, name);
    }
  }

  // op.op === "publish": signed by the member's agent as their DID, then sent.
  const memberDoc = op.member.startsWith("did:key:")
    ? null
    : await (deps.memberDocument ?? memberDocumentOf)(op.member);
  const keyId = await memberSigningKey(sender, parties, op.member, memberDoc);
  if (!keyId) {
    throw new Error(
      "Your agent doesn't hold the key this identity signs with, so it can't sign your card. Nothing was published.",
    );
  }
  const signedCard = await agentSignCard(sender, parties, keyId, op.card, op.member);
  try {
    const answer = await asMember<unknown>(
      buildCardPublish(op.member, op.hostDid, signedCard, op.revision),
      "vtc/directory/card/publish",
    );
    const state = publishedStateOf(answer);
    const view: PagePublishedCardView = { state: state.state };
    if (state.cardDigest) view.cardDigest = state.cardDigest;
    if (state.publishedAt) view.publishedAt = state.publishedAt;
    return view;
  } catch (e) {
    throw refusalWords(e, name);
  }
}
