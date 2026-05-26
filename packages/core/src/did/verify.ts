// DID verification for the consent prompt.
//
// Before the wallet logs into an RP, the consent popup wants to tell the
// operator whether the rpDid actually resolves — and, for did:webvh, whether
// its declared domain is consistent with the page origin the request came
// from. This is the operator-facing complement to origin pinning: pinning
// catches "this site swapped which RP it points at"; verification catches
// "this site is pointing at an RP whose DID does not resolve" or "claims an
// RP whose domain has nothing to do with the page".
//
// did:webvh resolution is cryptographic (the library walks the log, verifies
// the SCID/hash chain, and verifies every Data Integrity proof on each entry)
// — a successful resolve is a real attestation, not just "fetch returned 200".
// did:peer / did:key are self-certifying (the keys are encoded in the id), so
// resolution is purely structural validation.

import { resolve as vtiResolve } from "@openvtc/vti-didcomm-js";

export type DidMethod = "webvh" | "peer" | "key" | "unknown";

export interface VerifyDidResult {
  /** Canonical DID under verification. */
  did: string;
  /** Parsed DID method. `unknown` if the input is not a recognisable DID. */
  method: DidMethod;
  /** True if resolution succeeded. For did:webvh this implies the SCID + log
   *  hash chain + every Data Integrity proof verified. For did:peer/did:key
   *  it implies the identifier was structurally valid. */
  resolved: boolean;
  /** For did:webvh — the host the DID identifies (extracted from the DID,
   *  not the resolved document, so the operator sees what the wallet asked
   *  for). The DID is `did:webvh:<scid>:<host>[:<path>...]`. */
  domain?: string;
  /** Human-readable error if resolution failed. */
  error?: string;
}

/**
 * Parse the method of a DID string. Cheap, structural — does not resolve.
 */
export function didMethod(did: string): DidMethod {
  if (did.startsWith("did:webvh:")) return "webvh";
  if (did.startsWith("did:peer:")) return "peer";
  if (did.startsWith("did:key:")) return "key";
  return "unknown";
}

/**
 * Extract the host portion of a `did:webvh:<scid>:<host>[:path:...]`. Returns
 * `undefined` for non-webvh inputs. The path-style segments after the host
 * are intentionally discarded — the operator-facing display only needs the
 * host to compare against the page origin.
 *
 * webvh's wire format percent-encodes the host's `:` and `/`; we leave them
 * encoded because the consent UI only matches on hostname (which never
 * contains either).
 */
export function didWebvhDomain(did: string): string | undefined {
  if (!did.startsWith("did:webvh:")) return undefined;
  const parts = did.split(":");
  // ["did", "webvh", "<scid>", "<host>", ...path]
  return parts[3];
}

/**
 * Resolve and validate an RP DID. Never throws — failures are returned via
 * `resolved: false` and `error`, because the consent UI wants to *render*
 * the error rather than crash.
 */
export async function verifyDid(did: string): Promise<VerifyDidResult> {
  const method = didMethod(did);
  const domain = method === "webvh" ? didWebvhDomain(did) : undefined;
  const base: VerifyDidResult = {
    did,
    method,
    resolved: false,
    ...(domain ? { domain } : {}),
  };
  if (method === "unknown") {
    return { ...base, error: "Unrecognised DID method" };
  }
  try {
    const resolution = (await vtiResolve(did, {})) as {
      didDocument?: { id?: string };
      didResolutionMetadata?: { error?: string };
    };
    const resolverError = resolution.didResolutionMetadata?.error;
    if (resolverError) {
      return { ...base, error: resolverError };
    }
    if (!resolution.didDocument?.id) {
      return { ...base, error: "Resolver returned no DID document" };
    }
    return { ...base, resolved: true };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Decide whether a page origin's hostname is consistent with a did:webvh
 * domain. Exact match or proper subdomain count as consistent. Anything
 * else (sibling subdomain, unrelated host, etc.) is flagged.
 *
 * For non-webvh DIDs this returns `"not-applicable"` — there's no domain
 * encoded in the DID, so the wallet has nothing to compare against.
 */
export type OriginMatch = "match" | "subdomain" | "mismatch" | "not-applicable";

export function compareOriginToDidDomain(
  originHost: string | undefined,
  didDomain: string | undefined,
): OriginMatch {
  if (!didDomain) return "not-applicable";
  if (!originHost) return "mismatch";
  if (originHost === didDomain) return "match";
  if (originHost.endsWith(`.${didDomain}`)) return "subdomain";
  return "mismatch";
}
