// What a failed sign-in says about itself beyond its plain-language message.
//
// Every refusal after the claim reads "This code can't be used. Refresh the
// code on the website and try again." to the member, which is right for them
// and useless for whoever has to find out why. The flow (`sign-in-flows.ts`)
// records which exchange failed, who refused and the stable code; this module
// turns that into the window's "Details" line and the background's console
// line, so both say the same thing.
//
// A refusal the person can do nothing about is worse for whoever runs the
// service: "This code can't be used" says nothing about a DID document that
// lists no sign-in portal. When the cause is the contact's DID document or the
// page the code was on — never a link field, which VTI-LNK-021 forbids naming —
// the window's Details add a sentence saying what is wrong and how to fix it,
// with the DID and origins that were checked.
//
// The console line carries none of that: no link, key, DID, origin or message
// body, only a stage name, a party and a stable code (VTI-LNK-073).

import type {
  SignInFailureParty,
  SignInFailureStage,
  SignInRefusalDetail,
  SignInStepResult,
} from "./bridge-protocol.js";

type Failed = Extract<SignInStepResult, { kind: "failed" }>;
type Refused = Extract<SignInStepResult, { kind: "refused" }>;

export const STAGE_LABEL: Readonly<Record<SignInFailureStage, string>> = {
  "domain-linkage": "checking the website belongs to the community",
  join: "join (recording the service in your vault)",
  "join-manifest": "asking the community what it requires to join",
  "join-sign": "your agent signing the join request",
  "join-submit": "sending the join request to the community",
  "join-identity": "setting up an identity for the community at your agent",
  claim: "claim (sending the code to the community)",
  identify: "identify (your agent signing who you are)",
  prove: "prove (sending the number to the community)",
  "grant-digest": "preparing the approval",
  "enrol-uv": "enrolling this browser's sign-in approval key at your agent",
  grant: "grant (your agent signing the decision)",
  respond: "respond (sending the decision to the community)",
};

export const PARTY_LABEL: Readonly<Record<SignInFailureParty, string>> = {
  community: "the community",
  vta: "your agent",
  wallet: "this wallet (a reply did not check out)",
};

/** What a code means, in a line, for codes a person cannot act on from the
 *  code alone. Keyed by the spec's reason where the code is one. */
export const CODE_MEANING: Readonly<Record<string, string>> = {
  "domain-not-linked":
    "The website doesn't publish a DID Configuration that links it to the community's DID, so nothing was sent to it.",
  "unsupported-vid": "The code names a kind of identifier this wallet can't check yet. An update may add it.",
};

/** What a refusal about the contact's DID document or the page means, and
 *  what its operator does about it. */
export function detailMeaning(d: SignInRefusalDetail): string | undefined {
  switch (d.reason) {
    case "no-portal-service":
      return d.unusable
        ? "This service's DID document lists a sign-in portal (a SignInPortal service), but its endpoint isn't usable: " +
            "it must be an https URL on a public host name, with no port or credentials. Ask its operator to fix it."
        : "This service's DID document doesn't list a sign-in portal (a SignInPortal service). Ask its operator to add one.";
    case "no-common-transport":
      return d.unusable
        ? "This service's DID document lists a Trust-Task endpoint (a TrustTaskHTTPS service), but its endpoint isn't usable: " +
            "it must be an https URL on a public host name, with no port or credentials. Ask its operator to fix it."
        : "This service's DID document doesn't list a Trust-Task endpoint (a TrustTaskHTTPS service), so the wallet has nowhere " +
            "to send the sign-in. Ask its operator to add one.";
    case "wrong-origin":
      return d.pageOrigin
        ? `This page (${d.pageOrigin}) isn't the service's sign-in page (${d.portalOrigin}). ` +
            `Start sign-in from ${d.portalOrigin}, or ask the operator to point the SignInPortal service at this page.`
        : `The wallet couldn't tell which page this code came from, so it couldn't confirm it is the service's sign-in page (${d.portalOrigin}).`;
    case "did-document-unverified":
      return (
        "The wallet couldn't fetch or verify this service's DID document. Check that the DID below is published and its log " +
        "verifies, and that its host is a public name on the default https port."
      );
    case "unsupported-vid":
      return d.method
        ? `This wallet can't resolve ${d.method} DIDs yet, so it can't check this service. An update may add it.`
        : CODE_MEANING["unsupported-vid"];
    case "from-not-allowed":
      return (
        `Sign-in doesn't accept ${d.method ? `a ${d.method} DID` : "this kind of DID"} as the service's identifier. ` +
        "The service needs a DID that can list a sign-in portal, such as did:webvh."
      );
    case "domain-not-linked":
      return (
        `The website (${d.portalOrigin}) doesn't publish a DID Configuration that links it to the community's DID, so nothing was sent to it. ` +
        "Its operator needs to serve /.well-known/did-configuration.json with a Domain Linkage credential for the DID below."
      );
  }
}

/** The rows of the "Details" line, in reading order. A refusal has rows only
 *  when it carries a `detail`: a link field's failure stays the outcome's
 *  message and nothing more (VTI-LNK-021). */
export function failureDetails(r: Failed | Refused): Array<[label: string, value: string]> {
  if (r.kind === "refused") {
    if (!r.detail) return [];
    const rows: Array<[string, string]> = [["Code", r.detail.reason]];
    const meaning = detailMeaning(r.detail);
    if (meaning) rows.push(["Meaning", meaning]);
    if (r.detail.did) rows.push(["DID", r.detail.did]);
    return rows;
  }
  const rows: Array<[string, string]> = [["Code", r.code]];
  const meaning = (r.detail && detailMeaning(r.detail)) ?? CODE_MEANING[r.code];
  if (meaning) rows.push(["Meaning", meaning]);
  if (r.cause && r.cause !== r.code) rows.push(["Cause", r.cause]);
  if (r.stage) rows.push(["Step", STAGE_LABEL[r.stage] ?? r.stage]);
  if (r.party) rows.push(["Refused by", PARTY_LABEL[r.party] ?? r.party]);
  if (r.detail?.did) rows.push(["DID", r.detail.did]);
  return rows;
}

/** The background console line for a failed step: what the window was doing,
 *  and the same stage, party and code the window shows. */
export function failureLogFields(step: string, r: Failed): Record<string, string> {
  return {
    step,
    code: r.code,
    ...(r.cause && r.cause !== r.code ? { cause: r.cause } : {}),
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.party ? { party: r.party } : {}),
  };
}

/** A string safe to show and log as a code: short, and nothing but the
 *  characters stable codes and error names are made of. Anything else — a
 *  sentence, a URL with a query, a serialised object — is dropped. */
export function safeCode(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.:/-]{0,79}$/.test(v) ? v : undefined;
}
