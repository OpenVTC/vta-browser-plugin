// A member's external directory card (`vtc/directory/card/publish/0.1`): the
// values they show to anyone, as a JSContact card (RFC 9553) the member signs
// themselves, which the community then serves beyond the community and points
// its trust registry to.
//
// The card is the member's statement, never the community's. So the wallet
// builds it from the member's own card (`vtc/directory/card/show`) and the
// community's field schema (`vtc/directory/fields/list`), shows the person every
// value it will carry and who can read it — anyone, outside the community too
// (VTI-REG-004 item 2) — and only then has their agent sign it
// (`keys/sign-document`) and sends it.
//
// The shape is fixed member for member (`card/publish`, *Mapping the public
// values*): the community compares the card with the member's public values
// exactly, so two wallets must sign the same bytes for the same values.

import type {
  CardBlobRef,
  DirectoryCard,
  ExternalCard,
} from "@openvtc/trust-tasks/vtc/directory/card/show/0.1/payload";
import { TYPE_URI as CARD_SHOW } from "@openvtc/trust-tasks/vtc/directory/card/show/0.1/payload";
import type { FieldDefinition } from "@openvtc/trust-tasks/vtc/directory/fields/list/0.1/payload";
import { TYPE_URI as FIELDS_LIST } from "@openvtc/trust-tasks/vtc/directory/fields/list/0.1/payload";
import { TYPE_URI as CARD_PUBLISH } from "@openvtc/trust-tasks/vtc/directory/card/publish/0.1/payload";
import {
  TYPE_URI as KEYS_LIST,
  RESPONSE_TYPE_URI as KEYS_LIST_RESPONSE,
} from "@openvtc/trust-tasks/keys/list/0.1/payload";
import type { KeyRecord } from "@openvtc/trust-tasks/keys/list/0.1/payload";
import {
  TYPE_URI as KEYS_SIGN_DOCUMENT,
  RESPONSE_TYPE_URI as KEYS_SIGN_DOCUMENT_RESPONSE,
} from "@openvtc/trust-tasks/keys/sign-document/0.1/payload";
import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { decodeMultibase } from "../trust-tasks/digest.js";
import { OobReplyInvalidError, type OobDocument } from "./oob-sign-in.js";

export type { DirectoryCard, ExternalCard, FieldDefinition };
export { CARD_SHOW, FIELDS_LIST, CARD_PUBLISH };

/** A card's `uid` is this and its entry identifier. */
export const CARD_UID_PREFIX = "urn:vtc-directory:";

/** One value the card will carry, as the person is shown it. */
export interface PublishedValue {
  key: string;
  /** The community's label for the field: its own words, shown as text. */
  label: string;
  /** The value as text, or `null` for a picture (shown as the picture). */
  text: string | null;
  /** The picture's reference, for a picture field. */
  picture?: CardBlobRef;
}

/** The card to sign, and what it says in the person's words. */
export interface ExternalCardDraft {
  /** The unsigned JSContact card, exactly as it is to be signed. */
  card: Record<string, unknown>;
  /** Every value it carries, in the community's field order. */
  values: PublishedValue[];
  /** The card revision it was built from (`expectedRevision`). */
  revision: number;
  entryId: string;
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

/** `vtc/directory/card/show`, unsigned, as the member. */
export function buildCardShow(memberDid: string, vtcDid: string): OobDocument<Record<string, never>> {
  return envelope(CARD_SHOW, memberDid, vtcDid, {});
}

/** `vtc/directory/fields/list`, unsigned, as the member. */
export function buildFieldsList(memberDid: string, vtcDid: string): OobDocument<Record<string, never>> {
  return envelope(FIELDS_LIST, memberDid, vtcDid, {});
}

/**
 * The values the public is shown of `card`: active fields, holding a value,
 * that the member shows to `public` under a `public` ceiling.
 *
 * The community's `directory` policy may narrow this further; a card built
 * from what it withholds is refused `cardMismatch`, naming the fields.
 */
export function publicValues(
  card: DirectoryCard,
  fields: readonly FieldDefinition[],
): Array<{ field: FieldDefinition; value: unknown }> {
  const values = (card.values ?? {}) as Record<string, unknown>;
  const visibility = (card.visibility ?? {}) as Record<string, string>;
  return [...fields]
    .filter((f) => f.state === "active" && f.ceiling === "public")
    .filter((f) => (visibility[f.key] ?? f.defaultVisibility) === "public")
    .filter((f) => values[f.key] !== undefined && values[f.key] !== null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((field) => ({ field, value: values[field.key] }));
}

function blobRef(v: unknown): CardBlobRef | null {
  const r = v as Partial<CardBlobRef> | null;
  return r && typeof r === "object" && typeof r.sha256 === "string" && typeof r.mediaType === "string"
    ? (r as CardBlobRef)
    : null;
}

/** One field's JSContact member, as the specification fixes it. */
function mapField(entryId: string, field: FieldDefinition, value: unknown): [string, unknown] {
  const path = field.base ? field.jsContactPath : undefined;
  switch (path) {
    case "name.full":
      return ["name", { full: value }];
    case "nicknames":
      return ["nicknames", { k1: { name: value } }];
    case "media": {
      const ref = blobRef(value);
      return [
        "media",
        {
          m1: {
            kind: "photo",
            uri: `${CARD_UID_PREFIX}${entryId}:${field.key}:${ref?.sha256 ?? ""}`,
            mediaType: ref?.mediaType ?? null,
          },
        },
      ];
    }
    case "speakToAs.pronouns":
      return ["speakToAs", { pronouns: { p1: { pronouns: value } } }];
    case "notes":
      return ["notes", { n1: { note: value } }];
    case "links":
      if (Array.isArray(value)) {
        return ["links", Object.fromEntries(value.map((uri, i) => [`l${i + 1}`, { uri }]))];
      }
      break;
  }
  // Any other field: a member named by its key, holding the value as the card
  // holds it. A picture reference never carries a URL.
  const ref = blobRef(value);
  if (ref) {
    const { url: _url, urlExpiresAt: _exp, ...kept } = ref as CardBlobRef & { url?: string; urlExpiresAt?: string };
    return [field.key, kept];
  }
  return [field.key, value];
}

function asText(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (v === true) return "Yes";
  if (v === false) return "No";
  return String(v);
}

/**
 * The card the member would publish now: their public values, mapped exactly,
 * framed by `@type`, `version`, `uid` (their entry) and `issuer` (their
 * membership DID — the DID the agent signs as).
 */
export function buildExternalCard(
  memberDid: string,
  card: DirectoryCard,
  fields: readonly FieldDefinition[],
): ExternalCardDraft {
  const entryId = card.entryId as string;
  const out: Record<string, unknown> = {
    "@type": "Card",
    version: "1.0",
    uid: `${CARD_UID_PREFIX}${entryId}`,
    issuer: memberDid,
  };
  const values: PublishedValue[] = [];
  for (const { field, value } of publicValues(card, fields)) {
    const [member, mapped] = mapField(entryId, field, value);
    out[member] = mapped;
    const ref = field.type === "image" ? blobRef(value) : null;
    values.push(
      ref
        ? { key: field.key, label: field.label, text: null, picture: ref }
        : { key: field.key, label: field.label, text: asText(value) },
    );
  }
  return { card: out, values, revision: card.revision as number, entryId };
}

/** What publishing a card means, and what it says, in the person's words. */
export interface ExternalCardDescription {
  /** Who can read it, and what the community does with it. */
  meaning: string[];
  /** Every value it carries, one line each. Empty when it shows nothing. */
  values: string[];
  /** What happens afterwards. */
  closing: string;
}

/**
 * What publishing means, and what the card says, in the person's words — shown
 * before anything is signed (VTI-REG-004 item 2).
 */
export function describeExternalCard(communityName: string, draft: ExternalCardDraft): ExternalCardDescription {
  return {
    meaning: [
      `Anyone will be able to find and read this card — people outside ${communityName} too.`,
      `${communityName} will serve it exactly as you sign it, and its trust registry will point to it.`,
    ],
    values: draft.values.map((v) => `${v.label}: ${v.text ?? "your picture"}`),
    closing:
      "If you change what you show to anyone, the card stops being published until you sign it again. You can stop publishing at any time.",
  };
}

/**
 * The card as the agent signed it, if it is exactly the card that was sent
 * with a proof added. An agent that changed anything — or a proof for anyone
 * but the member — is refused, so nothing the person did not see is sent.
 */
export function checkSignedCard(
  unsigned: Record<string, unknown>,
  signed: unknown,
  memberDid: string,
): Record<string, unknown> {
  const s = signed as Record<string, unknown> | null;
  const bad = (why: string) => new OobReplyInvalidError(`signed card: ${why}`);
  if (!s || typeof s !== "object") throw bad("not an object");
  const { proof, ...rest } = s;
  if (JSON.stringify(sortKeys(rest)) !== JSON.stringify(sortKeys(unsigned))) {
    throw bad("the agent changed the card");
  }
  const p = proof as Record<string, unknown> | undefined;
  if (!p || p.type !== "DataIntegrityProof" || p.proofPurpose !== "assertionMethod") {
    throw bad("no assertionMethod Data Integrity proof");
  }
  if (typeof p.verificationMethod !== "string" || !p.verificationMethod.startsWith(`${memberDid}#`)) {
    throw bad("the proof is not the member's");
  }
  return s;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** `vtc/directory/card/publish`, unsigned, as the member. */
export function buildCardPublish(
  memberDid: string,
  vtcDid: string,
  signedCard: Record<string, unknown>,
  expectedRevision: number,
): OobDocument<{ card: Record<string, unknown>; expectedRevision: number }> {
  return envelope(CARD_PUBLISH, memberDid, vtcDid, { card: signedCard, expectedRevision });
}

/** Where the card stands, from `card/publish`'s answer. */
export function publishedStateOf(res: unknown): ExternalCard {
  const r = res as { externalCard?: ExternalCard } | undefined;
  const e = r?.externalCard;
  if (!e || (e.state !== "published" && e.state !== "awaitingSignature")) {
    throw new OobReplyInvalidError("card/publish: no externalCard state");
  }
  return e;
}

// ── the member's agent ───────────────────────────────────────────────────────
//
// Two agent calls, kept here rather than borrowed from the admin key helpers so
// a wallet surface never imports the administration surface.

/** Who asks the agent, and which agent: the envelope's `issuer` and `recipient`. */
export interface AgentParties {
  holder: { did: string };
  service: { did: string };
}

/** The 32 key bytes a multibase public key carries, with or without its
 *  Ed25519 multicodec prefix. */
function keyBytes(multibase: string): string | null {
  try {
    const raw = decodeMultibase(multibase);
    const key = raw.length === 34 && raw[0] === 0xed && raw[1] === 0x01 ? raw.slice(2) : raw;
    return key.length === 32 ? Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("") : null;
  } catch {
    return null;
  }
}

/** The Ed25519 keys `memberDoc` lists under `assertionMethod`, as hex. A
 *  `did:key` lists its one key under every relationship. */
export function assertionKeys(memberDid: string, memberDoc: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>();
  if (memberDid.startsWith("did:key:")) {
    const k = keyBytes(memberDid.slice("did:key:".length));
    if (k) out.add(k);
    return out;
  }
  if (!memberDoc) return out;
  const absolute = (id: string) => (id.startsWith("#") ? `${memberDid}${id}` : id);
  const methods = new Map<string, string>();
  const add = (vm: unknown) => {
    const m = vm as { id?: unknown; publicKeyMultibase?: unknown };
    if (typeof m?.id === "string" && typeof m.publicKeyMultibase === "string") {
      const k = keyBytes(m.publicKeyMultibase);
      if (k) methods.set(absolute(m.id), k);
    }
  };
  const vms = memberDoc.verificationMethod;
  if (Array.isArray(vms)) vms.forEach(add);
  const assertion = memberDoc.assertionMethod;
  if (Array.isArray(assertion)) {
    for (const entry of assertion) {
      if (typeof entry === "string") {
        const k = methods.get(absolute(entry));
        if (k) out.add(k);
      } else {
        add(entry);
        const id = (entry as { id?: unknown })?.id;
        const k = typeof id === "string" ? methods.get(absolute(id)) : undefined;
        if (k) out.add(k);
      }
    }
  }
  return out;
}

/**
 * The agent's key record the member signs as: an active Ed25519 key whose
 * public key `memberDoc` lists under `assertionMethod`. `null` when the agent
 * holds none — then the card cannot be signed here.
 */
export async function memberSigningKey(
  sender: TrustTaskSender,
  parties: AgentParties,
  memberDid: string,
  memberDoc: Record<string, unknown> | null,
): Promise<string | null> {
  const wanted = assertionKeys(memberDid, memberDoc);
  if (wanted.size === 0) return null;
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await sender.send<{ keys: KeyRecord[]; total: number }>(
      buildTrustTask(
        KEYS_LIST,
        { status: "active", offset, limit },
        { issuer: parties.holder.did, recipient: parties.service.did },
      ),
      { expectedResponseType: KEYS_LIST_RESPONSE, operationLabel: "keys/list/0.1" },
    );
    for (const k of page.keys ?? []) {
      const bytes = k.keyType === "ed25519" ? keyBytes(k.publicKey) : null;
      if (bytes && wanted.has(bytes)) return k.keyId;
    }
    if (!page.keys?.length || offset + page.keys.length >= (page.total ?? 0)) return null;
  }
}

/**
 * Have the agent sign `card` as the DID it names (`keys/sign-document`), for
 * `assertionMethod`. The answer is checked against what was sent before it is
 * returned, so nothing the person did not see leaves the wallet.
 */
export async function agentSignCard(
  sender: TrustTaskSender,
  parties: AgentParties,
  keyId: string,
  card: Record<string, unknown>,
  memberDid: string,
): Promise<Record<string, unknown>> {
  const res = await sender.send<{ document?: unknown; signerDid?: unknown }>(
    buildTrustTask(
      KEYS_SIGN_DOCUMENT,
      { keyId, document: card, proofPurpose: "assertionMethod" },
      { issuer: parties.holder.did, recipient: parties.service.did },
    ),
    { expectedResponseType: KEYS_SIGN_DOCUMENT_RESPONSE, operationLabel: "keys/sign-document/0.1" },
  );
  if (res.signerDid !== memberDid) {
    throw new OobReplyInvalidError("keys/sign-document: signed as someone else");
  }
  return checkSignedCard(card, res.document, memberDid);
}
