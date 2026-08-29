// The TSP TrustTaskChannel.
//
// Carries a canonical Trust-Task envelope over TSP (Trust Spanning Protocol),
// the highest-preference transport (TSP > DIDComm > REST). Like DIDComm, TSP is
// sender-authenticated by its envelope, so this channel needs no bearer.
//
// Wire binding (confirmed against the VTA's `tsp_inbound.rs`): the TSP message
// plaintext is the Trust-Task envelope JSON — byte-identical to the REST
// `/trust-tasks` body and the DIDComm message body — with NO extra binding
// wrapper. The VTA seals its framework response document back to the proven
// sender VID over TSP; we unpack it and decode with the shared
// `parseTrustTaskReply`.
//
// pack/unpack + CESR framing + HPKE-Auth live in `@openvtc/vti-tsp-js` (proven
// byte-compatible with affinidi-tsp, the crate the VTA links). This class owns
// only the trust-task binding + transport dispatch; the actual send/receive of
// packed bytes is an injected `TspTransport` (mediator-backed in production, a
// simulator in tests).

import { pack, unpack } from "@openvtc/vti-tsp-js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

import type { TspFrameClaim } from "../didcomm/index.js";
import type { NotifyOpts, SendOpts, TrustTaskChannel } from "./channel.js";
import { VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";
import { parseTrustTaskReply, signOutboundTask } from "./trust-task.js";
import type { SigningIdentity } from "../siop/self-issued.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** The wallet's TSP identity — its VID plus the raw keys `pack`/`unpack` need.
 *  All keys are raw 32-byte (X25519 / Ed25519). */
export interface TspHolderIdentity {
  /** The holder's VID (a DID). Becomes the TSP `sender`. */
  vid: string;
  /** Ed25519 private key — signs the outer TSP signature. */
  signingPrivateKey: Uint8Array;
  /** X25519 private key — HPKE-Auth sender authentication + decrypts replies. */
  encryptionPrivateKey: Uint8Array;
  /** X25519 public key — the VTA verifies our sender-auth against this. */
  encryptionPublicKey: Uint8Array;
}

/**
 * Derive the holder's {@link TspHolderIdentity} from its Ed25519 root secret —
 * the single key material `loadHolder` unwraps. The X25519 encryption keys are
 * the Montgomery form of the Ed25519 secret, exactly as the holder's
 * `did:peer:2` keyAgreement key is minted (see `store/holder-identity.ts`
 * `buildHolder`), so the VTA verifies our TSP sender-auth against the same key
 * it resolves from our DID.
 *
 * @param did The holder's VID (its `did:peer`).
 * @param edSecret The raw 32-byte Ed25519 private key (`SigningIdentity.privateKey`).
 */
export function tspHolderIdentityFromSecret(did: string, edSecret: Uint8Array): TspHolderIdentity {
  const encryptionPrivateKey = ed25519.utils.toMontgomerySecret(edSecret);
  const encryptionPublicKey = x25519.getPublicKey(encryptionPrivateKey);
  return {
    vid: did,
    signingPrivateKey: edSecret,
    encryptionPrivateKey,
    encryptionPublicKey,
  };
}

/** The VTA's TSP endpoint — its VID plus the public keys to seal to / verify. */
export interface TspRemoteEndpoint {
  /** The VTA's VID (a DID). The TSP `receiver`, and the expected reply sender. */
  vid: string;
  /** X25519 public key — HPKE recipient (seal to) + sender-auth verify on reply. */
  encryptionPublicKey: Uint8Array;
  /** Ed25519 public key — verifies the VTA's outer signature on the reply. */
  signingPublicKey: Uint8Array;
}

/**
 * Send/receive plumbing for packed TSP messages. Implementations push the
 * packed bytes to the VTA (in production over the shared mediator websocket —
 * the VTA reads TSP off the same socket as DIDComm) and surface the packed
 * reply bytes. Keeping this injected makes `TspChannel` transport-pure and
 * directly testable with a simulator.
 */
export interface TspTransport {
  /** Send a packed TSP message and await the packed reply.
   *
   *  `claims` decides which inbound frame *is* the reply. The transport shares
   *  one socket with the wallet's inbox, so frames it did not ask for — a
   *  `task-consent` push, a step-up request — arrive on it too; without a
   *  predicate the next frame would be handed to the next waiter and a push
   *  parsed as somebody's answer. Only this layer can tell them apart, because
   *  only it holds the keys. */
  sendAndAwaitReply(
    packed: Uint8Array,
    options?: { timeoutMs?: number; claims?: TspFrameClaim },
  ): Promise<Uint8Array>;
  /**
   * Send a packed TSP message without awaiting a reply, for tasks that define
   * no response document.
   *
   * **Optional.** A transport that cannot do this must not have
   * `sendAndAwaitReply` used in its place: that would block on a reply the
   * counterparty is entitled never to send. {@link TspChannel.notify} refuses
   * with `e.client.unsupported` instead, which is the code a `VtaSession`
   * treats as "try the next channel".
   */
  send?(packed: Uint8Array): Promise<void>;
  /** Release any live transport (e.g. the mediator socket). */
  close?(): Promise<void>;
}

export interface TspChannelOptions {
  transport: TspTransport;
  holder: TspHolderIdentity;
  vta: TspRemoteEndpoint;
  /**
   * Signs every outbound envelope (SPEC §7.2 item 7a). REQUIRED.
   *
   * Not served by {@link TspHolderIdentity.signingPrivateKey}, which signs the
   * **outer** TSP envelope: that is transport authentication, and item 7
   * admits no transport substitute. The proof has to be inside the document,
   * over the document, naming a `verificationMethod` a verifier can resolve —
   * which the outer signature is not and cannot become.
   */
  signing: SigningIdentity;
  /** Per-request timeout (default 30s). */
  timeoutMs?: number;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A {@link TrustTaskChannel} that dispatches Trust-Task requests over TSP.
 * `send` packs the envelope JSON as a TSP direct message to the VTA, awaits the
 * sealed reply, verifies it came from the VTA, and decodes it.
 */
export class TspChannel implements TrustTaskChannel {
  readonly kind = "tsp" as const;
  private readonly transport: TspTransport;
  private readonly holder: TspHolderIdentity;
  private readonly vta: TspRemoteEndpoint;
  private readonly signing: SigningIdentity;
  private readonly timeoutMs: number;

  constructor(opts: TspChannelOptions) {
    this.signing = opts.signing;
    this.transport = opts.transport;
    this.holder = opts.holder;
    this.vta = opts.vta;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Seal the envelope to the VTA. Shared by both directions. */
  private async packForVta(envelope: TrustTask<unknown>): Promise<Uint8Array> {
    // Both `send` and `notify` seal through here, so this is the one place the
    // proof has to be attached — before the JSON the seal is taken over.
    await signOutboundTask(envelope, this.signing);
    // TSP plaintext = the Trust-Task envelope JSON (no binding wrapper).
    const plaintext = utf8.encode(JSON.stringify(envelope));
    const packed = await pack(plaintext, this.holder.vid, this.vta.vid, {
      senderSigningKey: this.holder.signingPrivateKey,
      senderEncryptionKey: this.holder.encryptionPrivateKey,
      receiverEncryptionKey: this.vta.encryptionPublicKey,
    });
    return packed.bytes;
  }

  /**
   * `TrustTaskChannel.notify` — seal and send, with no reply awaited.
   *
   * Refuses with `e.client.unsupported` when the transport has no one-way
   * path, rather than falling back to `sendAndAwaitReply`. The fallback would
   * look like it worked and then block until the timeout on a task whose
   * counterparty owes no answer; the refusal lets a session move to a channel
   * that can carry this.
   */
  async notify(envelope: TrustTask<unknown>, opts: NotifyOpts = {}): Promise<void> {
    if (!this.transport.send) {
      throw new VtaClientError(
        "e.client.unsupported",
        `${opts.operationLabel ?? envelope.type}: this TSP transport has no one-way send`,
      );
    }
    await this.transport.send(await this.packForVta(envelope));
  }

  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    const packed = { bytes: await this.packForVta(envelope) };

    // Set by `claims` when it recognises a frame as this request's reply, so
    // the frame is unpacked once rather than again on the way out.
    let claimedDoc: { type?: string; payload?: unknown } | undefined;

    // Only a frame that (a) unpacks under the VTA keys we addressed, (b) is
    // *proven* to come from that VTA, and (c) threads to this request is our
    // reply. Anything else — most importantly an executor-initiated push
    // landing mid-request — is left for the next waiter or the inbox.
    // Why the last frame was declined, so a request that times out can say what
    // it saw instead of only that it waited. Declining silently is what turned
    // a correlation mismatch into a 30s hang with no reason anywhere — the
    // predicate has to report, because by design nothing downstream can.
    let lastDecline: string | undefined;

    const claims: TspFrameClaim = async (bytes) => {
      let reply;
      try {
        reply = await unpack(bytes, {
          receiverDecryptionKey: this.holder.encryptionPrivateKey,
          senderEncryptionKey: this.vta.encryptionPublicKey,
          senderSigningKey: this.vta.signingPublicKey,
        });
      } catch (err) {
        // Not unpackable under these keys, so not ours. Expected on a shared
        // socket — another peer's frame — but recorded, because "nothing I can
        // read arrived" and "the VTA answered something I did not expect" are
        // very different problems and they look identical from the timeout.
        lastDecline = `unpack failed: ${(err as Error).message}`;
        return false;
      }
      if (reply.sender !== this.vta.vid) {
        lastDecline = `sealed by ${reply.sender}, not the VTA ${this.vta.vid}`;
        return false;
      }
      let doc: { type?: string; id?: unknown; payload?: unknown; threadId?: unknown };
      try {
        doc = JSON.parse(fromUtf8.decode(reply.payload)) as typeof doc;
      } catch (err) {
        lastDecline = `payload not JSON: ${(err as Error).message}`;
        return false;
      }
      // `threadId` on a response is the request's `threadId` or, as here, its
      // `id` — the same `thid ?? id` rule DIDComm correlates on, and what the
      // framework's `respond_with` sets.
      if (doc.threadId !== envelope.id) {
        lastDecline =
          `threadId ${JSON.stringify(doc.threadId)} != request id ` +
          `${JSON.stringify(envelope.id)} (reply type ${JSON.stringify(doc.type)}, ` +
          `reply id ${JSON.stringify(doc.id)})`;
        return false;
      }
      claimedDoc = doc;
      return true;
    };

    try {
      await this.transport.sendAndAwaitReply(packed.bytes, {
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        claims,
      });
    } catch (err) {
      // A timeout here almost always means a frame *did* arrive and was
      // declined. Say which, on the error the caller actually sees: without it
      // the only evidence is a silent 30s wait, and the difference between
      // "the VTA never answered" and "it answered something I did not
      // recognise" is the whole diagnosis.
      if (lastDecline) {
        throw new VtaClientError(
          (err as VtaClientError).code ?? "e.client.network",
          `${(err as Error).message} — last inbound frame declined: ${lastDecline}`,
          { details: { lastDecline } },
        );
      }
      throw err;
    }

    // `claims` returned true, so it parsed the document; the transport cannot
    // resolve without one having claimed. Defensive only.
    const doc = claimedDoc;
    if (!doc) {
      throw new VtaClientError("e.client.parse", "tsp: reply resolved with no claimed document");
    }

    return parseTrustTaskReply<Res>(doc, {
      ...(opts.expectedResponseType !== undefined
        ? { expectedResponseType: opts.expectedResponseType }
        : {}),
      ...(opts.operationLabel !== undefined ? { operationLabel: opts.operationLabel } : {}),
    });
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}
