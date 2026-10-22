// Verified directory fields (`vtc/directory/card/present/0.1`): a member fills
// `credential`-sourced fields on their own card — a verified employer, a
// professional registration — from a credential their agent holds. The
// community verifies the presentation, keeps only the claims the fields read,
// badged with their issuer, and discards the presentation.
//
// The presentation is the agent's to make (`vault/credentials/present/0.1`):
// it holds the credential and its subject's key. The wallet reads which
// credential the fields accept from the community's schema, asks the agent for
// a presentation bound to this community and to the `card/present` document
// that will carry it, and sends that document as the member. So the document's
// `id` exists before the presentation does — it is the presentation's nonce —
// and {@link buildCardPresent} takes it rather than minting one.

import type { ClaimSelector, FieldDefinition } from "@openvtc/trust-tasks/vtc/directory/fields/list/0.1/payload";
import {
  TYPE_URI as CARD_PRESENT,
  type Payload as CardPresentPayload,
  type VerifiedValue,
} from "@openvtc/trust-tasks/vtc/directory/card/present/0.1/payload";
import { OobReplyInvalidError, type OobDocument } from "./oob-sign-in.js";

export type { ClaimSelector, VerifiedValue };
export { CARD_PRESENT };

/** What the named fields ask of one credential. */
export interface CredentialAsk {
  /** The type every named field's selector names. */
  credentialType: string;
  /** Issuers every named field accepts; absent when none of them lists any.
   *  Where several do, only issuers all of them accept. */
  issuers?: string[];
  /** The subject claims to disclose, by name, in field order. */
  claims: string[];
  /** The named fields, with the community's labels. */
  fields: Array<{ key: string; label: string }>;
}

/**
 * The name of the subject claim a `claimPath` reads: its first segment, as RFC
 * 6901 unescapes it. A presentation discloses whole claims, so a path into a
 * claim (`/address/country`) discloses the claim it starts in.
 */
export function claimNameOf(claimPath: string): string | null {
  if (!claimPath.startsWith("/")) return null;
  const first = claimPath.slice(1).split("/")[0] ?? "";
  const name = first.replace(/~1/g, "/").replace(/~0/g, "~");
  return name.length > 0 ? name : null;
}

/**
 * What a presentation for `named` must carry, from the community's schema —
 * or why there can be none, in the person's words.
 *
 * Every named field must be active, `credential`-sourced and a `claim` field
 * with a selector, and they must all read one credential type: one
 * presentation answers them all.
 */
export function credentialAskFor(
  schema: readonly FieldDefinition[],
  named: readonly string[],
): { ok: true; ask: CredentialAsk } | { ok: false; error: string } {
  const fields: CredentialAsk["fields"] = [];
  const selectors: ClaimSelector[] = [];
  for (const key of named) {
    const f = schema.find((d) => d.key === key && d.state === "active");
    if (!f) return { ok: false, error: `The community's directory has no field \`${key}\`.` };
    const selector = (f.constraints as { claim?: ClaimSelector } | undefined)?.claim;
    if (f.source !== "credential" || f.type !== "claim" || !selector) {
      return { ok: false, error: `${f.label} isn't a field a credential fills.` };
    }
    fields.push({ key: f.key, label: f.label });
    selectors.push(selector);
  }
  const credentialType = selectors[0]!.credentialType;
  if (selectors.some((s) => s.credentialType !== credentialType)) {
    return { ok: false, error: "Those fields are filled from different credentials: verify them one credential at a time." };
  }
  const claims: string[] = [];
  for (const s of selectors) {
    const name = claimNameOf(s.claimPath);
    if (!name) return { ok: false, error: `The community's directory names a claim the wallet can't read (${s.claimPath}).` };
    if (!claims.includes(name)) claims.push(name);
  }
  let issuers: string[] | undefined;
  for (const s of selectors) {
    if (!s.issuers) continue;
    issuers = issuers ? issuers.filter((i) => s.issuers!.includes(i)) : [...s.issuers];
  }
  if (issuers && issuers.length === 0) {
    return { ok: false, error: "No issuer is accepted for all of those fields: verify them one at a time." };
  }
  return { ok: true, ask: { credentialType, ...(issuers ? { issuers } : {}), claims, fields } };
}

/** `vtc/directory/card/present`, unsigned, as the member. `id` is the nonce the
 *  presentation is bound to. */
export function buildCardPresent(
  id: string,
  memberDid: string,
  vtcDid: string,
  fields: readonly string[],
  presentation: Record<string, unknown> | string,
): OobDocument<CardPresentPayload> {
  return {
    id,
    type: CARD_PRESENT,
    issuer: memberDid,
    recipient: vtcDid,
    issuedAt: new Date().toISOString(),
    payload: { fields: [...fields], presentation } as CardPresentPayload,
  };
}

/** The values now on the card, from `card/present`'s answer. */
export function verifiedValuesOf(res: unknown): { verified: Record<string, VerifiedValue>; revision: number } {
  const r = res as { verified?: unknown; revision?: unknown } | undefined;
  if (!r || typeof r.verified !== "object" || r.verified === null || typeof r.revision !== "number") {
    throw new OobReplyInvalidError("card/present: no verified values");
  }
  return { verified: r.verified as Record<string, VerifiedValue>, revision: r.revision };
}
