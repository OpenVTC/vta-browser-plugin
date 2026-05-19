import {
  Identity as WasmIdentity,
  buildPlaintextMessage as wasmBuildPlaintextMessage,
  packAnoncrypt as wasmPackAnoncrypt,
  packAuthcrypt as wasmPackAuthcrypt,
  unpack as wasmUnpack,
  didcommCrateVersion as wasmDidcommCrateVersion,
} from "@pnm/didcomm-wasm";

export type DidcommCurve = "X25519" | "P-256" | "secp256k1";

/** Plaintext message inputs. `id` is auto-generated as a v4 UUID when omitted. */
export interface PlaintextMessageInput {
  id?: string;
  type: string;
  from?: string;
  to?: string[];
  body: unknown;
  thid?: string;
}

/** A recipient for `packAuthcrypt` / `packAnoncrypt`. */
export interface DidcommRecipient {
  kid: string;
  jwk: PublicJwk;
}

/** Public key-agreement JWK shape. */
export interface PublicJwk {
  kty: "OKP" | "EC";
  crv: "X25519" | "P-256" | "secp256k1";
  x: string;
  y?: string;
}

/** Secret key-agreement JWK shape (must include `d`). */
export interface SecretJwk extends PublicJwk {
  d: string;
}

/**
 * Re-export of the WASM `Identity` class. Holds the operator's
 * DIDComm key-agreement secret in WASM linear memory after
 * `Identity.fromSecretJwk` is called. Always `.dispose()` when done.
 */
export const Identity = WasmIdentity;
export type Identity = WasmIdentity;

export type UnpackResult =
  | {
      kind: "encrypted";
      message: Record<string, unknown>;
      authenticated: boolean;
      sender_kid?: string;
      recipient_kid: string;
    }
  | {
      kind: "signed";
      message: Record<string, unknown>;
      signer_kid?: string;
    }
  | {
      kind: "plaintext";
      message: Record<string, unknown>;
    };

/** Build a DIDComm v2 plaintext message and return its JSON form. */
export function buildPlaintextMessage(input: PlaintextMessageInput): string {
  return wasmBuildPlaintextMessage(input);
}

/** Pack as anoncrypt — no sender identity exposed. */
export function packAnoncrypt(
  message: PlaintextMessageInput,
  recipients: DidcommRecipient[],
): string {
  return wasmPackAnoncrypt(message, recipients);
}

/**
 * Pack as authcrypt — sender authenticated to recipients. The
 * `sender` handle is borrowed for the duration of this call; the
 * private key stays in WASM linear memory.
 */
export function packAuthcrypt(
  message: PlaintextMessageInput,
  sender: Identity,
  recipients: DidcommRecipient[],
): string {
  return wasmPackAuthcrypt(message, sender, recipients);
}

/**
 * Auto-detect format and unpack a JWE. For authcrypt pass
 * `sender_public_jwk` so the sender binding can be verified.
 *
 * `recipient` is borrowed; the handle stays usable after this call.
 */
export function unpackMessage(
  args: { input: string; sender_public_jwk?: PublicJwk },
  recipient: Identity,
): UnpackResult {
  return wasmUnpack(args, recipient) as UnpackResult;
}

export function didcommCrateVersion(): string {
  return wasmDidcommCrateVersion();
}

// ---------------------------------------------------------------------------
// Smoke helper — exercises pack→unpack round-trip end-to-end. Useful
// from the PWA console to validate the WASM bundle loads and the
// crypto path works. Not for production use.
// ---------------------------------------------------------------------------

export interface SmokeRoundtripResult {
  ok: boolean;
  packedLength: number;
  recoveredMessageType: string | undefined;
  authenticated: boolean | undefined;
  error?: string;
}

export function smokeAuthcryptRoundtrip(): SmokeRoundtripResult {
  let alice: Identity | null = null;
  let bob: Identity | null = null;
  try {
    alice = Identity.generate("did:example:alice");
    bob = Identity.generate("did:example:bob");
    const bobPub = bob.publicJwk() as { kid: string; jwk: PublicJwk };
    const alicePub = alice.publicJwk() as { kid: string; jwk: PublicJwk };

    const packed = packAuthcrypt(
      {
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: alice.did,
        to: [bob.did],
        body: { content: "hello from the wasm smoke test" },
      },
      alice,
      [bobPub],
    );

    const out = unpackMessage(
      { input: packed, sender_public_jwk: alicePub.jwk },
      bob,
    );
    if (out.kind !== "encrypted") {
      return {
        ok: false,
        packedLength: packed.length,
        recoveredMessageType: undefined,
        authenticated: undefined,
        error: `unexpected kind ${out.kind}`,
      };
    }
    return {
      ok: true,
      packedLength: packed.length,
      recoveredMessageType: out.message["type"] as string | undefined,
      authenticated: out.authenticated,
    };
  } catch (err) {
    return {
      ok: false,
      packedLength: 0,
      recoveredMessageType: undefined,
      authenticated: undefined,
      error: (err as Error).message,
    };
  } finally {
    alice?.dispose();
    bob?.dispose();
  }
}
