// What a disclosure consent screen shows, decided here rather than in a
// component.
//
// This is the last screen before a person's identity leaves their machine, and
// what it says is a security property rather than a presentation choice. Three
// specific ways a consent screen fails, all of them by rendering something
// *reasonable*:
//
//   - **It lists.** Fourteen fields at fourteen equal weights is a
//     notice-and-consent dialog, and that is the pattern that teaches people to
//     click through. The agent already says which claims are unusual for the
//     stated purpose and which are new to this verifier; a screen that ignores
//     both has thrown away the only thing that makes the list rankable.
//   - **It renders an absence as data.** A predicate claim discloses no value
//     at all — that is the whole point of the rung — and drawing it as an empty
//     value reads as missing data rather than as the strongest outcome on the
//     screen.
//   - **It omits what will not be sent.** A stale claim cannot be disclosed. A
//     screen that quietly drops it shows a disclosure that looks complete and
//     is not, and the holder learns afterwards, from the verifier.
//
// Keeping the decisions here — as data, in `@openvtc/pnm-core` — means they are
// unit-tested against the shapes the agent actually returns, and that the
// extension popup and the PWA cannot drift into two different answers to
// "what does this disclosure say".

import {
  rankPreview,
  type ClaimNotice,
  type DisclosurePreview,
  type PreviewClaim,
} from "./disclosure.js";

/** One claim, as a row on the screen. */
export interface ConsentRow {
  /** The claim type, e.g. `name.legal`. */
  type: string;
  /**
   * What the verifier would receive, already worded for a person.
   *
   * Never an empty string: a blank cell reads as missing data, and two of the
   * three cases here are not missing anything. See [`kind`](Self.kind).
   */
  shown: string;
  /**
   * Which of the three readings this row is, so a screen can style them
   * differently without re-deriving the distinction from the claim.
   *
   * `withheld` is the one that must not be styled like the others: it is the
   * only row whose presence makes the disclosure *smaller* than it looks.
   */
  kind: "value" | "predicate" | "withheld";
  /** Why this row was surfaced, most attention-worthy first. Empty is routine. */
  notices: readonly ClaimNotice[];
  /** The underlying claim, for a screen that wants more than this row carries. */
  claim: PreviewClaim;
}

/** Everything a disclosure consent screen needs, in the order it should appear. */
export interface DisclosureConsentView {
  /** Who is asking. */
  verifierDid: string;
  /** Their stated reason, if they gave one. */
  purpose?: string;
  /**
   * The identifier the verifier would see — pairwise by default, so two
   * verifiers cannot recognise the holder as the same party. Worth showing:
   * "the persona DID is the account; this is the face".
   */
  subject: string;
  /** Rows in the order they should be read. */
  rows: readonly ConsentRow[];
  /** How many claims the verifier actually receives. */
  sendingCount: number;
  /** How many are listed but cannot be sent. Zero for a clean disclosure. */
  withheldCount: number;
  /** Output format, and what it discards. `undefined` when the agent named none. */
  renderer?: { id: string; drops: readonly string[] };
  /** How linkable this would make the holder, and the agent's reason. */
  correlation: { severity: "none" | "low" | "high"; reason?: string };
  /** When the preview stops being usable. */
  expiresAt: string;
  /** Consumed by `present`. */
  previewId: string;
}

/**
 * A one-line, honest summary of the size of the disclosure.
 *
 * Deliberately says the withheld part out loud rather than only counting what
 * goes: "3 claims" beside a list of five rows invites the reader to assume they
 * miscounted, where "3 claims — 2 cannot be sent" tells them what happened.
 */
export function summarise(view: DisclosureConsentView): string {
  const claims = view.sendingCount === 1 ? "1 claim" : `${view.sendingCount} claims`;
  if (view.withheldCount === 0) return claims;
  return `${claims} — ${view.withheldCount} cannot be sent`;
}

/** Word a predicate the way a person reads it. */
function describePredicate(p: NonNullable<PreviewClaim["predicate"]>): string {
  const op =
    {
      gte: "is at least",
      gt: "is more than",
      lte: "is at most",
      lt: "is less than",
      eq: "is",
      ne: "is not",
      memberOf: "is one of",
    }[p.op] ?? p.op;
  const arg = typeof p.arg === "string" ? p.arg : JSON.stringify(p.arg);
  // The trailing clause is the point of the row, not a footnote: this rung is
  // the only one where the verifier learns something without receiving a value.
  return `proves ${op} ${arg} — the value itself is not sent`;
}

/** Word a value the way a person reads it: a string as itself, else JSON. */
function describeValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "(no value)";
  return JSON.stringify(v);
}

/**
 * Build the view a consent screen renders.
 *
 * `verifierDid` is a parameter rather than read from the preview because the
 * preview does not echo it: the agent knows who asked, and the screen has to be
 * told. Passing it explicitly is what keeps a screen from rendering a
 * disclosure without naming the recipient — which would be a list of fields
 * rather than a decision.
 */
export function buildConsentView(
  preview: DisclosurePreview,
  asked: { verifierDid: string; purpose?: string },
): DisclosureConsentView {
  const rows: ConsentRow[] = rankPreview(preview).map(({ claim, notices }) => {
    if (claim.stale === true) {
      return {
        type: claim.type,
        shown: "will NOT be sent — the credential behind it could not be checked",
        kind: "withheld" as const,
        notices,
        claim,
      };
    }
    if (claim.predicate !== undefined) {
      return {
        type: claim.type,
        shown: describePredicate(claim.predicate),
        kind: "predicate" as const,
        notices,
        claim,
      };
    }
    return {
      type: claim.type,
      shown: describeValue(claim.value),
      kind: "value" as const,
      notices,
      claim,
    };
  });

  const withheldCount = rows.filter((r) => r.kind === "withheld").length;

  return {
    verifierDid: asked.verifierDid,
    ...(asked.purpose !== undefined ? { purpose: asked.purpose } : {}),
    subject: preview.subject,
    rows,
    sendingCount: rows.length - withheldCount,
    withheldCount,
    ...(preview.renderer !== undefined ? { renderer: preview.renderer } : {}),
    correlation: {
      severity: preview.correlation?.severity ?? "none",
      ...(preview.correlation?.reason !== undefined
        ? { reason: preview.correlation.reason }
        : {}),
    },
    expiresAt: preview.expiresAt,
    previewId: preview.previewId,
  };
}

/**
 * Whether this disclosure hands the verifier something that can be joined
 * against another verifier's copy.
 *
 * A screen should lead with this when true. Note the inversion the agent's
 * severity already accounts for and a screen must not try to re-derive: a
 * credential presented WHOLE correlates *more* than a self-asserted value,
 * because the issuer's signature is byte-identical everywhere it is shown.
 */
export function isLinkable(view: DisclosureConsentView): boolean {
  return view.correlation.severity !== "none";
}
