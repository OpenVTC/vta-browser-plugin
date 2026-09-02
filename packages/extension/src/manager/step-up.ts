// Proof of presence, for the console's two irreversible controls.
//
// ## What this proves, and what it does not
//
// `requirePresence` runs a WebAuthn assertion and throws if it does not
// complete. That establishes exactly one thing: **a human with the enrolled
// authenticator is at this machine right now.** It is a gate on the console's
// own UI.
//
// It is *not* an authorization of the operation, and the distinction is worth
// stating plainly because the ceremony looks like one. Nothing verifies this
// assertion against the Trust Task that follows — the agent never sees it, the
// document carries no trace of it, and the audit trail at the other end records
// an ordinary request. A caller who reached the extension's own code could send
// the task without ever calling this.
//
// So the honest claim is: this stops an unattended console from being used by
// whoever walks past, and it makes an irreversible action deliberate rather
// than one click deep. That is worth having. It is not a second factor on the
// agent, and anyone reasoning about the agent's security should not count it as
// one.
//
// ## Why it does not reuse the PRF ceremony
//
// `runPrfUnlockCeremony` returns PRF output — the AES key root, as sensitive as
// the holder seed. A presence check needs none of that, and a primitive that
// hands back key material to answer "is someone there?" is one that will
// eventually have its output stored by a caller who only wanted the boolean.
// This runs the same assertion with **no `prf` extension** and returns
// `void`. There is nothing to leak because there is nothing to return.
//
// ## Why it never consults unlock state
//
// A step-up that a prior unlock satisfies is not a step-up. The wallet may well
// be unlocked — that is a fact about this session, established possibly hours
// ago, and re-using it would mean the gate is open for as long as the console
// is. Every call runs a fresh assertion with a fresh challenge. That is the
// whole point, and it is the first thing to break if someone later adds a
// cache "because the prompt is annoying".
//
// ## Where it must run
//
// The manager page, in a click handler. `navigator.credentials.get` needs a
// visible, focused context — the same constraint documented in
// `webauthn-prf-unlock.ts`, for the same reason: a hidden page hangs forever
// rather than failing. The console is a normal extension page, so this holds,
// but it is why the call belongs in the pane and not in the offscreen document
// that ends up sending the task.

import { base64url } from "@openvtc/vti-didcomm-js";
import { IndexedDBKVStore } from "@openvtc/pnm-core";

// The credential the wallet enrolled. Same slot `webauthn-prf-unlock.ts` reads;
// the salt beside it is deliberately not read here, because that is the PRF
// input and this ceremony evaluates no PRF.
const CREDENTIAL_KEY = "pnm/holder-prf/credentialId";

/** Why a step-up could not be completed, in terms the operator can act on. */
export class StepUpError extends Error {
  readonly reason: "cancelled" | "no-authenticator" | "unexpected";
  constructor(reason: StepUpError["reason"], message: string) {
    super(message);
    this.name = "StepUpError";
    this.reason = reason;
  }
}

/**
 * Require a fresh proof of presence before an irreversible action.
 *
 * Resolves only if the assertion completed. Throws `StepUpError` otherwise —
 * `cancelled` when the human dismissed the prompt, which is a decision and not
 * a fault, so callers should abandon the action silently rather than surfacing
 * it as an error.
 *
 * `purpose` is shown to the operator by the caller, not passed to the
 * authenticator: WebAuthn has no field that renders caller-supplied text, and
 * pretending otherwise would let a pane imply the prompt says something it does
 * not. It is taken here so the reason is recorded next to the call site.
 */
export async function requirePresence(rpId: string, purpose: string): Promise<void> {
  void purpose;

  const store = new IndexedDBKVStore();
  const credentialIdB64u = await store.get<string>(CREDENTIAL_KEY);

  // A fresh random challenge, every time.
  //
  // Not bound to the action, and that is not an oversight: binding buys
  // something only where a verifier checks the challenge against the request,
  // and there is no verifier here. Claiming the assertion is "for this bundle"
  // when nothing enforces it would be the kind of overstatement the module
  // header exists to avoid.
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  // An enrolled credential is used when there is one, so the prompt names the
  // authenticator the operator already knows. With none, fall back to whatever
  // discoverable credential exists for this rpId rather than refusing outright:
  // enrolment is about encrypting the holder, and an operator who declined that
  // has not thereby declined to prove they are present.
  const allowCredentials = credentialIdB64u
    ? [
        {
          type: "public-key" as const,
          id: base64url.decode(credentialIdB64u).buffer as ArrayBuffer,
        },
      ]
    : [];

  let assertion: Credential | null;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: challenge as BufferSource,
        allowCredentials,
        // Presence alone is not the bar. `required` asks the authenticator for
        // the biometric or PIN, which is what makes this a step-up rather than
        // a touch anyone standing at the machine can supply.
        userVerification: "required",
      },
    });
  } catch (e) {
    // `NotAllowedError` is what both a dismissal and a timeout raise, and the
    // API gives no way to tell them apart — deliberately, so a site cannot
    // learn whether a user refused. Reported as cancelled because that is the
    // reading a caller should act on: do nothing, say nothing.
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError") {
      throw new StepUpError("cancelled", "Approval was dismissed. Nothing was sent.");
    }
    throw new StepUpError(
      "unexpected",
      e instanceof Error ? e.message : "The authenticator could not be reached.",
    );
  }

  if (!assertion) {
    throw new StepUpError(
      "no-authenticator",
      "No authenticator answered. Enrol one in Settings, then try again.",
    );
  }
}
