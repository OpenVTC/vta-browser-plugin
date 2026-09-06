// `persona/disclosure/{preview,present}/1.0` — the two calls that hand a
// verifier the holder's identity, and the one place a human gets to say no.
//
// **These are two calls on purpose and this module offers no wrapper that
// collapses them.** `preview` signs nothing and sends nothing; it returns a
// `previewId` that `present` consumes. That token is the only way to reach
// `present`, which is what makes "there is no disclosure that skipped the
// summary" a property of the system rather than a convention. A convenience
// function here that called both would put the decision back in the caller's
// hands and quietly undo it, so there isn't one.
//
// The preview is single-use and short-lived. A preview a holder approved an
// hour ago is not evidence that they approve it now, and one that could be
// replayed would let a second disclosure ride the first decision.
//
// ## Why this module ranks
//
// A preview listing fourteen fields with fourteen equal weights is a
// notice-and-consent dialog, and that is the pattern that teaches people to
// click through. The agent already supplies the two signals that make a
// preview rankable — `anomalous` (unusual for the verifier's stated purpose)
// and `newToThisVerifier` — and [`rankPreview`] turns them into an order plus
// a reason per claim, so a consent screen can lead with the line worth reading
// instead of rendering the array as it arrived.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as DISCLOSURE_PREVIEW,
  RESPONSE_TYPE_URI as DISCLOSURE_PREVIEW_RESPONSE,
  type PersonaDisclosurePreviewPayload,
  type PersonaDisclosurePreviewResponsePayload,
} from "@openvtc/trust-tasks/persona/disclosure/preview/1.0/payload";
import {
  TYPE_URI as DISCLOSURE_PRESENT,
  RESPONSE_TYPE_URI as DISCLOSURE_PRESENT_RESPONSE,
  type PersonaDisclosurePresentPayload,
  type PersonaDisclosurePresentResponsePayload,
} from "@openvtc/trust-tasks/persona/disclosure/present/1.0/payload";

import { call, type PersonaCallerParams } from "./call.js";

export type DisclosurePreview = PersonaDisclosurePreviewResponsePayload;
export type PreviewClaim = DisclosurePreview["claims"][number];
export type Disclosure = PersonaDisclosurePresentResponsePayload;

export interface PreviewDisclosureParams extends PersonaCallerParams {
  /** The persona that would present. Its binding supplies the profile. */
  personaDid: string;
  /** Who would receive it. */
  verifierDid: string;
  /**
   * Claim types the verifier asked for. Omit to preview everything the bound
   * profile would present; when given, the agent returns nothing outside it.
   */
  requestedClaims?: PersonaDisclosurePreviewPayload["requestedClaims"];
  /**
   * The verifier's stated reason. Carried into the preview and the disclosure
   * record, so a holder deciding later has the context a holder deciding now
   * had — and so the agent can say which of the requested claims are unusual
   * *for that reason*.
   */
  purpose?: string;
  /**
   * Which output format to prepare for. Omit for the agent's canonical one.
   * It matters to the preview and not only to the output: renderers differ in
   * what they can carry, and the holder is owed that before deciding.
   */
  renderer?: string;
}

/**
 * Ask what a disclosure would reveal. Signs nothing, sends nothing.
 *
 * The response is the material for a consent screen, and every part of it is
 * there to be shown: what would go, what the renderer would drop, how much the
 * disclosure would link the holder, and which claims are out of place. A
 * caller that renders only `claims` has thrown away the parts that make it a
 * decision rather than a list.
 */
export async function previewDisclosure(
  sender: TrustTaskSender,
  params: PreviewDisclosureParams,
): Promise<DisclosurePreview> {
  const payload: PersonaDisclosurePreviewPayload = {
    contextId: params.contextId,
    personaDid: params.personaDid,
    verifierDid: params.verifierDid,
    ...(params.requestedClaims !== undefined
      ? { requestedClaims: params.requestedClaims }
      : {}),
    ...(params.purpose !== undefined ? { purpose: params.purpose } : {}),
    ...(params.renderer !== undefined ? { renderer: params.renderer } : {}),
  };
  return call<PersonaDisclosurePreviewPayload, DisclosurePreview>(
    sender,
    params,
    DISCLOSURE_PREVIEW,
    DISCLOSURE_PREVIEW_RESPONSE,
    "persona/disclosure/preview",
    payload,
  );
}

export interface PresentDisclosureParams extends PersonaCallerParams {
  /**
   * The preview the holder approved. Consumed by this call — a replay is
   * refused rather than riding the earlier decision.
   */
  previewId: string;
  /** Verifier-supplied nonce binding the disclosure to this exchange. */
  challenge?: string;
  /**
   * Ask for the disclosure as a self-issued credential rather than a bare
   * document.
   */
  mint?: PersonaDisclosurePresentPayload["mint"];
}

/**
 * Hand over what the preview showed.
 *
 * Call this only after a human has seen the preview. Nothing in this library
 * can check that they did — the gate is the `previewId`, and the reason it is
 * a gate at all is that the only way to obtain one is to have produced the
 * summary.
 */
export async function presentDisclosure(
  sender: TrustTaskSender,
  params: PresentDisclosureParams,
): Promise<Disclosure> {
  const payload: PersonaDisclosurePresentPayload = {
    contextId: params.contextId,
    previewId: params.previewId,
    ...(params.challenge !== undefined ? { challenge: params.challenge } : {}),
    ...(params.mint !== undefined ? { mint: params.mint } : {}),
  };
  return call<PersonaDisclosurePresentPayload, Disclosure>(
    sender,
    params,
    DISCLOSURE_PRESENT,
    DISCLOSURE_PRESENT_RESPONSE,
    "persona/disclosure/present",
    payload,
  );
}

// ── Making a preview readable ──────────────────────────────────────────────

/** Why a claim was surfaced, most attention-worthy first. */
export type ClaimNotice =
  /** Cannot be sent: a credential-backed claim the agent could not re-derive.
   *  The disclosure will be shorter than the profile suggests, and the holder
   *  is told rather than left to notice. */
  | "stale"
  /** Unusual for the verifier's stated purpose. */
  | "anomalous"
  /** This verifier has not had this claim type from this persona before. */
  | "new"
  /** Proven rather than shown — no value crosses at all. */
  | "predicate";

export interface RankedClaim {
  claim: PreviewClaim;
  /** Every notice that applies, in the order above. Empty for a routine claim. */
  notices: readonly ClaimNotice[];
}

/** Rank order. Lower sorts first. */
const NOTICE_WEIGHT: Record<ClaimNotice, number> = {
  stale: 0,
  anomalous: 1,
  new: 2,
  predicate: 3,
};

/**
 * Order a preview's claims so the ones worth reading come first, and say why
 * each was surfaced.
 *
 * Stable within a rank: claims that carry the same notices keep the order the
 * agent sent them in, which is profile entry order. A consent screen that
 * reshuffled equal claims between two renders of the same preview would make
 * the list feel arbitrary, and a holder who cannot trust the order stops
 * reading it.
 *
 * `predicate` ranks last among notices deliberately. It is the one that is
 * *good* news — a claim proven rather than shown discloses no value at all —
 * so it is worth labelling and not worth leading with. A stale claim leads,
 * because it is the only notice that changes what the verifier actually gets.
 */
export function rankPreview(preview: DisclosurePreview): RankedClaim[] {
  const anomalous = new Set(preview.anomalous ?? []);
  const ranked = preview.claims.map((claim, index) => {
    const notices: ClaimNotice[] = [];
    if (claim.stale === true) notices.push("stale");
    if (anomalous.has(claim.type)) notices.push("anomalous");
    if (claim.newToThisVerifier === true) notices.push("new");
    if (claim.predicate !== undefined) notices.push("predicate");
    return { claim, notices, index };
  });

  const weight = (n: readonly ClaimNotice[]) =>
    n.length === 0 ? Number.MAX_SAFE_INTEGER : NOTICE_WEIGHT[n[0]!];

  return ranked
    .sort((a, b) => weight(a.notices) - weight(b.notices) || a.index - b.index)
    .map(({ claim, notices }) => ({ claim, notices }));
}

/**
 * The claims that would NOT be sent, though the profile lists them.
 *
 * Split out because it is the one thing a consent screen must not present as
 * ordinary: a holder approving a disclosure needs to know it will be shorter
 * than it looks, and needs it before approving rather than as a surprise
 * afterwards.
 */
export function staleClaims(preview: DisclosurePreview): PreviewClaim[] {
  return preview.claims.filter((c) => c.stale === true);
}

/**
 * True when this preview would hand the verifier a value it can use to
 * recognise the holder elsewhere.
 *
 * Reads the agent's `correlation.severity` rather than deriving anything,
 * because the derivation inverts in a way that is easy to get backwards: a
 * credential presented WHOLE correlates *more* than a self-asserted value —
 * the issuer's signature is byte-identical at every verifier — while a derived
 * proof correlates *less*, because it differs on every presentation. Severity
 * is a function of value and rung together, never of provenance alone. Any
 * re-derivation here would be a second opinion with less to go on.
 */
export function correlationSeverity(
  preview: DisclosurePreview,
): "none" | "low" | "high" {
  return preview.correlation?.severity ?? "none";
}
