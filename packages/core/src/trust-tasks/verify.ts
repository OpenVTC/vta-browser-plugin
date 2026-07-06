// Verify a W3C Data Integrity proof (`eddsa-jcs-2022`) on a Trust-Task
// envelope — the inverse of `./sign.ts`. The wallet uses this to verify the
// `proof` on inbound proof-bearing Trust-Task documents (e.g. a spec-conformant
// `confirm/request` whose `reason` is bound to the RP's key), mirroring the
// Rust `verify_trust_task_proof` in the VTA.
//
// Same canonicalization (JCS / RFC 8785) and signing input as `sign.ts`:
// SHA-256(JCS(proofConfig-minus-proofValue)) || SHA-256(JCS(doc-minus-proof)),
// verified with Ed25519 against the key the proof's `verificationMethod`
// resolves to.

import { ed25519 } from "@noble/curves/ed25519.js";
import { didKey, multibase } from "@openvtc/vti-didcomm-js";
import { resolveDidDocument } from "../didcomm/index.js";
import { base58btcDecode, jcsCanonicalize, sha256 } from "./canonical.js";

const ED25519_PUB = multibase.MULTICODEC.ED25519_PUB;

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
   *  set, a proof with a different `proofPurpose` fails verification. */
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

  const controller = vm.slice(0, vm.indexOf("#"));

  let publicKey: Uint8Array;
  try {
    publicKey = await resolveEd25519Key(vm, controller, opts.resolveDid);
  } catch (e) {
    return { verified: false, signer: controller, reason: `verificationMethod resolution failed: ${e instanceof Error ? e.message : String(e)}` };
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
    return { verified: false, signer: controller, reason: `unexpected signature length: ${sig.length}` };
  }

  const verified = ed25519.verify(sig, toVerify, publicKey);
  return verified
    ? { verified: true, signer: controller }
    : { verified: false, signer: controller, reason: "signature verification failed" };
}

/** Resolve a `verificationMethod` DID URL to its Ed25519 public-key bytes. */
async function resolveEd25519Key(
  vm: string,
  controller: string,
  resolveDid?: (did: string) => Promise<Record<string, unknown>>,
): Promise<Uint8Array> {
  const doc = controller.startsWith("did:key:")
    ? (didKey.resolve(controller).didDocument as Record<string, unknown>)
    : await (resolveDid ?? resolveDidDocument)(controller);

  const methods = (doc.verificationMethod as { id: string; publicKeyMultibase?: string }[] | undefined) ?? [];
  const method = methods.find((m) => m.id === vm) ?? methods.find((m) => m.id.endsWith(vm.slice(vm.indexOf("#"))));
  if (!method?.publicKeyMultibase) {
    throw new Error(`verificationMethod ${vm} not found or missing publicKeyMultibase`);
  }
  const { codec, key } = multibase.decodeMultikey(method.publicKeyMultibase);
  if (codec[0] !== ED25519_PUB[0] || codec[1] !== ED25519_PUB[1]) {
    throw new Error("verificationMethod key is not Ed25519");
  }
  return key;
}
