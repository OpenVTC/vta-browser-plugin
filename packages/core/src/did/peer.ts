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
  /** Service type. `"dm"` abbreviates `DIDCommMessaging` (the default).
   *
   *  **Spell a non-DIDComm type out in full.** The abbreviation table is not
   *  shared: `affinidi-did-common`'s peer resolver expands `"tsp"` to
   *  `TSPTransport`, `vti-didcomm-js`'s expands only `"dm"` and passes
   *  everything else through verbatim. So `"tsp"` resolves to two different
   *  service types depending on which side reads the DID — while
   *  `"TSPTransport"` is preserved verbatim by both and means the same thing
   *  everywhere. */
  type?: string;
  /** serviceEndpoint URI — for mediator-routed delivery this is the
   *  mediator's DID. */
  serviceEndpoint: string;
  /** Optional routing keys. */
  routingKeys?: string[];
  /** Accepted profiles. Defaults to `["didcomm/v2"]` for a DIDComm service and
   *  is omitted otherwise — the media types are DIDComm's, and asserting them
   *  on a TSP endpoint would advertise something untrue. */
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
  /** Services to advertise, in order. Each becomes one `.S` element, and the
   *  resolved ids follow the did:peer:2 numbering (`#service`, `#service-1`,
   *  …) — which both this ecosystem's resolvers agree on.
   *
   *  More than one is how a peer says what it can *receive* — an executor has
   *  no way to know a wallet accepts TSP unless the wallet publishes it, so
   *  the negotiation a wallet performs against a VTA's services has no
   *  counterpart in the other direction until it does.
   *
   *  **Nothing in this wallet publishes a second service today.** The holder
   *  identity is minted by the VTA and adopted as a `did:key`, a method with
   *  no service endpoints, so a holder's capabilities cannot be advertised
   *  this way at all. This stays because it is the correct shape for a peer
   *  DID and is exercised by tests; it is not the live path, and a reader
   *  should not infer from it that holder capabilities are discoverable. */
  services?: DidPeerService[];
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

  for (const s of args.services ?? []) {
    const type = s.type ?? "dm";
    // One `.S` element per service rather than a single element carrying an
    // array. Both are spec-legal, but the multiple-element form is what every
    // resolver in this ecosystem indexes and numbers; the array form is the
    // less-travelled path and there is nothing to gain by taking it.
    //
    // Key insertion order t,s,r,a matches the did:peer:2 convention. `r` is
    // omitted when there are no routing keys, and `a` when the service is not
    // DIDComm — see `accept` above.
    const isDidcomm = type === "dm" || type === "DIDCommMessaging";
    const accept = s.accept ?? (isDidcomm ? ["didcomm/v2"] : undefined);
    const abbreviated: Record<string, unknown> = {
      t: type,
      s: s.serviceEndpoint,
      ...(s.routingKeys && s.routingKeys.length > 0 ? { r: s.routingKeys } : {}),
      ...(accept ? { a: accept } : {}),
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
