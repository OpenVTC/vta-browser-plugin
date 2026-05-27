// Derive a candidate `signingKeyId` (verification-method id) from a
// DID. Used by the popup's AddEntryForm to auto-fill the field when
// the operator types a principal DID — saves them looking up
// `<did>#key-0` style fragments by hand.
//
// Resolution strategy per method:
//
//   - **did:key**: lexical. `did:key:zXxx` decomposes to
//     `did:key:zXxx#zXxx` — the multibase tag IS the verification-
//     method fragment. No network round-trip.
//
//   - **did:peer:2**: self-resolving from the DID identifier
//     itself; the keys are inline-encoded. The wallet's existing
//     resolver in `vti-didcomm-js` handles this offline.
//
//   - **did:webvh** / **did:web**: requires resolving the DID
//     document over the network. The resolver in `vti-didcomm-js`
//     walks the webvh log + verifies every Data Integrity proof,
//     so a successful resolve is a real attestation.
//
// Selection: when the resolved DID document has a single
// `authentication` (or `assertionMethod`) entry, return its id and
// `candidates.length === 1` so the popup can auto-fill the field.
// When multiple are present, return them all so the popup can offer
// a picker — the operator picks which key signs.
//
// `verifyDid` already exists for the consent-prompt's DID resolution
// path; this file is a parallel surface focused on extracting the
// VM id rather than just validating resolution.

import { resolve as vtiResolve } from "@openvtc/vti-didcomm-js";

import { didMethod } from "./verify.js";

export interface DeriveSigningKeyIdResult {
  /** The DID the caller asked us to derive for. Echoed for symmetry. */
  did: string;
  /** Plausible verification-method ids the holder could sign with.
   *  Empty when resolution failed; one entry for the trivial case
   *  (did:key or single-key DIDs); multiple for DIDs with several
   *  authentication keys. The popup auto-fills only on
   *  `candidates.length === 1`. */
  candidates: string[];
  /** Human-readable resolution error (network / structural / hash
   *  chain), if any. Surfaces to the operator so they know whether
   *  to type the kid by hand or fix the DID. */
  error?: string;
}

/** Derive the verification-method id (`signingKeyId`) candidates from
 *  the given DID. Never throws — failures land as `candidates: []` +
 *  an `error` string. */
export async function deriveSigningKeyId(did: string): Promise<DeriveSigningKeyIdResult> {
  const method = didMethod(did);
  if (method === "key") {
    // did:key:zXxx → did:key:zXxx#zXxx. The multibase tag (after
    // `did:key:`) IS the fragment by convention.
    const mb = did.slice("did:key:".length);
    if (!mb.startsWith("z")) {
      return { did, candidates: [], error: "did:key identifier is not base58btc multibase" };
    }
    return { did, candidates: [`${did}#${mb}`] };
  }
  if (method === "unknown") {
    return { did, candidates: [], error: "Unrecognised DID method" };
  }
  // did:peer, did:webvh: full resolution. did:peer is offline; webvh
  // hits the network and verifies the log.
  try {
    const resolution = (await vtiResolve(did, {})) as {
      didDocument?: {
        id?: string;
        authentication?: Array<string | { id?: string }>;
        assertionMethod?: Array<string | { id?: string }>;
        verificationMethod?: Array<{ id?: string }>;
      };
      didResolutionMetadata?: { error?: string };
    };
    const resolverError = resolution.didResolutionMetadata?.error;
    if (resolverError) {
      return { did, candidates: [], error: resolverError };
    }
    const doc = resolution.didDocument;
    if (!doc) {
      return { did, candidates: [], error: "Resolver returned no DID document" };
    }
    // Prefer `authentication` (the signing-purpose-correct list for
    // SIOP-style id_tokens). Fall back to `assertionMethod` if absent.
    // Final fallback: enumerate `verificationMethod` ids — better to
    // give the operator something than nothing.
    const candidates =
      collectVmIds(doc.authentication) ||
      collectVmIds(doc.assertionMethod) ||
      collectVmIds(doc.verificationMethod) ||
      [];
    if (candidates.length === 0) {
      return { did, candidates: [], error: "DID document has no usable verification methods" };
    }
    return { did, candidates };
  } catch (e) {
    return { did, candidates: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Extract the `id` string of every verification-method reference,
 *  whether stored as a bare URL string or an embedded VM object.
 *  Returns `null` (not `[]`) when the input is `undefined` so the
 *  caller can short-circuit the `||` chain to the next purpose
 *  rather than landing on an empty list it would otherwise treat as
 *  authoritative. */
function collectVmIds(
  vms: Array<string | { id?: string }> | undefined,
): string[] | null {
  if (!vms || vms.length === 0) return null;
  const out: string[] = [];
  for (const entry of vms) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry === "object" && typeof entry.id === "string")
      out.push(entry.id);
  }
  return out.length > 0 ? out : null;
}
