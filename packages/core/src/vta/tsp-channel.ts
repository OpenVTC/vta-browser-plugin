// The TSP TrustTaskChannel.
//
// Carries a canonical Trust-Task envelope over TSP (Trust Spanning Protocol),
// the highest-preference transport (TSP > DIDComm > REST). Like DIDComm, TSP is
// sender-authenticated by its envelope, so this channel needs no bearer.
//
// Wire binding (confirmed against the VTA's `tsp_inbound.rs`): the TSP message
// plaintext is the Trust-Task envelope JSON — byte-identical to the REST
// `/api/trust-tasks` body and the DIDComm message body — with NO extra binding
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

import type { SendOpts, TrustTaskChannel } from "./channel.js";
import { VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";
import { parseTrustTaskReply } from "./trust-task.js";

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
  /** Send a packed TSP message and await the packed reply. */
  sendAndAwaitReply(packed: Uint8Array, options?: { timeoutMs?: number }): Promise<Uint8Array>;
  /** Release any live transport (e.g. the mediator socket). */
  close?(): Promise<void>;
}

export interface TspChannelOptions {
  transport: TspTransport;
  holder: TspHolderIdentity;
  vta: TspRemoteEndpoint;
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
  private readonly timeoutMs: number;

  constructor(opts: TspChannelOptions) {
    this.transport = opts.transport;
    this.holder = opts.holder;
    this.vta = opts.vta;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send<Res>(envelope: TrustTask<unknown>, opts: SendOpts = {}): Promise<Res> {
    // TSP plaintext = the Trust-Task envelope JSON (no binding wrapper).
    const plaintext = utf8.encode(JSON.stringify(envelope));

    const packed = await pack(plaintext, this.holder.vid, this.vta.vid, {
      senderSigningKey: this.holder.signingPrivateKey,
      senderEncryptionKey: this.holder.encryptionPrivateKey,
      receiverEncryptionKey: this.vta.encryptionPublicKey,
    });

    const replyBytes = await this.transport.sendAndAwaitReply(packed.bytes, {
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });

    let reply;
    try {
      reply = await unpack(replyBytes, {
        receiverDecryptionKey: this.holder.encryptionPrivateKey,
        senderEncryptionKey: this.vta.encryptionPublicKey,
        senderSigningKey: this.vta.signingPublicKey,
      });
    } catch (err) {
      throw new VtaClientError("e.client.parse", `tsp reply unpack failed: ${(err as Error).message}`);
    }

    // The reply is sealed + signed by the VTA; unpack already verified the
    // signature and sender-auth against the VTA's keys. Defence-in-depth: the
    // proven sender VID must be the VTA we addressed.
    if (reply.sender !== this.vta.vid) {
      throw new VtaClientError(
        "e.p.msg.unauthorized",
        `tsp reply from ${reply.sender} != VTA ${this.vta.vid}`,
      );
    }

    let doc: { type?: string; payload?: unknown };
    try {
      doc = JSON.parse(fromUtf8.decode(reply.payload)) as { type?: string; payload?: unknown };
    } catch (err) {
      throw new VtaClientError("e.client.parse", `tsp reply body not JSON: ${(err as Error).message}`);
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
