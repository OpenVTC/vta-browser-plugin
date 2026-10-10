// Which `proofPurpose` a Trust-Task document is signed for.
//
// The purpose is decided by the document's **type**, never by whoever asked
// for the signature. That is the VTA's rule (`vta_sdk::trust_task_proof::
// purpose_for_document_type`, VTI-KEY-022 / VTI-KEY-106) and this is a copy of
// it for the documents the wallet signs with its own holder key, so the two
// signers of a page's `signTrustTask` — the holder here, the VTA's
// `vault/sign-trust-task` for an `asDid` — answer the same question the same
// way:
//
// - `assertionMethod` for a request document of a registry slug in
//   {@link ATTESTATION_SLUGS} — a statement the signer makes about something
//   else (an approval, a consent decision, a confirmation);
// - `authentication` for everything else, including the `#response` variant of
//   such a slug (the executor's reply is an operational message) and a private
//   registry's reuse of the slug (only `https://trusttasks.org` slugs are
//   classified).
//
// A relying party that binds proofs to key roles refuses the wrong one either
// way: an operational document signed for `assertionMethod` reads as an
// attestation, and an approve-response signed for `authentication` is refused
// by a VTC that requires the subject's assertion (approve-response 0.6,
// consumer step 1a).

const REGISTRY_PREFIX = "https://trusttasks.org/spec/";

/** Registry slugs whose request documents are attestations. Mirrors
 *  `vta_sdk::trust_task_proof::ATTESTATION_SLUGS`; keep the two in step. */
export const ATTESTATION_SLUGS: readonly string[] = [
  "auth/step-up/approve-response",
  "task-consent/decision",
  "confirm/response",
  // The wallet sign-in grant ("let this browser key act as me"), an
  // attestation the VTC verifies against `assertionMethod`. Added to the VTA's
  // list in the same change (sign-in trigger-link contract C5). Its sibling
  // `auth/oob/identify` is deliberately absent: it is `authentication`.
  "auth/oob/grant",
];

export type ProofPurpose = "assertionMethod" | "authentication";

/** The purpose a Trust-Task document of type `typeUri` must be signed for. */
export function proofPurposeForDocumentType(typeUri: string): ProofPurpose {
  if (typeof typeUri !== "string" || !typeUri.startsWith(REGISTRY_PREFIX)) {
    return "authentication";
  }
  if (typeUri.includes("#")) return "authentication";
  const rest = typeUri.slice(REGISTRY_PREFIX.length);
  const m = /^(.+)\/(\d+)\.(\d+)$/.exec(rest);
  if (!m) return "authentication";
  return ATTESTATION_SLUGS.includes(m[1] as string) ? "assertionMethod" : "authentication";
}
