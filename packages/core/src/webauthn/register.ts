import { bytesToBase64url } from "./base64url.js";
import { COSE_ALG, cryptoKeyToMultikey, type CoseAlg } from "./multikey.js";

export interface PasskeyEnrollmentChallenge {
  challenge: Uint8Array;
  rp: { id: string; name: string };
  user: { id: Uint8Array; name: string; displayName: string };
  pubKeyCredParams?: PublicKeyCredentialParameters[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  timeout?: number;
}

export interface PasskeyEnrollmentResult {
  credentialId: string;
  credentialIdBytes: Uint8Array;
  publicKeyMultikey: string;
  coseAlg: CoseAlg;
  attestationObjectB64u: string;
  clientDataJsonB64u: string;
  authenticatorDataB64u: string;
  transports: AuthenticatorTransport[];
}

const DEFAULT_PUBKEY_PARAMS: PublicKeyCredentialParameters[] = [
  { type: "public-key", alg: COSE_ALG.ES256 },
  { type: "public-key", alg: COSE_ALG.EdDSA },
];

function importSpkiForAlg(spki: ArrayBuffer, coseAlg: CoseAlg): Promise<CryptoKey> {
  if (coseAlg === COSE_ALG.ES256) {
    return crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
  }
  if (coseAlg === COSE_ALG.EdDSA) {
    return crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, true, ["verify"]);
  }
  if (coseAlg === COSE_ALG.ES384) {
    return crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-384" },
      true,
      ["verify"],
    );
  }
  throw new Error(`unsupported COSE algorithm: ${coseAlg}`);
}

function isSupportedAlg(alg: number): alg is CoseAlg {
  return alg === COSE_ALG.ES256 || alg === COSE_ALG.EdDSA || alg === COSE_ALG.ES384;
}

/**
 * Run a WebAuthn registration ceremony and produce a payload suitable
 * for posting to the VTA's `POST /did/verification-methods` endpoint.
 *
 * The caller is responsible for obtaining `challenge` from the VTA —
 * never generate it client-side. The VTA stores the challenge and
 * verifies the returned `clientDataJSON`.
 */
export async function enrollPasskey(
  c: PasskeyEnrollmentChallenge,
): Promise<PasskeyEnrollmentResult> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: c.challenge as BufferSource,
      rp: c.rp,
      user: {
        id: c.user.id as BufferSource,
        name: c.user.name,
        displayName: c.user.displayName,
      },
      pubKeyCredParams: c.pubKeyCredParams ?? DEFAULT_PUBKEY_PARAMS,
      authenticatorSelection: c.authenticatorSelection ?? {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      attestation: "direct",
      ...(c.timeout !== undefined ? { timeout: c.timeout } : {}),
    },
  })) as PublicKeyCredential | null;

  if (!cred) throw new Error("WebAuthn registration returned no credential");

  const response = cred.response as AuthenticatorAttestationResponse;

  if (typeof response.getPublicKey !== "function" || typeof response.getPublicKeyAlgorithm !== "function") {
    throw new Error(
      "WebAuthn Level 2 response methods (getPublicKey/getPublicKeyAlgorithm) are unavailable; browser too old",
    );
  }

  const spki = response.getPublicKey();
  if (!spki) {
    throw new Error("authenticator did not expose a Subject Public Key Info");
  }

  const alg = response.getPublicKeyAlgorithm();
  if (!isSupportedAlg(alg)) {
    throw new Error(`authenticator returned unsupported algorithm ${alg}`);
  }

  const cryptoKey = await importSpkiForAlg(spki, alg);
  const multikey = await cryptoKeyToMultikey(cryptoKey, alg);

  const transports = (
    typeof response.getTransports === "function" ? response.getTransports() : []
  ) as AuthenticatorTransport[];

  return {
    credentialId: cred.id,
    credentialIdBytes: new Uint8Array(cred.rawId),
    publicKeyMultikey: multikey,
    coseAlg: alg,
    attestationObjectB64u: bytesToBase64url(new Uint8Array(response.attestationObject)),
    clientDataJsonB64u: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
    authenticatorDataB64u: bytesToBase64url(new Uint8Array(response.getAuthenticatorData())),
    transports,
  };
}
