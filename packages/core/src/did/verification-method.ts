import { bytesToBase64url } from "../webauthn/base64url.js";

/**
 * A `verificationMethod` entry, in the shape we want appended to the
 * VTA-managed DID document. Type `Multikey` is the W3C-recommended
 * representation; `publicKeyMultibase` carries the base58btc-encoded
 * multicodec-prefixed key.
 *
 * The `webauthn*` extensions are non-core but explicit: any verifier
 * resolving the DID can find the VM by `credentialId` hash and verify
 * a WebAuthn assertion against `publicKeyMultibase` directly — no
 * round-trip to the VTA required.
 */
export interface PasskeyVerificationMethod {
  id: string;
  type: "Multikey";
  controller: string;
  publicKeyMultibase: string;
  /** WebAuthn credential id, base64url-encoded. */
  webauthnCredentialId: string;
  /** Transport hints the authenticator reported (e.g. "internal", "hybrid"). */
  webauthnTransports?: AuthenticatorTransport[];
  /**
   * Optional friendly label set by the operator (e.g. "MacBook Touch
   * ID", "YubiKey 5C"). Surfaced in UI; not used for verification.
   */
  label?: string;
}

export interface BuildVerificationMethodArgs {
  did: string;
  credentialId: string;
  credentialIdBytes: Uint8Array;
  publicKeyMultikey: string;
  transports?: AuthenticatorTransport[];
  label?: string;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/**
 * Derive the VM fragment from the credential id. SHA-256 keeps the
 * fragment short and stable while still being deterministic — a
 * verifier given a WebAuthn assertion can recompute the fragment
 * from `credential.id` and look it up in the DID document.
 */
export async function passkeyVerificationMethodFragment(
  credentialIdBytes: Uint8Array,
): Promise<string> {
  const hash = await sha256(credentialIdBytes);
  return `passkey-${bytesToBase64url(hash)}`;
}

export async function buildPasskeyVerificationMethod(
  args: BuildVerificationMethodArgs,
): Promise<PasskeyVerificationMethod> {
  const fragment = await passkeyVerificationMethodFragment(args.credentialIdBytes);
  const vm: PasskeyVerificationMethod = {
    id: `${args.did}#${fragment}`,
    type: "Multikey",
    controller: args.did,
    publicKeyMultibase: args.publicKeyMultikey,
    webauthnCredentialId: args.credentialId,
  };
  if (args.transports && args.transports.length > 0) {
    vm.webauthnTransports = args.transports;
  }
  if (args.label) {
    vm.label = args.label;
  }
  return vm;
}
