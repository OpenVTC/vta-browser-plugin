// did:peer:2 (numalgo 2) generation for the wallet's holder identity.
//
// Unlike `did:key`, a `did:peer:2` can encode a service endpoint inline, so
// the wallet can advertise its mediator and be *reachable* for inbound
// DIDComm (RP-initiated confirm/approve requests) — see the RP→wallet
// trigger design. The DID is self-contained and resolves with no network.
//
// Segment order is FIXED — keyAgreement (`E`, X25519) first, authentication
// (`V`, Ed25519) second, service (`S`) last — because resolvers number
// verification methods **positionally** (`#key-1`, `#key-2`, …) in the order
// segments appear. Verified against the affinidi `DIDCacheClient` (the RP's
// resolver): for `did:peer:2.E….V….S…` it emits `#key-1` = the X25519 KA
// key and `#key-2` = the Ed25519 auth key, as `Multikey`/`publicKeyMultibase`.
// So the SIOP `id_token` `kid` is `<did>#key-2` and the authcrypt
// keyAgreement kid is `<did>#key-1`.

import { base64url, multibase } from "@openvtc/vti-didcomm-js";

const X25519_PUB = multibase.MULTICODEC.X25519_PUB;
const ED25519_PUB = multibase.MULTICODEC.ED25519_PUB;

/** Abbreviated DIDComm service for a `did:peer:2` `S` segment. The
 *  abbreviation (`t`/`s`/`r`/`a`) is the did:peer:2 convention the resolver
 *  decodes back to a `DIDCommMessaging` service. */
export interface DidPeerService {
  /** Service type. `"dm"` abbreviates `DIDCommMessaging` (the default). */
  type?: string;
  /** serviceEndpoint URI — for mediator-routed delivery this is the
   *  mediator's DID. */
  serviceEndpoint: string;
  /** Optional routing keys. */
  routingKeys?: string[];
  /** Accepted profiles (default `["didcomm/v2"]`). */
  accept?: string[];
}

export interface DidPeer2 {
  /** The full `did:peer:2` string. */
  did: string;
  /** Ed25519 authentication VM id — `<did>#key-2`. The SIOP `id_token` `kid`. */
  authKid: string;
  /** X25519 keyAgreement VM id — `<did>#key-1`. Used for DIDComm authcrypt. */
  keyAgreementKid: string;
}

export interface CreateDidPeer2Args {
  /** Ed25519 public key (authentication / signing). */
  ed25519PublicKey: Uint8Array;
  /** X25519 public key (keyAgreement / authcrypt). */
  x25519PublicKey: Uint8Array;
  /** Optional DIDComm service to advertise (e.g. the wallet's mediator). */
  service?: DidPeerService;
}

/**
 * Build a `did:peer:2` from an Ed25519 (auth) + X25519 (keyAgreement) key
 * pair and an optional DIDComm service. Returns the DID plus the
 * deterministic VM ids (`#key-1` = keyAgreement, `#key-2` = authentication).
 */
export function createDidPeer2(args: CreateDidPeer2Args): DidPeer2 {
  // E (keyAgreement, X25519) first → #key-1; V (authentication, Ed25519)
  // second → #key-2. Order is load-bearing (positional VM numbering).
  const kaMultibase = multibase.encodeMultikey(X25519_PUB, args.x25519PublicKey);
  const authMultibase = multibase.encodeMultikey(ED25519_PUB, args.ed25519PublicKey);

  let did = `did:peer:2.E${kaMultibase}.V${authMultibase}`;

  if (args.service) {
    const s = args.service;
    // Abbreviated DIDComm service; key insertion order t,s,r,a matches the
    // did:peer:2 convention. `r` omitted when there are no routing keys.
    const abbreviated: Record<string, unknown> = {
      t: s.type ?? "dm",
      s: s.serviceEndpoint,
      ...(s.routingKeys && s.routingKeys.length > 0 ? { r: s.routingKeys } : {}),
      a: s.accept ?? ["didcomm/v2"],
    };
    const encoded = base64url.encode(new TextEncoder().encode(JSON.stringify(abbreviated)));
    did += `.S${encoded}`;
  }

  return {
    did,
    authKid: `${did}#key-2`,
    keyAgreementKid: `${did}#key-1`,
  };
}
