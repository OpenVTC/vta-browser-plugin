// Joining a Verifiable Trust Community from a wallet, as the community serves
// it today: `vtc/join-requests/manifest/0.4` (0.3 from a community that has
// not moved) and `submit/0.3`, posted as signed Trust-Task documents to
// `<TrustTaskHTTPS base>/trust-tasks`.
//
// From 0.4 the manifest carries the community's directory disclosure
// statement: what its member directory would show about the person, and to
// whom. The plan carries it, in words, so it is shown before the person
// applies (VTI-DIR-130).
//
// The applicant is whoever signs the submission: the community reads the
// applicant DID from the document's proof, never from the payload, and that
// DID becomes the member DID. So a submission is built here *unsigned*, with
// the applicant as `issuer`, and the applicant's own agent signs it (a
// persona's key never leaves it).
//
// The manifest needs no identity at all (its proof is optional), so a reader
// asks for it as a throwaway `did:key` and the community learns nothing about
// who is looking until the person sends a request.
//
// What a wallet can apply under without help is narrow, and that is on
// purpose: a criterion that asks for a credential (`presentationDefinition`),
// an invitation, or identity vetting needs evidence this module does not
// assemble. `planJoin` picks a criterion that asks for none of those, or says
// what the others ask for so the person can be told plainly.

import { TYPE_URI as JR_MANIFEST_0_3 } from "@openvtc/trust-tasks/vtc/join-requests/manifest/0.3/payload";
import {
  TYPE_URI as JR_MANIFEST,
  type VTCJoinRequestsManifestResponsePayload,
  type Criterion,
} from "@openvtc/trust-tasks/vtc/join-requests/manifest/0.4/payload";
import {
  TYPE_URI as JR_SUBMIT,
  type VTCJoinRequestsSubmitPayload,
  type VTCJoinRequestsSubmitResponsePayload,
} from "@openvtc/trust-tasks/vtc/join-requests/submit/0.3/payload";
import { OobReplyInvalidError, type OobDocument } from "./oob-sign-in.js";
import { checkDirectoryDisclosure, describeDirectoryDisclosure } from "./directory-disclosure.js";

/** The service type a VTC publishes for its REST API (`vtc-host` template). */
export const VTC_REST_SERVICE_TYPE = "VTCRest";

export const JOIN_MANIFEST_TYPE = JR_MANIFEST;
export const JOIN_MANIFEST_0_3_TYPE = JR_MANIFEST_0_3;

/** The manifest versions a wallet asks for: 0.4 first, 0.3 from a community
 *  that refuses it. */
export type JoinManifestVersion = "0.4" | "0.3";
export const JOIN_SUBMIT_TYPE = JR_SUBMIT;

export type JoinManifest = VTCJoinRequestsManifestResponsePayload;
export type JoinCriterion = Criterion;
export type JoinSubmitPayload = VTCJoinRequestsSubmitPayload;
export type JoinSubmitResponse = VTCJoinRequestsSubmitResponsePayload;

/** One attribute the community asks an applicant for (self-asserted). */
export interface JoinRequestedAttribute {
  type: string;
  required: boolean;
  purpose?: string;
}

/** The claim-type grammar `submit/0.3` accepts for an attribute's `type`. */
const CLAIM_TYPE = /^(x:)?[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

/** What the community's member directory would disclose about the person,
 *  as the manifest stated it. */
export interface JoinDirectoryDisclosure {
  /** The statement in plain sentences, addressed to the person joining. */
  lines: string[];
  /** Names the exact statement shown, so it can be recorded. */
  statementDigest: string;
}

/** What the wallet can do with a manifest. */
export type JoinPlan =
  | {
      ok: true;
      /** The criterion to cite, by its `requirementsDigest`. */
      criterion: string;
      admission: "automatic" | "review";
      requestedAttributes: JoinRequestedAttribute[];
      /** The community's name for itself: self-asserted, unverified. */
      displayName?: string;
      /** Absent when the community has no directory, or answered 0.3. */
      directory?: JoinDirectoryDisclosure;
    }
  | {
      ok: false;
      /** `not-accepting`: the community publishes no criteria at all.
       *  `needs-more`: every criterion asks for evidence a wallet cannot
       *  assemble here; `needs` says what, in the community's words where it
       *  gave any. */
      reason: "not-accepting" | "needs-more";
      needs: string[];
      displayName?: string;
    };

/** What a criterion asks for that this wallet cannot provide, as short
 *  phrases; empty when it asks for nothing a wallet must assemble. */
export function unmetRequirements(c: JoinCriterion): string[] {
  const needs: string[] = [];
  if (c.invitationRequired === true) needs.push("an invitation from the community");
  if (c.presentationDefinition !== undefined) needs.push("a credential");
  if (c.vetting !== undefined) needs.push("identity vetting by its vetters");
  return needs;
}

/**
 * Choose what to apply under. Among the criteria that ask for nothing a wallet
 * must assemble, an `automatic` one is preferred (the person is admitted on
 * the spot), else the first `review` one, in the community's order.
 */
export function planJoin(manifest: JoinManifest): JoinPlan {
  const displayName =
    typeof manifest.branding?.displayName === "string" && manifest.branding.displayName.trim() !== ""
      ? manifest.branding.displayName.trim()
      : undefined;
  const named = displayName !== undefined ? { displayName } : {};
  const criteria = Array.isArray(manifest.criteria) ? manifest.criteria : [];
  if (criteria.length === 0) return { ok: false, reason: "not-accepting", needs: [], ...named };
  const open = criteria.filter(
    (c) => unmetRequirements(c).length === 0 && typeof c.requirementsDigest === "string" && (c.admission === "automatic" || c.admission === "review"),
  );
  const chosen = open.find((c) => c.admission === "automatic") ?? open[0];
  if (!chosen) {
    const needs: string[] = [];
    for (const c of criteria) {
      const text = typeof c.description === "string" && c.description.trim() !== "" ? c.description.trim() : unmetRequirements(c).join(" and ");
      if (text && !needs.includes(text)) needs.push(text);
    }
    return { ok: false, reason: "needs-more", needs, ...named };
  }
  const requestedAttributes: JoinRequestedAttribute[] = (manifest.requestedAttributes ?? [])
    .filter((a) => typeof a?.type === "string" && CLAIM_TYPE.test(a.type))
    .map((a) => ({
      type: a.type,
      required: a.required === true,
      ...(typeof a.purpose === "string" && a.purpose.trim() !== "" ? { purpose: a.purpose.trim() } : {}),
    }));
  const directory = manifest.directoryDisclosure
    ? {
        directory: {
          lines: describeDirectoryDisclosure(manifest.directoryDisclosure),
          statementDigest: manifest.directoryDisclosure.statementDigest,
        },
      }
    : {};
  return { ok: true, criterion: chosen.requirementsDigest, admission: chosen.admission, requestedAttributes, ...named, ...directory };
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

/** `vtc/join-requests/manifest` at `version`: the request carries nothing. */
export function buildJoinManifestRequest(
  issuer: string,
  vtcDid: string,
  version: JoinManifestVersion = "0.4",
): OobDocument<Record<string, never>> {
  return envelope(version === "0.4" ? JR_MANIFEST : JR_MANIFEST_0_3, issuer, vtcDid, {});
}

/** A manifest reply must be this community's. */
export function checkJoinManifest(manifest: unknown, vtcDid: string): JoinManifest {
  const m = manifest as JoinManifest | undefined;
  if (!m || typeof m !== "object") throw new OobReplyInvalidError("join manifest: no payload");
  if (m.communityDid !== vtcDid) throw new OobReplyInvalidError("join manifest: a different community");
  if (!Array.isArray(m.criteria)) throw new OobReplyInvalidError("join manifest: no criteria");
  // A statement the wallet cannot show faithfully stops the join here: the
  // person must not apply without being told what the directory discloses.
  if (m.directoryDisclosure !== undefined) checkDirectoryDisclosure(m.directoryDisclosure);
  return m;
}

export interface JoinSubmitInput {
  /** The `requirementsDigest` of the criterion applied under. */
  criterion: string;
  /** The person's answers, one per attribute given. */
  attributes: ReadonlyArray<{ type: string; value: string }>;
  /** Explicit: absence is not consent to be published. */
  registryConsent: boolean;
}

/**
 * `vtc/join-requests/submit/0.3`, unsigned, with the applicant as `issuer`.
 * The presentation carries no credential (the criterion asks for none) and
 * names the applicant as its holder, which the community requires to match
 * the document's signer.
 */
export function buildJoinSubmit(applicantDid: string, vtcDid: string, input: JoinSubmitInput): OobDocument<JoinSubmitPayload> {
  const payload: JoinSubmitPayload = {
    vp: {
      "@context": ["https://www.w3.org/ns/credentials/v2"],
      type: ["VerifiablePresentation"],
      holder: applicantDid,
    },
    criterion: input.criterion,
    registryConsent: input.registryConsent,
    // The binding types `value` as an object; the community takes the JSON
    // value as given, and a person's answer here is a string.
    ...(input.attributes.length > 0
      ? { attributes: input.attributes.map((a) => ({ type: a.type, value: a.value as unknown as Record<string, unknown> })) }
      : {}),
  };
  return envelope(JR_SUBMIT, applicantDid, vtcDid, payload);
}

/** What a submission came to, by the community's `verdict.effect`. */
export type JoinOutcome =
  | { kind: "admitted"; requestId: string; role?: string }
  /** `refer` (an administrator decides) or `requestMore` (the community wants
   *  evidence; `needs` says what). The request stays open either way. */
  | { kind: "pending"; requestId: string; needs?: string[] }
  | { kind: "declined"; requestId: string; code?: string; reason?: string };

/** Read a submission's verdict. Branches on `effect`, never on which members
 *  of `with` happen to be present. */
export function joinOutcomeOf(res: unknown): JoinOutcome {
  const r = res as JoinSubmitResponse | undefined;
  if (!r || typeof r.requestId !== "string" || !r.verdict || typeof r.verdict !== "object") {
    throw new OobReplyInvalidError("join submit: no verdict");
  }
  const w = (r.verdict.with ?? {}) as JoinSubmitResponse["verdict"]["with"];
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  switch (r.verdict.effect) {
    case "allow": {
      const role = str(w.role);
      return { kind: "admitted", requestId: r.requestId, ...(role ? { role } : {}) };
    }
    case "refer":
      return { kind: "pending", requestId: r.requestId };
    case "requestMore": {
      const needs = Array.isArray(w.needs) ? w.needs.filter((n): n is string => typeof n === "string") : [];
      return { kind: "pending", requestId: r.requestId, ...(needs.length ? { needs } : {}) };
    }
    case "deny": {
      const code = str(w.code);
      const reason = str(w.reason);
      return { kind: "declined", requestId: r.requestId, ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
    }
    default:
      throw new OobReplyInvalidError(`join submit: an effect this wallet does not know (${String(r.verdict.effect)})`);
  }
}
