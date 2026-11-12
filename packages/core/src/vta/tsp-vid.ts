// TSP VID resolution — turn a DID into the raw key material `TspChannel`
// needs: the VTA's X25519 key-agreement public key (HPKE recipient) and its
// Ed25519 public key (outer-signature verification).
//
// TSP VIDs are DIDs, so this reuses the plugin's DID resolver. The X25519 key
// is the DID's key-agreement VM (same one DIDComm authcrypts to). The Ed25519
// key is the DID's `authentication` key: a TSP VID's keys are the DID's
// existing "Ed25519 (auth) + X25519 (keyAgreement)" pair
// (verifiable-trust-infrastructure `docs/05-design-notes/tsp-enablement.md`,
// D5), and the VTA's operational key — the one it signs as itself with — is
// the key it lists there (VTI-KEY-106).
//
// The key is read through `did/vm-key.ts`, by relationship: never "any Ed25519
// key" in `verificationMethod[]`, never by a fragment suffix, and failing
// closed on a method it cannot read. A did:webs with key roles (VTI-KEY-173)
// lists a different Ed25519 key under `assertionMethod` (attestation) than
// under `authentication` (operational), so a fallback would verify TSP frames
// against the wrong key.

import { base58 } from "@scure/base";

import { ED25519, publicKeyOf, selectKey } from "../did/vm-key.js";
import { resolveDidDocument, resolveKeyAgreement } from "../didcomm/index.js";
import { base64urlToBytes } from "../util/base64url.js";
import { VtaClientError } from "./errors.js";
import type { TspRemoteEndpoint } from "./tsp-channel.js";

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

/** Extract the raw 32-byte public key of an OKP **public** JWK, checking the
 *  curve. A JWK carrying `d` is refused: a public key's place is no place for
 *  a secret. */
export function rawFromOkpJwk(
  jwk: { kty?: string; crv?: string; x?: string; d?: string },
  expectedCrv: "X25519" | "Ed25519",
): Uint8Array {
  if (jwk.kty !== "OKP" || jwk.crv !== expectedCrv || !jwk.x) {
    throw new VtaClientError(
      "e.client.parse",
      `tsp-vid: expected OKP ${expectedCrv} JWK, got kty=${jwk.kty} crv=${jwk.crv}`,
    );
  }
  if (jwk.d !== undefined) {
    throw new VtaClientError("e.client.parse", `tsp-vid: the ${expectedCrv} JWK carries private key material`);
  }
  const raw = base64urlToBytes(jwk.x);
  if (raw.length !== 32) {
    throw new VtaClientError("e.client.parse", `tsp-vid: ${expectedCrv} key is ${raw.length} bytes, want 32`);
  }
  return raw;
}

/** The raw 32-byte Ed25519 public key of a DID-document verification method:
 *  a `Multikey` / `Ed25519VerificationKey2020` (`publicKeyMultibase`) or a
 *  `JsonWebKey` / `JsonWebKey2020` (`publicKeyJwk`). Fails closed on a missing
 *  or unknown `type`, an encoding the type does not carry, a revoked method, a
 *  JWK with `d`, or any curve but Ed25519. */
export function ed25519FromVerificationMethod(vm: unknown): Uint8Array {
  let key;
  try {
    key = publicKeyOf(vm);
  } catch (e) {
    throw new VtaClientError("e.client.parse", `tsp-vid: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (key.crv !== ED25519) {
    throw new VtaClientError("e.client.parse", `tsp-vid: the verification method is ${key.crv}, not Ed25519`);
  }
  return key.publicKey;
}

/** The VID's Ed25519 signing key: the first readable Ed25519 key its DID
 *  document lists under `authentication`. Nothing else is a substitute. */
function findEd25519(vid: string, doc: unknown): Uint8Array {
  try {
    return selectKey(doc, vid, "authentication", { curves: [ED25519], label: "tsp-vid" }).publicKey;
  } catch (e) {
    throw new VtaClientError("e.client.parse", e instanceof Error ? e.message : String(e));
  }
}

// Minimal DID-document shape we read; the key reading itself is `vm-key`'s.
type DidDocument = Record<string, unknown>;

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
    signingPublicKey: findEd25519(vid, didDocument),
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
