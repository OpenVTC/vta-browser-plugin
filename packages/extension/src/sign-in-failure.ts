// What a failed sign-in says about itself beyond its plain-language message.
//
// Every refusal after the claim reads "This code can't be used. Refresh the
// code on the website and try again." to the member, which is right for them
// and useless for whoever has to find out why. The flow (`sign-in-flows.ts`)
// records which exchange failed, who refused and the stable code; this module
// turns that into the window's "Details" line and the background's console
// line, so both say the same thing.
//
// Nothing here carries the link, a key, a DID or a message body: a stage name,
// a party and a stable code are all it ever prints (VTI-LNK-073).

import type { SignInFailureParty, SignInFailureStage, SignInStepResult } from "./bridge-protocol.js";

type Failed = Extract<SignInStepResult, { kind: "failed" }>;

export const STAGE_LABEL: Readonly<Record<SignInFailureStage, string>> = {
  "domain-linkage": "checking the website belongs to the community",
  join: "join (recording the service in your vault)",
  claim: "claim (sending the code to the community)",
  identify: "identify (your agent signing who you are)",
  prove: "prove (sending the number to the community)",
  "grant-digest": "preparing the approval",
  "enrol-uv": "enrolling this browser's passkey at your agent",
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

/** The rows of the "Details" line, in reading order. */
export function failureDetails(r: Failed): Array<[label: string, value: string]> {
  const rows: Array<[string, string]> = [["Code", r.code]];
  const meaning = CODE_MEANING[r.code];
  if (meaning) rows.push(["Meaning", meaning]);
  if (r.cause && r.cause !== r.code) rows.push(["Cause", r.cause]);
  if (r.stage) rows.push(["Step", STAGE_LABEL[r.stage] ?? r.stage]);
  if (r.party) rows.push(["Refused by", PARTY_LABEL[r.party] ?? r.party]);
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
