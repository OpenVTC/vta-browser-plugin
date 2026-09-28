// When a remembered site may skip the consent prompt.
//
// "Remember this site" lets a site sign the user in without asking. It does
// not cover anything the tick was never shown for:
//
// - **A changed relying party or base URL.** That is the redirect-to-attacker
//   case the loud warning exists for, so trust must not silence it.
// - **A session key.** With one bound (`auth/authenticate/0.2`), the page can
//   sign the session's requests as the user with no further prompt. That is
//   more than a sign-in, so it is always asked, and there is nothing to
//   remember.

export interface LoginConsentFacts {
  changedFromRpDid?: string;
  changedFromBaseUrl?: string;
  sessionKey?: string;
}

/** Whether a remembered site may skip the prompt for this sign-in. */
export function trustMaySkipPrompt(facts: LoginConsentFacts): boolean {
  return !facts.changedFromRpDid && !facts.changedFromBaseUrl && !facts.sessionKey;
}

/** Whether the prompt may offer "remember this site". A session-key sign-in
 *  is asked every time, so a tick there would be a checkbox that lies. */
export function promptMayRemember(facts: LoginConsentFacts): boolean {
  return !facts.sessionKey;
}
