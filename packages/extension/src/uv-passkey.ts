/// <reference types="chrome" />

// The browser plugin's user-verification (UV) passkey (sign-in contract C6/C9).
//
// The VTA signs a wallet sign-in grant only on a `task-consent/decision/0.2`
// whose evidence is a WebAuthn assertion, made with user verification, by a
// passkey this device enrolled. That passkey is its own credential, separate
// from the holder's PRF passkey, for one reason: the VTA verifies it with
// `vti-webauthn`, which verifies **ES256 (P-256) only**, while the PRF passkey
// prefers EdDSA (its algorithm never mattered — only its PRF output did). So
// this one is created with `alg: -7` and nothing else.
//
// Runs in an extension page (the sign-in window), where a click is a user
// gesture. The credential id is stored only after the VTA accepted the
// enrolment, so a wallet never believes in a passkey its VTA does not know.

import { base64url } from "@openvtc/vti-didcomm-js";
import { IndexedDBKVStore, p256Multikey, p256PointFromSpki } from "@openvtc/pnm-core";

import type { SignInUvAssertionView, SignInUvEnrolmentView } from "./bridge-protocol.js";
import { PrfUnlockError } from "./webauthn-prf-unlock.js";

const UV_CREDENTIAL_KEY = "pnm/uv-passkey/credentialId";
/** The whole enrolment (all public), so the same passkey can be enrolled at a
 *  second agent, or for a re-onboarded holder, without creating another. */
const UV_ENROLMENT_KEY = "pnm/uv-passkey/enrolment";

/** The credential id of the enrolled UV passkey, if there is one. */
export async function storedUvCredential(): Promise<string | undefined> {
  return (await new IndexedDBKVStore().get<string>(UV_CREDENTIAL_KEY)) ?? undefined;
}

/**
 * This browser's UV passkey, as it was enrolled, if the wallet kept it.
 *
 * A wallet from before this record existed holds only the credential id
 * ({@link storedUvCredential}). That is not enough to enrol the passkey
 * anywhere else — the public key is gone — so it reads as no passkey, and the
 * next approval creates one. Nothing fails; the member sees one more passkey
 * prompt, once.
 */
export async function storedUvEnrolment(): Promise<SignInUvEnrolmentView | undefined> {
  const rec = await new IndexedDBKVStore().get<SignInUvEnrolmentView>(UV_ENROLMENT_KEY);
  return rec && rec.kind === "webauthn" && typeof rec.credentialId === "string" ? rec : undefined;
}

/** Remember the passkey — call only after the VTA accepted its enrolment. */
export async function rememberUvCredential(credentialId: string): Promise<void> {
  await new IndexedDBKVStore().put(UV_CREDENTIAL_KEY, credentialId);
}

/** Remember the whole enrolment, and its id where older code reads it. */
export async function rememberUvEnrolment(enrolment: SignInUvEnrolmentView): Promise<void> {
  const store = new IndexedDBKVStore();
  await store.put(UV_ENROLMENT_KEY, enrolment);
  await store.put(UV_CREDENTIAL_KEY, enrolment.credentialId);
}

/**
 * Create the ES256 passkey and return what the VTA enrols
 * (`org.openvtc.uv-key`, `kind: "webauthn"`).
 *
 * `hardwareBacked` and `biometricGated` are claims the VTA records but does
 * not verify; a browser cannot tell which authenticator answered or how it
 * verified the user, so both are `false` rather than a guess.
 */
export async function createUvPasskey(rpId: string = chrome.runtime.id): Promise<SignInUvEnrolmentView> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: "VTA Wallet sign-in approvals" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: "sign-in approvals",
          displayName: "VTA Wallet sign-in approvals",
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        // ES256 only: vti-webauthn verifies P-256 and nothing else.
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof Error && e.name === "NotAllowedError") {
      throw new PrfUnlockError("cancelled", "Passkey setup cancelled.");
    }
    throw e;
  }
  if (!cred) throw new PrfUnlockError("cancelled", "No passkey was created.");
  const response = cred.response as AuthenticatorAttestationResponse;
  if (response.getPublicKeyAlgorithm() !== -7) {
    throw new Error("the authenticator did not create an ES256 (P-256) passkey");
  }
  const spki = response.getPublicKey();
  if (!spki) throw new Error("the authenticator did not return the passkey's public key");
  return {
    kind: "webauthn",
    credentialId: base64url.encode(new Uint8Array(cred.rawId)),
    publicKeyMultibase: p256Multikey(p256PointFromSpki(new Uint8Array(spki))),
    rpId,
    origin: `chrome-extension://${rpId}`,
    hardwareBacked: false,
    biometricGated: false,
  };
}

/**
 * The grant's user verification: an assertion by the enrolled passkey over
 * `challengeB64u` (the UTF-8 bytes of the grant digest string, computed by the
 * offscreen document from the grant it holds), with user verification.
 */
export async function assertUvPasskey(
  credentialId: string,
  challengeB64u: string,
  rpId: string = chrome.runtime.id,
): Promise<SignInUvAssertionView> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: base64url.decode(challengeB64u) as BufferSource,
        allowCredentials: [{ type: "public-key", id: base64url.decode(credentialId).buffer as ArrayBuffer }],
        userVerification: "required",
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof Error && e.name === "NotAllowedError") {
      throw new PrfUnlockError("cancelled", "Authenticator prompt cancelled.");
    }
    throw e;
  }
  if (!cred) throw new PrfUnlockError("cancelled", "Authenticator returned no assertion.");
  const r = cred.response as AuthenticatorAssertionResponse;
  const b = (buf: ArrayBuffer) => base64url.encode(new Uint8Array(buf));
  const id = b(cred.rawId);
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: b(r.clientDataJSON),
      authenticatorData: b(r.authenticatorData),
      signature: b(r.signature),
      ...(r.userHandle ? { userHandle: b(r.userHandle) } : {}),
    },
  };
}
