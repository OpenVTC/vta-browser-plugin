// Verify a W3C Data Integrity proof (`eddsa-jcs-2022`) on a Trust-Task
// envelope — the inverse of `./sign.ts`. The wallet uses this to verify the
// `proof` on inbound proof-bearing Trust-Task documents (e.g. a
// `task-consent/request` whose effects are bound to the executor's key, or a
// step-up `approve-request` whose `reason` is bound to the RP's key),
// mirroring the Rust `verify_trust_task_proof` in the VTA.
//
// Same canonicalization (JCS / RFC 8785) and signing input as `sign.ts`:
// SHA-256(JCS(proofConfig-minus-proofValue)) || SHA-256(JCS(doc-minus-proof)),
// verified with Ed25519 against the key the proof's `verificationMethod`
// resolves to — read from the signer's DID document under the relationship
// the proof is for, in either encoding (`publicKeyMultibase`, or a did:webs
// `JsonWebKey`'s `publicKeyJwk`; VTI-KEY-003), through `did/vm-key.ts`.

import { ed25519 } from "@noble/curves/ed25519.js";
import { didKey, sameReference, stripScidSrc } from "@openvtc/vti-didcomm-js";
import { ED25519, isVerificationRelationship, selectKey, type VerificationRelationship } from "../did/vm-key.js";
import { resolveDidDocument } from "../didcomm/index.js";
import { base58btcDecode, jcsCanonicalize, sha256 } from "./canonical.js";

/** A Data Integrity proof as produced by {@link signTrustTask}. */
interface DataIntegrityProof {
  type?: string;
  cryptosuite?: string;
  verificationMethod?: string;
  proofPurpose?: string;
  created?: string;
  proofValue?: string;
}

export interface VerifyTrustTaskProofResult {
  /** Whether the Ed25519 signature verified against the resolved key. */
  verified: boolean;
  /** The DID that controls the proof's `verificationMethod` (the proven
   *  signer). Present whenever the proof + verificationMethod parsed, even if
   *  the signature check failed — callers should gate on `verified`. */
  signer?: string;
  /** Failure detail when `verified` is false. */
  reason?: string;
}

export interface VerifyTrustTaskProofOptions {
  /** The proof purpose the caller requires (e.g. `"assertionMethod"`). When
   *  set, a proof with a different `proofPurpose` fails verification.
   *
   *  Either way, the key is read only from the relationship the proof is for
   *  (this purpose, or the `proofPurpose` the proof states when none is
   *  required), so a proof whose `verificationMethod` the signer's DID document
   *  does not list there fails. A proof that says `authentication` is an
   *  authentication by the DID only when its controller put the key there — and
   *  a did:webs with key roles puts different keys under each relationship. */
  expectedProofPurpose?: "assertionMethod" | "authentication";
  /** Resolve a DID to its DID document. Defaults to the wallet's built-in
   *  resolver ({@link resolveDidDocument}, covers did:key / did:peer / did:webvh).
   *  `did:key` is always resolved locally regardless of this. */
  resolveDid?: (did: string) => Promise<Record<string, unknown>>;
}

/**
 * Verify the `eddsa-jcs-2022` Data Integrity proof on a Trust-Task envelope.
 * Does NOT check framework-level bindings (issuer==signer, recipient, expiry,
 * challenge echo) — that's the caller's job; this only answers "is the proof a
 * valid signature by the key it names, over these bytes".
 */
export async function verifyTrustTaskProof(
  document: Record<string, unknown> & { proof?: unknown },
  opts: VerifyTrustTaskProofOptions = {},
): Promise<VerifyTrustTaskProofResult> {
  const proof = document.proof as DataIntegrityProof | undefined;
  if (!proof || typeof proof !== "object") {
    return { verified: false, reason: "no proof" };
  }
  if (proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022") {
    return { verified: false, reason: `unsupported proof suite: ${proof.type}/${proof.cryptosuite}` };
  }
  if (opts.expectedProofPurpose && proof.proofPurpose !== opts.expectedProofPurpose) {
    return { verified: false, reason: `proofPurpose ${proof.proofPurpose} != ${opts.expectedProofPurpose}` };
  }
  const vm = proof.verificationMethod;
  if (typeof vm !== "string" || !vm.includes("#")) {
    return { verified: false, reason: "missing/invalid verificationMethod" };
  }
  if (typeof proof.proofValue !== "string" || !proof.proofValue.startsWith("z")) {
    return { verified: false, reason: "missing/invalid proofValue (expected multibase 'z')" };
  }

  // The relationship the key must be listed under: the purpose the caller
  // requires, or failing that the one the proof claims (Data Integrity: a
  // verification method is used only for a purpose its controller authorised).
  const relationship = opts.expectedProofPurpose ?? proof.proofPurpose;
  if (!isVerificationRelationship(relationship)) {
    return { verified: false, reason: `unsupported proofPurpose: ${String(proof.proofPurpose)}` };
  }

  // Resolved through the DID URL the proof names — for a did:scid, with the
  // `src` a verifier that has not seen it needs — and attributed to its
  // identity, the DID without that `src` (VTI-KEY-163).
  const controller = vm.slice(0, vm.indexOf("#"));
  const signer = stripScidSrc(controller);

  let didDocument: Record<string, unknown>;
  try {
    didDocument = controller.startsWith("did:key:")
      ? (didKey.resolve(controller).didDocument as Record<string, unknown>)
      : await (opts.resolveDid ?? resolveDidDocument)(controller);
  } catch (e) {
    return { verified: false, signer, reason: `verificationMethod resolution failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  // The VTA, the VTC and the did-hosting RP check the relationship the same
  // way (VTI #1740, affinidi-webvh-service #213).
  if (!listsMethodUnder(didDocument, vm, relationship)) {
    return {
      verified: false,
      signer,
      reason: `${vm} is not listed under ${relationship} in the DID document of ${controller}`,
    };
  }
  let publicKey: Uint8Array;
  try {
    ({ publicKey } = selectKey(didDocument, controller, relationship, { kid: vm, curves: [ED25519] }));
  } catch (e) {
    return { verified: false, signer, reason: `verificationMethod resolution failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Reconstruct the signing input exactly as sign.ts built it: the proofConfig
  // is the proof object with `proofValue` removed.
  const proofConfig: Record<string, unknown> = { ...proof };
  delete proofConfig.proofValue;
  const docCopy: Record<string, unknown> = { ...document };
  delete docCopy.proof;

  const proofConfigHash = await sha256(jcsCanonicalize(proofConfig));
  const docHash = await sha256(jcsCanonicalize(docCopy));
  const toVerify = new Uint8Array(proofConfigHash.length + docHash.length);
  toVerify.set(proofConfigHash, 0);
  toVerify.set(docHash, proofConfigHash.length);

  const sig = base58btcDecode(proof.proofValue.slice(1));
  if (sig.length !== 64) {
    return { verified: false, signer, reason: `unexpected signature length: ${sig.length}` };
  }

  const verified = ed25519.verify(sig, toVerify, publicKey);
  return verified
    ? { verified: true, signer }
    : { verified: false, signer, reason: "signature verification failed" };
}

/**
 * Whether `doc` lists the verification method `vm` under `relationship`: by
 * absolute DID URL, by relative `#fragment`, or as an embedded method.
 */
export function listsMethodUnder(
  doc: Record<string, unknown>,
  vm: string,
  relationship: VerificationRelationship,
): boolean {
  const hash = vm.indexOf("#");
  const fragment = hash >= 0 ? vm.slice(hash) : undefined;
  const names = (id: unknown): boolean =>
    typeof id === "string" && (sameReference(id, vm) || (fragment !== undefined && id === fragment));
  const entries = doc[relationship];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) =>
    typeof entry === "string"
      ? names(entry)
      : typeof entry === "object" && entry !== null && names((entry as { id?: unknown }).id),
  );
}
