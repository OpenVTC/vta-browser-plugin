// DIDComm v2 facade over `@openvtc/vti-didcomm-js`.
//
// This module is the single seam between `@pnm/core` and the
// underlying DIDComm implementation. It used to wrap a WASM crate;
// it now wraps the pure-JS `@openvtc/vti-didcomm-js` library. The
// public surface (Identity, pack*/unpack*, wrapForward, the type
// shapes) is kept stable so consumers only had to learn that the
// pack/unpack calls became async.
//
// Scope of the current library version: X25519 key agreement,
// ECDH-1PU+A256CBC-HS512 authcrypt and ECDH-ES anoncrypt, single
// recipient per envelope. The type surface intentionally stays
// broader than that (OKP|EC, X25519|P-256|secp256k1) because did:peer
// and P-256/secp256k1 support are landing in the library — when they
// do, this facade needs no change since it only forwards JWKs to the
// library's curve-dispatching pack/unpack.

import {
  pack as vtiPack,
  packAnoncrypt as vtiPackAnoncrypt,
  unpack as vtiUnpack,
  buildForward as vtiBuildForward,
  resolveX25519KeyAgreement as vtiResolveKeyAgreement,
  resolveMediator as vtiResolveMediator,
  resolve as vtiResolve,
  authenticateToMediator as vtiAuthenticateToMediator,
  MediatorSession as VtiMediatorSession,
  x25519,
  jwk as vtiJwk,
} from "@openvtc/vti-didcomm-js";

export type DidcommCurve = "X25519" | "P-256" | "secp256k1";

/** Plaintext message inputs. `id` is auto-generated as a v4 UUID when omitted. */
export interface PlaintextMessageInput {
  id?: string;
  type: string;
  from?: string;
  to?: string[];
  body: unknown;
  thid?: string;
}

/** A recipient for `packAuthcrypt` / `packAnoncrypt`. */
export interface DidcommRecipient {
  kid: string;
  jwk: PublicJwk;
}

/** Public key-agreement JWK shape. */
export interface PublicJwk {
  kty: "OKP" | "EC";
  crv: "X25519" | "P-256" | "secp256k1";
  x: string;
  y?: string;
}

/** Secret key-agreement JWK shape (must include `d`). */
export interface SecretJwk extends PublicJwk {
  d: string;
}

// Private key material is held off the Identity instance so it never
// appears on the public shape and can be dropped on `dispose()`.
interface IdentitySecret {
  kid: string;
  privateJwk: SecretJwk;
}
const SECRETS = new WeakMap<Identity, IdentitySecret>();

function requireSecret(id: Identity): IdentitySecret {
  const secret = SECRETS.get(id);
  if (!secret) {
    throw new Error("Identity has been disposed");
  }
  return secret;
}

/**
 * A DIDComm key-agreement identity: a DID, the verification-method
 * `kid` to advertise on the wire, and the X25519 secret used to
 * authcrypt/decrypt. Replaces the former WASM `Identity` class with a
 * pure-JS equivalent. `dispose()` drops the private material; the raw
 * base64url strings can't be reliably zeroized in JS, so this is a
 * best-effort release rather than a wipe.
 */
export class Identity {
  readonly did: string;
  readonly kid: string;

  private constructor(did: string, kid: string, privateJwk: SecretJwk) {
    this.did = did;
    this.kid = kid;
    SECRETS.set(this, { kid, privateJwk });
  }

  /** Mint a fresh X25519 identity for `did`. The `kid` defaults to
   *  `<did>#key-1`; callers that need a canonical key id reconstruct
   *  via `fromSecretJwk` once they've computed it. */
  static generate(did: string): Identity {
    const { privateKey, publicKey } = x25519.generateKeyPair();
    const priv = vtiJwk.privateJwk("X25519", privateKey, publicKey);
    return new Identity(did, `${did}#key-1`, {
      kty: "OKP",
      crv: "X25519",
      x: priv.x,
      d: priv.d as string,
    });
  }

  /** Reconstruct a persisted identity. */
  static fromSecretJwk(input: {
    did: string;
    kid: string;
    jwk: SecretJwk;
  }): Identity {
    if (!input.jwk.d) {
      throw new TypeError("Identity.fromSecretJwk: jwk.d (private scalar) required");
    }
    return new Identity(input.did, input.kid, { ...input.jwk });
  }

  /** Public JWK + its `kid`, for handing to a counterparty as a recipient. */
  publicJwk(): { kid: string; jwk: PublicJwk } {
    const { privateJwk } = requireSecret(this);
    const pub: PublicJwk = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
    };
    if (privateJwk.y !== undefined) pub.y = privateJwk.y;
    return { kid: this.kid, jwk: pub };
  }

  /** Persistable secret form (`{ did, kid, jwk }`). */
  secretJwk(): { did: string; kid: string; jwk: SecretJwk } {
    const { privateJwk } = requireSecret(this);
    return { did: this.did, kid: this.kid, jwk: { ...privateJwk } };
  }

  /** Drop the private key material held for this identity. */
  dispose(): void {
    SECRETS.delete(this);
  }
}

export type UnpackResult =
  | {
      kind: "encrypted";
      message: Record<string, unknown>;
      authenticated: boolean;
      sender_kid?: string;
      recipient_kid: string;
    }
  | {
      kind: "signed";
      message: Record<string, unknown>;
      signer_kid?: string;
    }
  | {
      kind: "plaintext";
      message: Record<string, unknown>;
    };

function withId<T extends { id?: string }>(message: T): T & { id: string } {
  if (message.id) return message as T & { id: string };
  return { ...message, id: globalThis.crypto.randomUUID() };
}

function singleRecipient(recipients: DidcommRecipient[]): DidcommRecipient {
  const recipient = recipients[0];
  if (recipients.length !== 1 || !recipient) {
    throw new Error(
      `DIDComm facade packs to exactly one recipient, got ${recipients.length}`,
    );
  }
  return recipient;
}

/** Build a DIDComm v2 plaintext message and return its JSON form. */
export function buildPlaintextMessage(input: PlaintextMessageInput): string {
  return JSON.stringify(withId(input));
}

/** Pack as anoncrypt — no sender identity exposed. */
export function packAnoncrypt(
  message: PlaintextMessageInput,
  recipients: DidcommRecipient[],
): Promise<string> {
  const recipient = singleRecipient(recipients);
  return vtiPackAnoncrypt({
    message: withId(message),
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

/**
 * Pack an already-serialized DIDComm Message JSON as anoncrypt.
 * Use this for forward-envelope composition where the inner Message
 * has fields (attachments, custom extras) that the builder shape
 * doesn't carry.
 */
export function packAnoncryptJson(
  messageJson: string,
  recipients: DidcommRecipient[],
): Promise<string> {
  const recipient = singleRecipient(recipients);
  return vtiPackAnoncrypt({
    message: JSON.parse(messageJson),
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

/**
 * Pack an already-serialized DIDComm Message JSON as authcrypt.
 * Sibling of `packAnoncryptJson`; needed for messages whose shape
 * exceeds the builder (attachments, custom extras) **and** whose
 * sender must be authenticated to the recipient. The
 * `pickup/3.0/delivery` envelope is the primary case.
 */
export function packAuthcryptJson(
  messageJson: string,
  sender: Identity,
  recipients: DidcommRecipient[],
): Promise<string> {
  const secret = requireSecret(sender);
  const recipient = singleRecipient(recipients);
  return vtiPack({
    message: JSON.parse(messageJson),
    sender: { kid: secret.kid, privateJwk: secret.privateJwk },
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

/**
 * Wrap an already-encrypted JWE in a Routing 2.0 forward envelope
 * addressed to `mediatorDid`, with `from` set so the envelope is
 * **authcrypt**-packed to the mediator. An authenticated mediator
 * relays a forward only when it can verify the sender is the
 * authenticated client, so the forward must carry a sender — an
 * anoncrypt forward is silently dropped. Returns the plaintext forward
 * Message JSON; pair with `packAuthcryptJson(_, sender, [mediator])`.
 */
export function wrapForward(
  next: string,
  from: string,
  mediatorDid: string,
  encryptedJwe: string,
): string {
  return JSON.stringify(
    vtiBuildForward({
      next,
      from,
      mediatorDid,
      innerJwe: encryptedJwe,
    }) as Record<string, unknown>,
  );
}

/**
 * Pack as authcrypt — sender authenticated to recipients. The
 * `sender` identity's private key is used to derive the sender-bound
 * KEK; only its public material reaches the wire.
 */
export function packAuthcrypt(
  message: PlaintextMessageInput,
  sender: Identity,
  recipients: DidcommRecipient[],
): Promise<string> {
  const secret = requireSecret(sender);
  const recipient = singleRecipient(recipients);
  return vtiPack({
    message: withId(message),
    sender: { kid: secret.kid, privateJwk: secret.privateJwk },
    recipient: { kid: recipient.kid, publicJwk: recipient.jwk },
  });
}

// The library matches the recipient by an exact `kid` string against
// the JWE `recipients[]`. The former WASM impl matched by key material
// (via a secrets resolver), so a holder whose stored `kid` differed
// from the one a counterparty used to address it still decrypted.
// Preserve that: if the stored kid isn't present but there's exactly
// one recipient entry, decrypt against that entry's kid. The private
// key is the real authority — a wrong key fails AES-KW unwrap
// regardless of the kid string.
function resolveRecipientKid(jweJson: string, storedKid: string): string {
  try {
    const jwe = JSON.parse(jweJson) as {
      recipients?: Array<{ header?: { kid?: string } }>;
    };
    const entries = jwe.recipients ?? [];
    if (entries.some((e) => e?.header?.kid === storedKid)) return storedKid;
    const sole = entries.length === 1 ? entries[0]?.header?.kid : undefined;
    if (typeof sole === "string") return sole;
  } catch {
    // Fall through — let the library's unpack raise the canonical
    // parse error.
  }
  return storedKid;
}

/**
 * Auto-detect format and unpack a JWE. For authcrypt pass
 * `sender_public_jwk` so the sender binding can be verified. The
 * library only produces encrypted results, so `kind` is always
 * `"encrypted"`; the union retains the other variants for API
 * stability.
 */
export async function unpackMessage(
  args: { input: string; sender_public_jwk?: PublicJwk },
  recipient: Identity,
): Promise<UnpackResult> {
  const secret = requireSecret(recipient);
  const recipientKid = resolveRecipientKid(args.input, secret.kid);
  const result = await vtiUnpack(
    args.input,
    { kid: recipientKid, privateJwk: secret.privateJwk },
    args.sender_public_jwk ? { publicJwk: args.sender_public_jwk } : undefined,
  );
  const out: Extract<UnpackResult, { kind: "encrypted" }> = {
    kind: "encrypted",
    message: result.message as Record<string, unknown>,
    authenticated: result.authenticated,
    recipient_kid: recipientKid,
  };
  if (result.senderKid) out.sender_kid = result.senderKid;
  return out;
}

/** Identifier of the underlying DIDComm implementation. */
export function didcommCrateVersion(): string {
  return "@openvtc/vti-didcomm-js";
}

// ---------------------------------------------------------------------------
// DID resolution. did:key resolves in-tree (deterministic); did:webvh is
// fetched from its hosting service (the `did.jsonl` host named in the DID).
// These turn a DID string into the key-agreement material a DIDComm
// transport needs, so callers configure endpoints by DID rather than by
// hand-supplying keys.
// ---------------------------------------------------------------------------

function x25519PublicJwk(bytes: Uint8Array): PublicJwk {
  const okp = vtiJwk.publicJwk("X25519", bytes);
  return { kty: "OKP", crv: "X25519", x: okp.x };
}

/** A DID resolved to its X25519 key-agreement endpoint. */
export interface ResolvedKeyAgreement {
  did: string;
  keyAgreementKid: string;
  keyAgreementPublicJwk: PublicJwk;
}

/**
 * Resolve a DID to its first X25519 key-agreement verification method.
 * `kid` is the canonical verification-method id; the public JWK is the
 * X25519 key to authcrypt to. Throws if the DID has no X25519
 * key-agreement entry.
 */
export async function resolveKeyAgreement(did: string): Promise<ResolvedKeyAgreement> {
  const { kid, x25519Pub } = await vtiResolveKeyAgreement(did);
  return {
    did,
    keyAgreementKid: kid,
    keyAgreementPublicJwk: x25519PublicJwk(x25519Pub),
  };
}

/** A resolved mediator: key-agreement endpoint plus its transport URLs. */
export interface ResolvedMediatorEndpoint extends ResolvedKeyAgreement {
  /** WebSocket URL for live delivery (the bridge connects here). */
  websocketUrl: string;
  /** REST DIDCommMessaging endpoint. */
  restEndpoint: string;
  /** Mediator authentication endpoint. */
  authEndpoint: string;
}

/**
 * Resolve a mediator DID to its key-agreement material + transport
 * endpoints. Refuses plaintext (`ws://`/`http://`) endpoints unless
 * `allowInsecure` is set (local dev only) — a tampered/stale DID
 * document must not be able to downgrade the transport. Throws if the
 * mediator advertises no WebSocket endpoint, since the bridge needs one
 * for live delivery.
 */
export async function resolveMediatorEndpoint(
  mediatorDid: string,
  options: { allowInsecure?: boolean } = {},
): Promise<ResolvedMediatorEndpoint> {
  const m = await vtiResolveMediator(mediatorDid, {
    allowInsecure: options.allowInsecure ?? false,
  });
  if (!m.wsEndpoint) {
    throw new Error(
      `mediator ${mediatorDid} advertises no WebSocket endpoint for live delivery`,
    );
  }
  return {
    did: m.did,
    keyAgreementKid: m.kid,
    keyAgreementPublicJwk: x25519PublicJwk(m.x25519Pub),
    websocketUrl: m.wsEndpoint,
    restEndpoint: m.restEndpoint,
    authEndpoint: m.authEndpoint,
  };
}

/** The transports a VTA advertises in its DID document. A VTA may enable
 *  REST, DIDComm, or both (runtime service management) — onboarding resolves
 *  the DID once and uses whichever is present. */
export interface VtaServices {
  /** REST base URL from the `#vta-rest` service (`type: "VTARest"`). */
  rest?: { baseUrl: string };
  /** Mediator DID from the `#vta-didcomm` service (`type: "DIDCommMessaging"`). */
  didcomm?: { mediatorDid: string };
}

/**
 * Resolve a VTA/RP DID to its advertised transports — so a caller supplies a
 * single DID and the wallet derives the REST endpoint and/or DIDComm mediator
 * itself, rather than asking the operator for URLs. Returns whichever of
 * `#vta-rest` / `#vta-didcomm` the document carries (possibly both, possibly
 * one).
 */
export async function resolveVtaServices(did: string): Promise<VtaServices> {
  const resolution = (await vtiResolve(did, {})) as {
    didDocument?: { service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }> };
  };
  const services = resolution.didDocument?.service ?? [];
  const out: VtaServices = {};

  for (const svc of services) {
    const fragment = (svc.id ?? "").split("#")[1];

    if (fragment === "vta-rest" || svc.type === "VTARest") {
      // `#vta-rest` serviceEndpoint is a plain URL string.
      if (typeof svc.serviceEndpoint === "string") {
        out.rest = { baseUrl: svc.serviceEndpoint };
      }
    }

    if (fragment === "vta-didcomm" || svc.type === "DIDCommMessaging") {
      // `#vta-didcomm` serviceEndpoint is `[{ uri: <mediator-did>, ... }]`;
      // tolerate the object and bare-string encodings too.
      const ep = svc.serviceEndpoint;
      let mediatorDid: string | undefined;
      if (Array.isArray(ep)) mediatorDid = (ep[0] as { uri?: string } | undefined)?.uri;
      else if (ep && typeof ep === "object") mediatorDid = (ep as { uri?: string }).uri;
      else if (typeof ep === "string") mediatorDid = ep;
      // Prefer the VTA-specific fragment over a generic DIDCommMessaging entry.
      if (mediatorDid && (fragment === "vta-didcomm" || !out.didcomm)) {
        out.didcomm = { mediatorDid };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authenticated mediator session. The library's MediatorSession owns the
// whole inbound path: challenge → JWT → bearer-subprotocol WebSocket →
// pickup live-delivery → unpack → thid-correlation. We expose a connect
// helper that hands back a transport-neutral handle, so the bridge layer
// in vta/ never imports the library directly.
// ---------------------------------------------------------------------------

// The library's mediator-auth `.d.ts` is abbreviated (its `mediator`
// return omits `did`/`x25519Pub`; its args omit `allowInsecure`), though
// the runtime provides both. Re-type accurately here so the rest of the
// file stays cast-free.
interface VtiResolvedMediator {
  did: string;
  restEndpoint: string;
  wsEndpoint: string;
  authEndpoint: string;
  kid: string;
  x25519Pub: Uint8Array;
}
const authenticateToMediator = vtiAuthenticateToMediator as unknown as (args: {
  mediatorDid: string;
  clientDid: string;
  clientX25519Private: Uint8Array;
  clientX25519Public: Uint8Array;
  clientKid?: string;
  fetch?: typeof fetch;
  allowInsecure?: boolean;
}) => Promise<{ accessToken: string; mediator: VtiResolvedMediator }>;

/** WebSocket constructor compatible with the library session (the
 *  browser global `WebSocket` satisfies it). */
export type WebSocketCtor = new (
  url: string,
  protocols?: string | string[],
) => unknown;

/**
 * A live, authenticated mediator session plus the resolved endpoints
 * the DIDComm transport needs. `waitFor` resolves with the decrypted,
 * sender-authenticated reply correlated by `thid`.
 */
export interface MediatorConnection {
  send(jwe: string): void;
  waitFor(thid: string, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): void;
  /** True while the underlying WebSocket is open (live delivery active). A
   *  warm-session holder checks this before reusing a cached connection. */
  readonly isOpen: boolean;
  /** Register a handler for unsolicited inbound messages (those no `waitFor`
   *  claims) — e.g. an RP-initiated `confirm` request. The handler should
   *  filter by message `type`. Replaces any previously-registered handler. */
  onInbound(handler: (message: Record<string, unknown>, thid: string) => void): void;
  /** Resolved VTA key-agreement endpoint (inner authcrypt target). */
  vta: ResolvedKeyAgreement;
  /** Resolved mediator key-agreement endpoint (forward-envelope target). */
  mediator: ResolvedKeyAgreement;
}

export interface ConnectMediatorSessionOptions {
  /** Holder identity (its X25519 key authenticates to the mediator). */
  holder: Identity;
  /** Mediator DID — resolved + authenticated against. */
  mediatorDid: string;
  /** VTA DID — resolved so its replies unpack by skid. */
  vtaDid: string;
  /** fetch impl for the mediator auth handshake. */
  fetch?: typeof fetch;
  /** WebSocket ctor (defaults to globalThis.WebSocket). */
  webSocketImpl?: WebSocketCtor;
  /** Allow ws://, http:// endpoints. Local dev only. */
  allowInsecure?: boolean;
  /** Called once if the socket drops unexpectedly (not via `close()`).
   *  A warm-session holder uses this to evict + reconnect. */
  onClose?: () => void;
}

/**
 * Authenticate to the mediator and open a live-delivery session.
 * Resolves once the WebSocket is open and live delivery is enabled.
 * The returned handle's `send`/`waitFor` drive request/response over
 * the mediator; `close()` tears the socket down.
 */
export async function connectMediatorSession(
  opts: ConnectMediatorSessionOptions,
): Promise<MediatorConnection> {
  const secret = requireSecret(opts.holder);
  const okp = secret.privateJwk as {
    kty: "OKP";
    crv: "X25519";
    x: string;
    d: string;
  };
  const clientPrivate = vtiJwk.rawPrivate(okp);
  const clientPublic = vtiJwk.rawPublic(okp);

  const auth = await authenticateToMediator({
    mediatorDid: opts.mediatorDid,
    clientDid: opts.holder.did,
    clientX25519Private: clientPrivate,
    clientX25519Public: clientPublic,
    clientKid: opts.holder.kid,
    allowInsecure: opts.allowInsecure ?? false,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  const vta = await resolveKeyAgreement(opts.vtaDid);

  // Seed the VTA's key so its replies unpack by skid; resolve any other
  // sender on demand.
  const senderKeys = new Map<string, { publicJwk: PublicJwk }>([
    [opts.vtaDid, { publicJwk: vta.keyAgreementPublicJwk }],
  ]);

  const session = new VtiMediatorSession({
    mediator: auth.mediator,
    mediatorJwt: auth.accessToken,
    client: {
      did: opts.holder.did,
      kid: opts.holder.kid,
      privateKey: clientPrivate,
      publicKey: clientPublic,
    },
    senderKeys,
    resolveSender: async (did: string) => {
      const r = await vtiResolveKeyAgreement(did);
      return { publicJwk: x25519PublicJwk(r.x25519Pub) };
    },
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
    ...(opts.webSocketImpl ? { WebSocketImpl: opts.webSocketImpl } : {}),
  });
  await session.connect();

  const liveSession = session as unknown as { isOpen: boolean };
  return {
    send: (jwe: string) => session.send(jwe),
    waitFor: (thid: string, timeoutMs: number) =>
      session.waitFor(thid, timeoutMs) as Promise<Record<string, unknown>>,
    close: () => session.close(),
    get isOpen() {
      return liveSession.isOpen;
    },
    // The session reads `onMessage` dynamically on each inbound frame, so a
    // post-connect assignment takes effect immediately.
    onInbound: (handler) => {
      (session as unknown as { onMessage: typeof handler }).onMessage = handler;
    },
    vta,
    mediator: {
      did: auth.mediator.did,
      keyAgreementKid: auth.mediator.kid,
      keyAgreementPublicJwk: x25519PublicJwk(auth.mediator.x25519Pub),
    },
  };
}

// ---------------------------------------------------------------------------
// Smoke helper — exercises pack→unpack round-trip end-to-end. Useful
// from the PWA console to validate the crypto path works. Not for
// production use.
// ---------------------------------------------------------------------------

export interface SmokeRoundtripResult {
  ok: boolean;
  packedLength: number;
  recoveredMessageType: string | undefined;
  authenticated: boolean | undefined;
  error?: string;
}

export async function smokeAuthcryptRoundtrip(): Promise<SmokeRoundtripResult> {
  let alice: Identity | null = null;
  let bob: Identity | null = null;
  try {
    alice = Identity.generate("did:example:alice");
    bob = Identity.generate("did:example:bob");
    const bobPub = bob.publicJwk();
    const alicePub = alice.publicJwk();

    const packed = await packAuthcrypt(
      {
        type: "https://didcomm.org/basicmessage/2.0/message",
        from: alice.did,
        to: [bob.did],
        body: { content: "hello from the vti-didcomm-js smoke test" },
      },
      alice,
      [bobPub],
    );

    const out = await unpackMessage(
      { input: packed, sender_public_jwk: alicePub.jwk },
      bob,
    );
    if (out.kind !== "encrypted") {
      return {
        ok: false,
        packedLength: packed.length,
        recoveredMessageType: undefined,
        authenticated: undefined,
        error: `unexpected kind ${out.kind}`,
      };
    }
    return {
      ok: true,
      packedLength: packed.length,
      recoveredMessageType: out.message["type"] as string | undefined,
      authenticated: out.authenticated,
    };
  } catch (err) {
    return {
      ok: false,
      packedLength: 0,
      recoveredMessageType: undefined,
      authenticated: undefined,
      error: (err as Error).message,
    };
  } finally {
    alice?.dispose();
    bob?.dispose();
  }
}
