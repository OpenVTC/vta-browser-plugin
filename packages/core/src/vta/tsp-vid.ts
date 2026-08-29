// TSP VID resolution — turn a DID into the raw key material `TspChannel`
// needs: the VTA's X25519 key-agreement public key (HPKE recipient) and its
// Ed25519 public key (outer-signature verification).
//
// TSP VIDs are DIDs, so this reuses the plugin's DID resolver. The X25519 key
// is the DID's key-agreement VM (same one DIDComm authcrypts to). The Ed25519
// key is the DID's authentication/assertion VM.
//
// The key-format conversions (OKP JWK -> raw, Multikey -> raw) are universal
// and unit-tested. The DID-document VM *selection* is a reasonable heuristic
// that needs validation against a live TSP-enabled VTA's DID document.

import { base58 } from "@scure/base";

import { resolveDidDocument, resolveKeyAgreement } from "../didcomm/index.js";
import { base64urlToBytes } from "../util/base64url.js";
import { VtaClientError } from "./errors.js";
import type { TspRemoteEndpoint } from "./tsp-channel.js";

// Multicodec codes (unsigned-varint) for the raw public-key Multikey forms.
const MULTICODEC_ED25519_PUB = 0xed;
const MULTICODEC_X25519_PUB = 0xec;

/** Decode a leading unsigned-varint; returns the value + bytes consumed. */
function decodeVarint(bytes: Uint8Array): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let i = 0;
  for (; i < bytes.length; i++) {
    const b = bytes[i]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, length: i + 1 };
    shift += 7;
    if (shift > 28) break;
  }
  throw new VtaClientError("e.client.parse", "tsp-vid: malformed multicodec varint");
}

/** Decode a W3C Multikey (`z…` multibase-base58btc) into its multicodec + raw
 *  key bytes. */
export function rawFromMultikey(multibase: string): { codec: number; key: Uint8Array } {
  if (!multibase.startsWith("z")) {
    throw new VtaClientError("e.client.parse", `tsp-vid: not a base58btc Multikey: ${multibase}`);
  }
  const decoded = base58.decode(multibase.slice(1));
  const { value: codec, length } = decodeVarint(decoded);
  return { codec, key: decoded.slice(length) };
}

/** Extract the raw 32-byte public key of an OKP JWK, checking the curve. */
export function rawFromOkpJwk(
  jwk: { kty?: string; crv?: string; x?: string },
  expectedCrv: "X25519" | "Ed25519",
): Uint8Array {
  if (jwk.kty !== "OKP" || jwk.crv !== expectedCrv || !jwk.x) {
    throw new VtaClientError(
      "e.client.parse",
      `tsp-vid: expected OKP ${expectedCrv} JWK, got kty=${jwk.kty} crv=${jwk.crv}`,
    );
  }
  const raw = base64urlToBytes(jwk.x);
  if (raw.length !== 32) {
    throw new VtaClientError("e.client.parse", `tsp-vid: ${expectedCrv} key is ${raw.length} bytes, want 32`);
  }
  return raw;
}

/** Extract a raw 32-byte Ed25519 public key from a DID-document verification
 *  method (either `publicKeyMultibase` Multikey or `publicKeyJwk` OKP). */
export function ed25519FromVerificationMethod(vm: {
  publicKeyMultibase?: string;
  publicKeyJwk?: { kty?: string; crv?: string; x?: string };
}): Uint8Array {
  if (vm.publicKeyMultibase) {
    const { codec, key } = rawFromMultikey(vm.publicKeyMultibase);
    if (codec !== MULTICODEC_ED25519_PUB) {
      throw new VtaClientError("e.client.parse", `tsp-vid: VM is not Ed25519 (multicodec 0x${codec.toString(16)})`);
    }
    if (key.length !== 32) {
      throw new VtaClientError("e.client.parse", `tsp-vid: Ed25519 key is ${key.length} bytes, want 32`);
    }
    return key;
  }
  if (vm.publicKeyJwk) return rawFromOkpJwk(vm.publicKeyJwk, "Ed25519");
  throw new VtaClientError("e.client.parse", "tsp-vid: VM has no publicKeyMultibase or publicKeyJwk");
}

// Minimal DID-document shape we read.
interface DidVerificationMethod {
  id?: string;
  type?: string;
  publicKeyMultibase?: string;
  publicKeyJwk?: { kty?: string; crv?: string; x?: string };
}
interface DidDocument {
  verificationMethod?: DidVerificationMethod[];
  authentication?: Array<string | DidVerificationMethod>;
  assertionMethod?: Array<string | DidVerificationMethod>;
}

/** Resolve a verification-method reference (a `#fragment` id or an inline VM)
 *  against the doc's `verificationMethod` array. */
function derefVm(
  ref: string | DidVerificationMethod,
  vms: DidVerificationMethod[],
): DidVerificationMethod | undefined {
  if (typeof ref !== "string") return ref;
  return vms.find((v) => v.id === ref || v.id?.endsWith(ref));
}

/** Find the DID's Ed25519 signing key: prefer an `authentication` VM, then
 *  `assertionMethod`, then any Ed25519 verification method. */
function findEd25519(doc: DidDocument): Uint8Array {
  const vms = doc.verificationMethod ?? [];
  for (const list of [doc.authentication, doc.assertionMethod]) {
    for (const ref of list ?? []) {
      const vm = derefVm(ref, vms);
      if (!vm) continue;
      try {
        return ed25519FromVerificationMethod(vm);
      } catch {
        // not Ed25519 — keep looking
      }
    }
  }
  for (const vm of vms) {
    try {
      return ed25519FromVerificationMethod(vm);
    } catch {
      // keep looking
    }
  }
  throw new VtaClientError("e.client.parse", "tsp-vid: DID document has no Ed25519 verification method");
}

/**
 * Assemble a {@link TspRemoteEndpoint} from already-resolved pieces: the DID,
 * its X25519 key-agreement JWK, and its DID document. Pure — no network.
 */
export function tspEndpointFromResolved(
  vid: string,
  keyAgreementPublicJwk: { kty?: string; crv?: string; x?: string },
  didDocument: DidDocument,
): TspRemoteEndpoint {
  return {
    vid,
    encryptionPublicKey: rawFromOkpJwk(keyAgreementPublicJwk, "X25519"),
    signingPublicKey: findEd25519(didDocument),
  };
}

/**
 * Resolve a VTA's DID into a {@link TspRemoteEndpoint}: its VID, X25519
 * key-agreement public key (HPKE recipient), and Ed25519 public key (signature
 * verification).
 *
 * `resolveDidDocument` fetches the raw DID document (pass the plugin's DID
 * resolver; injectable for tests). The X25519 key comes from the shared
 * {@link resolveKeyAgreement}.
 */
export async function resolveTspEndpoint(
  did: string,
  resolveDidDocument: (did: string) => Promise<DidDocument>,
): Promise<TspRemoteEndpoint> {
  const ka = await resolveKeyAgreement(did);
  const doc = await resolveDidDocument(did);
  return tspEndpointFromResolved(did, ka.keyAgreementPublicJwk, doc);
}

/**
 * Resolve a VTA's DID into its {@link TspRemoteEndpoint} using the plugin's
 * built-in DID resolver. The zero-dependency convenience form of
 * {@link resolveTspEndpoint} — callers that don't need to inject a resolver
 * (i.e. everything outside tests) use this.
 */
export function resolveVtaTspEndpoint(vtaDid: string): Promise<TspRemoteEndpoint> {
  return resolveTspEndpoint(vtaDid, resolveDidDocument);
}

/** How long a resolved endpoint is reused. Short enough that a key rotation
 *  heals on its own — an inbound frame is redelivered until acked, so a frame
 *  refused against a stale key succeeds on a later delivery once this lapses —
 *  and long enough that a delivery burst resolves once rather than per frame. */
const ENDPOINT_TTL_MS = 5 * 60_000;
/** Bound: one entry per peer, and a wallet talks to a handful. */
const ENDPOINT_CACHE_MAX = 32;

const endpointCache = new Map<string, { at: number; endpoint: TspRemoteEndpoint }>();

/**
 * {@link resolveVtaTspEndpoint} with a short-lived cache.
 *
 * For the **inbound** path this is not an optimisation, it is what keeps the
 * socket moving. An inbound TSP frame is awaited by the transport before it
 * acks (R1.6) and before it takes the next frame, so whatever happens per
 * frame is serial on the one socket that also carries replies. Resolving a DID
 * there costs up to two network round-trips *each*, and a redelivery burst —
 * guaranteed on the first connect after a client starts acking a backlog it
 * had never acked — turns that into hundreds of serial fetches while an
 * in-flight request waits behind them. A TSP reply timeout is a hard failure
 * with no fallback, so the request does not degrade, it fails.
 *
 * Caching collapses a burst from one resolution per frame to one per peer.
 *
 * Deliberately TTL'd rather than invalidated on failure: eviction would need
 * the unpack result plumbed back through a resolver that cannot see it, and
 * redelivery already provides the retry. A rotation costs at most `TTL` of
 * refusals for a frame that is being redelivered anyway.
 */
export function resolveVtaTspEndpointCached(vid: string): Promise<TspRemoteEndpoint> {
  return resolveTspEndpointCachedWith(vid, resolveVtaTspEndpoint);
}

/**
 * The caching half of {@link resolveVtaTspEndpointCached}, over an injected
 * resolver.
 *
 * Split out so the cache policy is testable as itself. The obvious
 * alternative — a test that re-implements the TTL and the bound and asserts
 * against its own copy — passes whatever the real policy does, which is the
 * one thing a cache test must not do.
 */
export async function resolveTspEndpointCachedWith(
  vid: string,
  resolve: (vid: string) => Promise<TspRemoteEndpoint>,
  now: () => number = Date.now,
): Promise<TspRemoteEndpoint> {
  const hit = endpointCache.get(vid);
  if (hit && now() - hit.at < ENDPOINT_TTL_MS) return hit.endpoint;

  const endpoint = await resolve(vid);
  endpointCache.set(vid, { at: now(), endpoint });
  if (endpointCache.size > ENDPOINT_CACHE_MAX) {
    // Oldest insertion first — Map preserves it, and a wallet's peer set is
    // small enough that the eviction policy barely matters; the bound is what
    // matters.
    const oldest = endpointCache.keys().next().value;
    if (oldest !== undefined) endpointCache.delete(oldest);
  }
  return endpoint;
}

/** The reuse window, exported so a test states the policy's own number rather
 *  than a copy of it. */
export const TSP_ENDPOINT_TTL_MS = ENDPOINT_TTL_MS;

/** Drop cached endpoints. For tests, and for a caller that knows a peer's keys
 *  have moved and does not want to wait out the TTL. */
export function clearTspEndpointCache(vid?: string): void {
  if (vid === undefined) endpointCache.clear();
  else endpointCache.delete(vid);
}
