/// <reference types="chrome" />

// The work behind a page's `window.vtaWallet.directory.publishCard` and
// `presentCredential` — the offscreen document's half.
//
// The background has already checked that the page is the community's portal
// and which of the member's identities it is for (`directory-page.ts`). This
// module reads the member's card as them, builds the card to sign
// (`@openvtc/pnm-core/vtc`'s `buildExternalCard`), and — once the person
// approved it in the wallet's window — has their agent sign it as their DID
// (`keys/sign-document`) and sends it to the community (`card/publish`).
//
// For `presentCredential` it reads what the named fields ask of a credential
// (`fields/list`, as the member) and the member's credentials that answer it
// (`vault/credentials/query`), and — once the person chose one — has their agent
// present it to the community, bound to the `card/present` document that
// carries it (`vault/credentials/present`), and sends that document.
//
// Every document to the community is the member's, signed by their agent as
// the vault entry they sign in with; every reply is checked against the
// community's verified DID document. Nothing the agent returns is sent on
// unless it is exactly what was asked for, with a proof added.

import {
  CONTACT_METHODS,
  CRED_PRESENT_WOULD_OVER_DISCLOSE,
  annotateContact,
  credVaultPresent,
  credVaultQuery,
  deleteList,
  linkContact,
  listAllAnnotated,
  listLists,
  putList,
  vaultSignTrustTask,
  type TrustTaskSender,
} from "@openvtc/pnm-core";
import {
  OobRefusedError,
  agentSignCard,
  assertSignedAsSent,
  buildCardPresent,
  buildCardPublish,
  buildCardShow,
  buildExternalCard,
  buildFieldsList,
  credentialAskFor,
  describeExternalCard,
  memberSigningKey,
  postCommunityTask,
  publishedStateOf,
  resolveCommunityDocument,
  selectSignInServices,
  verifiedValuesOf,
  verifyDomainLinkage,
  type DirectoryCard,
  type FieldDefinition,
  type OobDocument,
} from "@openvtc/pnm-core/vtc";

import type {
  OffscreenDirectoryPageOp,
  PageEntryMark,
  PageMarkList,
  PageMarksView,
  PagePublishedCardView,
  PageVerifiedFieldsView,
  PreparedPresent,
} from "./bridge-protocol.js";

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
  /** The VTA context the member's identity `did` lives in — where their own
   *  contacts and marks are kept. */
  contextOf?(vtaDid: string, restBaseUrl: string | undefined, did: string): Promise<string | null>;
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

/** The trust-task-error code and details an agent or community refusal carries. */
function refusalCode(e: unknown): { code: string; details?: Record<string, unknown> } | null {
  if (e instanceof OobRefusedError) return { code: e.code };
  const payload = (e as { details?: unknown } | null)?.details as
    | { code?: unknown; details?: Record<string, unknown> }
    | undefined;
  return typeof payload?.code === "string"
    ? { code: payload.code, ...(payload.details ? { details: payload.details } : {}) }
    : null;
}

/** What the agent said about a presentation, in the person's words. */
function presentRefusalWords(e: unknown): Error {
  const code = refusalCode(e)?.code;
  const said: Record<string, string> = {
    "vault/credentials/present:notFound":
      "Your agent no longer holds that credential, or not the key it is presented with. Nothing was presented.",
    "vault/credentials/present:notPresentable":
      "That credential has expired, been revoked or been put away, so it can't be presented.",
    "vault/credentials/present:claimNotHeld": "That credential doesn't carry what these fields ask for.",
    "vault/credentials/present:formatUnsupported": "Your agent can't present a credential of that kind here.",
  };
  if (code && said[code]) return new Error(said[code]);
  return e instanceof Error ? e : new Error(String(e));
}

/** What the community said about a presentation, in the person's words. */
function cardPresentRefusalWords(e: unknown, community: string): Error {
  if (!(e instanceof OobRefusedError)) return e instanceof Error ? e : new Error(String(e));
  const local = e.code.slice(e.code.lastIndexOf(":") + 1);
  const said: Record<string, string> = {
    notMember: `${community} doesn't count you as an active member.`,
    fieldUnknown: `${community}'s directory no longer has one of those fields.`,
    fieldNotWritable: `${community}'s directory doesn't fill one of those fields from a credential.`,
    presentationInvalid: `${community} couldn't verify the credential as yours. Nothing was added to your card.`,
    issuerNotAccepted: `${community} doesn't accept that credential's issuer for one of those fields.`,
    claimMissing: `The credential doesn't show what one of those fields reads.`,
  };
  return new Error(said[local] ?? `${community} didn't add the credential to your card (${e.code}).`);
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
  if (op.op === "communityName") return name;
  if (op.op === "marks" || op.op === "mark" || op.op === "putList" || op.op === "deleteList") {
    return runMarksOp(deps, vta, op);
  }
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

  if (op.op === "preparePresent") {
    let fields: FieldDefinition[];
    try {
      ({ fields } = await asMember<{ fields: FieldDefinition[] }>(
        buildFieldsList(op.member, op.hostDid),
        "vtc/directory/fields/list",
      ));
    } catch (e) {
      throw refusalWords(e, name);
    }
    const asked = credentialAskFor(fields, op.fields);
    if (!asked.ok) throw new Error(asked.error);
    const { ask } = asked;
    const held = await credVaultQuery(sender, { holder, service, type: ask.credentialType, status: "valid" });
    const candidates = held
      .filter((c) => !c.lifecycle || c.lifecycle === "active")
      .filter((c) => !ask.issuers || (c.issuerDid !== undefined && ask.issuers.includes(c.issuerDid)))
      .map((c) => ({
        id: c.id,
        ...(c.issuerDid ? { issuerDid: c.issuerDid } : {}),
        types: [...c.types],
        ...(c.validUntil ? { validUntil: c.validUntil } : {}),
      }));
    if (candidates.length === 0) {
      throw new Error(
        ask.issuers
          ? `Your wallet holds no ${ask.credentialType} from an issuer ${name} accepts for ${ask.fields.map((f) => f.label).join(", ")}.`
          : `Your wallet holds no ${ask.credentialType} to verify ${ask.fields.map((f) => f.label).join(", ")} with.`,
      );
    }
    const prepared: PreparedPresent = { communityName: name, fields: ask.fields, claims: ask.claims, candidates };
    return prepared;
  }

  if (op.op === "present") {
    // The document's id is the presentation's nonce, so it exists first; a
    // retry after a refusal is a fresh document and a fresh nonce.
    const id = globalThis.crypto.randomUUID();
    let presentation: Record<string, unknown> | string;
    try {
      const res = await credVaultPresent(sender, {
        holder,
        service,
        id: op.credentialId,
        audience: op.hostDid,
        nonce: id,
        claims: op.claims,
        purpose: `Verified fields on my card in ${name}'s member directory`,
      });
      presentation = res.presentation as Record<string, unknown> | string;
    } catch (e) {
      const refused = refusalCode(e);
      if (refused?.code === CRED_PRESENT_WOULD_OVER_DISCLOSE) {
        const undisclosed = refused.details?.undisclosed;
        if (Array.isArray(undisclosed) && undisclosed.every((c) => typeof c === "string") && undisclosed.length > 0) {
          return { undisclosed: undisclosed as string[] };
        }
      }
      throw presentRefusalWords(e);
    }
    try {
      const answer = await asMember<unknown>(
        buildCardPresent(id, op.member, op.hostDid, op.fields, presentation),
        "vtc/directory/card/present",
      );
      const view: PageVerifiedFieldsView = verifiedValuesOf(answer) as PageVerifiedFieldsView;
      return view;
    } catch (e) {
      throw cardPresentRefusalWords(e, name);
    }
  }

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

// ─── The member's own marks ─────────────────────────────────────────────────
//
// Stars, petnames and lists, kept by the member's own agent
// (`persona/contact/*/1.1`, `persona/contact/lists/*/1.0`). Nothing here talks
// to the community: every call is to the member's agent, in the context their
// identity at the community lives in, and only contacts linked to this
// community's directory are read back.

type MarksOp = Extract<OffscreenDirectoryPageOp, { op: "marks" | "mark" | "putList" | "deleteList" }>;

function listView(l: {
  listId: string;
  name: string;
  colour?: string;
  order: number;
  contactCount: number;
}): PageMarkList {
  return {
    listId: l.listId,
    name: l.name,
    order: l.order,
    contactCount: l.contactCount,
    ...(l.colour ? { colour: l.colour } : {}),
  };
}

async function runMarksOp(
  deps: DirectoryPageDeps,
  vta: { vtaDid: string; restBaseUrl?: string },
  op: MarksOp,
): Promise<PageMarksView | PageEntryMark | PageMarkList | { deleted: boolean }> {
  const contextId = await (deps.contextOf ?? (async () => null))(vta.vtaDid, vta.restBaseUrl, op.member);
  if (!contextId) {
    throw new Error("Your agent doesn't hold the identity you use at this community, so it has nowhere to keep your marks.");
  }
  const { sender, holder, service } = await deps.agent(vta.vtaDid, vta.restBaseUrl);
  const caller = { holder, service, contextId };

  // The contacts linked to this community's directory, by entry. One contact
  // per entry: the member's own (`knownByPersona` = their identity here) wins
  // over one another of their personas keeps.
  const linked = async () => {
    const all = await listAllAnnotated(sender, { ...caller, directoryVtcDid: op.hostDid });
    const byEntry = new Map<string, (typeof all)[number]>();
    for (const c of all) {
      const entryId = c.directoryRef?.entryId;
      if (!entryId || c.directoryRef?.vtcDid !== op.hostDid) continue;
      const held = byEntry.get(entryId);
      if (!held || (held.knownByPersona !== op.member && c.knownByPersona === op.member)) byEntry.set(entryId, c);
    }
    return byEntry;
  };
  const markOf = (c: { starred: boolean; petname?: string; lists?: readonly string[] } | undefined): PageEntryMark => ({
    starred: c?.starred ?? false,
    ...(c?.petname ? { petname: c.petname } : {}),
    ...(c?.lists && c.lists.length > 0 ? { lists: [...c.lists] } : {}),
  });

  switch (op.op) {
    case "marks": {
      const [byEntry, lists] = await Promise.all([linked(), listLists(sender, caller)]);
      const entries: Record<string, PageEntryMark> = {};
      for (const [entryId, c] of byEntry) entries[entryId] = markOf(c);
      return { entries, lists: lists.lists.map(listView) };
    }
    case "mark": {
      const change = {
        ...(op.starred !== undefined ? { starred: op.starred } : {}),
        ...(op.petname !== undefined ? { petname: op.petname } : {}),
        ...(op.removePetname ? { removePetname: true as const } : {}),
        ...(op.lists !== undefined ? { lists: op.lists } : {}),
      };
      const held = (await linked()).get(op.entryId);
      if (held) {
        await annotateContact(sender, { ...caller, contactId: held.contactId, change });
      } else {
        await linkContact(sender, {
          ...caller,
          knownByPersona: op.member,
          directoryRef: { vtcDid: op.hostDid, entryId: op.entryId },
          change,
        });
      }
      return markOf((await linked()).get(op.entryId));
    }
    case "putList": {
      const res = await putList(sender, {
        ...caller,
        ...(op.listId !== undefined ? { listId: op.listId } : {}),
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.colour !== undefined ? { colour: op.colour } : {}),
      });
      return listView(res.list);
    }
    case "deleteList": {
      const res = await deleteList(sender, { ...caller, listId: op.listId });
      return { deleted: res.existed };
    }
  }
}
