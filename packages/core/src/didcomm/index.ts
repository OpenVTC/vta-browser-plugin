// DIDComm v2 facade over `@openvtc/vti-didcomm-js`.
//
// This module is the single seam between `@pnm/core` and the
// underlying DIDComm implementation. It used to wrap a WASM crate;
// it now wraps the pure-JS `@openvtc/vti-didcomm-js` library. The
// public surface (Identity, pack*/unpack*, wrapForward, the type
// shapes) is kept stable so consumers only had to learn that the
// pack/unpack calls became async.
//
// Scope of the current library version: X25519 key agreement,
// ECDH-1PU+A256CBC-HS512 authcrypt and ECDH-ES anoncrypt, single
// recipient per envelope. The type surface intentionally stays
// broader than that (OKP|EC, X25519|P-256|secp256k1) because did:peer
// and P-256/secp256k1 support are landing in the library — when they
// do, this facade needs no change since it only forwards JWKs to the
// library's curve-dispatching pack/unpack.

import {
  pack as vtiPack,
  packAnoncrypt as vtiPackAnoncrypt,
  unpack as vtiUnpack,
  buildForward as vtiBuildForward,
  x25519,
  jwk as vtiJwk,
} from "@openvtc/vti-didcomm-js";

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

// `buildForward` accepts an anoncrypt form (no `from`/`mediatorDid`),
// but the library's generated `.d.ts` marks both as required. Re-type
// it to the shape we actually call.
const buildAnoncryptForward = vtiBuildForward as (args: {
  next: string;
  innerJwe: string;
}) => Record<string, unknown>;

// Private key material is held off the Identity instance so it never
// appears on the public shape and can be dropped on `dispose()`.
interface IdentitySecret {
  kid: string;
  privateJwk: SecretJwk;
}
const SECRETS = new WeakMap<Identity, IdentitySecret>();

function requireSecret(id: Identity): IdentitySecret {
  const secret = SECRETS.get(id);
  if (!secret) {
    throw new Error("Identity has been disposed");
  }
  return secret;
}

/**
 * A DIDComm key-agreement identity: a DID, the verification-method
 * `kid` to advertise on the wire, and the X25519 secret used to
 * authcrypt/decrypt. Replaces the former WASM `Identity` class with a
 * pure-JS equivalent. `dispose()` drops the private material; the raw
 * base64url strings can't be reliably zeroized in JS, so this is a
 * best-effort release rather than a wipe.
 */
export class Identity {
  readonly did: string;
  readonly kid: string;

  private constructor(did: string, kid: string, privateJwk: SecretJwk) {
    this.did = did;
    this.kid = kid;
    SECRETS.set(this, { kid, privateJwk });
  }

  /** Mint a fresh X25519 identity for `did`. The `kid` defaults to
   *  `<did>#key-1`; callers that need a canonical key id reconstruct
   *  via `fromSecretJwk` once they've computed it. */
  static generate(did: string): Identity {
    const { privateKey, publicKey } = x25519.generateKeyPair();
    const priv = vtiJwk.privateJwk("X25519", privateKey, publicKey);
    return new Identity(did, `${did}#key-1`, {
      kty: "OKP",
      crv: "X25519",
      x: priv.x,
      d: priv.d as string,
    });
  }

  /** Reconstruct a persisted identity. */
  static fromSecretJwk(input: {
    did: string;
    kid: string;
    jwk: SecretJwk;
  }): Identity {
    if (!input.jwk.d) {
      throw new TypeError("Identity.fromSecretJwk: jwk.d (private scalar) required");
    }
    return new Identity(input.did, input.kid, { ...input.jwk });
  }

  /** Public JWK + its `kid`, for handing to a counterparty as a recipient. */
  publicJwk(): { kid: string; jwk: PublicJwk } {
    const { privateJwk } = requireSecret(this);
    const pub: PublicJwk = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
    };
    if (privateJwk.y !== undefined) pub.y = privateJwk.y;
    return { kid: this.kid, jwk: pub };
  }

  /** Persistable secret form (`{ did, kid, jwk }`). */
  secretJwk(): { did: string; kid: string; jwk: SecretJwk } {
    const { privateJwk } = requireSecret(this);
    return { did: this.did, kid: this.kid, jwk: { ...privateJwk } };
  }

  /** Drop the private key material held for this identity. */
  dispose(): void {
    SECRETS.delete(this);
  }
}

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

function withId<T extends { id?: string }>(message: T): T & { id: string } {
  if (message.id) return message as T & { id: string };
  return { ...message, id: globalThis.crypto.randomUUID() };
}

function singleRecipient(recipients: DidcommRecipient[]): DidcommRecipient {
  const recipient = recipients[0];
  if (recipients.length !== 1 || !recipient) {
    throw new Error(
      `DIDComm facade packs to exactly one recipient, got ${recipients.length}`,
    );
  }
  return recipient;
}

/** Build a DIDComm v2 plaintext message and return its JSON form. */
export function buildPlaintextMessage(input: PlaintextMessageInput): string {
  return JSON.stringify(withId(input));
}

/** Pack as anoncrypt — no sender identity exposed. */
export function packAnoncrypt(
  message: PlaintextMessageInput,
  recipients: DidcommRecipient[],
): Promise<string> {
  const recipient = singleRecipient(recipients);
  return vtiPackAnoncrypt({
    message: withId(message),
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

/**
 * Pack an already-serialized DIDComm Message JSON as anoncrypt.
 * Use this for forward-envelope composition where the inner Message
 * has fields (attachments, custom extras) that the builder shape
 * doesn't carry.
 */
export function packAnoncryptJson(
  messageJson: string,
  recipients: DidcommRecipient[],
): Promise<string> {
  const recipient = singleRecipient(recipients);
  return vtiPackAnoncrypt({
    message: JSON.parse(messageJson),
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

/**
 * Pack an already-serialized DIDComm Message JSON as authcrypt.
 * Sibling of `packAnoncryptJson`; needed for messages whose shape
 * exceeds the builder (attachments, custom extras) **and** whose
 * sender must be authenticated to the recipient. The
 * `pickup/3.0/delivery` envelope is the primary case.
 */
export function packAuthcryptJson(
  messageJson: string,
  sender: Identity,
  recipients: DidcommRecipient[],
): Promise<string> {
  const secret = requireSecret(sender);
  const recipient = singleRecipient(recipients);
  return vtiPack({
    message: JSON.parse(messageJson),
    sender: { kid: secret.kid, privateJwk: secret.privateJwk },
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

/**
 * Wrap an already-encrypted JWE in a Routing 2.0 forward envelope.
 * Returns the **plaintext** forward Message JSON; pair with
 * `packAnoncryptJson` to anoncrypt it to the mediator.
 */
export function wrapForward(next: string, encryptedJwe: string): string {
  return JSON.stringify(buildAnoncryptForward({ next, innerJwe: encryptedJwe }));
}

/**
 * Pack as authcrypt — sender authenticated to recipients. The
 * `sender` identity's private key is used to derive the sender-bound
 * KEK; only its public material reaches the wire.
 */
export function packAuthcrypt(
  message: PlaintextMessageInput,
  sender: Identity,
  recipients: DidcommRecipient[],
): Promise<string> {
  const secret = requireSecret(sender);
  const recipient = singleRecipient(recipients);
  return vtiPack({
    message: withId(message),
    sender: { kid: secret.kid, privateJwk: secret.privateJwk },
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

// The library matches the recipient by an exact `kid` string against
// the JWE `recipients[]`. The former WASM impl matched by key material
// (via a secrets resolver), so a holder whose stored `kid` differed
// from the one a counterparty used to address it still decrypted.
// Preserve that: if the stored kid isn't present but there's exactly
// one recipient entry, decrypt against that entry's kid. The private
// key is the real authority — a wrong key fails AES-KW unwrap
// regardless of the kid string.
function resolveRecipientKid(jweJson: string, storedKid: string): string {
  try {
    const jwe = JSON.parse(jweJson) as {
      recipients?: Array<{ header?: { kid?: string } }>;
    };
    const entries = jwe.recipients ?? [];
    if (entries.some((e) => e?.header?.kid === storedKid)) return storedKid;
    const sole = entries.length === 1 ? entries[0]?.header?.kid : undefined;
    if (typeof sole === "string") return sole;
  } catch {
    // Fall through — let the library's unpack raise the canonical
    // parse error.
  }
  return storedKid;
}

/**
 * Auto-detect format and unpack a JWE. For authcrypt pass
 * `sender_public_jwk` so the sender binding can be verified. The
 * library only produces encrypted results, so `kind` is always
 * `"encrypted"`; the union retains the other variants for API
 * stability.
 */
export async function unpackMessage(
  args: { input: string; sender_public_jwk?: PublicJwk },
  recipient: Identity,
): Promise<UnpackResult> {
  const secret = requireSecret(recipient);
  const recipientKid = resolveRecipientKid(args.input, secret.kid);
  const result = await vtiUnpack(
    args.input,
    { kid: recipientKid, privateJwk: secret.privateJwk },
    args.sender_public_jwk ? { publicJwk: args.sender_public_jwk } : undefined,
  );
  const out: Extract<UnpackResult, { kind: "encrypted" }> = {
    kind: "encrypted",
    message: result.message as Record<string, unknown>,
    authenticated: result.authenticated,
    recipient_kid: recipientKid,
  };
  if (result.senderKid) out.sender_kid = result.senderKid;
  return out;
}

/** Identifier of the underlying DIDComm implementation. */
export function didcommCrateVersion(): string {
  return "@openvtc/vti-didcomm-js";
}

// ---------------------------------------------------------------------------
// Smoke helper — exercises pack→unpack round-trip end-to-end. Useful
// from the PWA console to validate the crypto path works. Not for
// production use.
// ---------------------------------------------------------------------------

export interface SmokeRoundtripResult {
  ok: boolean;
  packedLength: number;
  recoveredMessageType: string | undefined;
  authenticated: boolean | undefined;
  error?: string;
}

export async function smokeAuthcryptRoundtrip(): Promise<SmokeRoundtripResult> {
  let alice: Identity | null = null;
  let bob: Identity | null = null;
  try {
    alice = Identity.generate("did:example:alice");
    bob = Identity.generate("did:example:bob");
    const bobPub = bob.publicJwk();
    const alicePub = alice.publicJwk();

    const packed = await packAuthcrypt(
      {
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: alice.did,
        to: [bob.did],
        body: { content: "hello from the vti-didcomm-js smoke test" },
      },
      alice,
      [bobPub],
    );

    const out = await unpackMessage(
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
