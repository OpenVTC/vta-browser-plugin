import {
  Identity,
  packAuthcrypt,
  unpackMessage,
  type PublicJwk,
} from "../didcomm/index.js";
import type { DidcommMessageBridge } from "./transport.js";

/** Reply contract a fake-VTA handler returns to the bridge. */
export interface InMemoryHandlerReply {
  type: string;
  body: unknown;
}

export type InMemoryHandler = (request: {
  type: string;
  from?: string;
  body: unknown;
  id: string;
}) => Promise<InMemoryHandlerReply> | InMemoryHandlerReply;

export interface InMemoryDidcommBridgeOptions {
  /** Fake VTA identity (used to unpack inner authcrypt + sign reply). */
  vta: Identity;
  /** Sender public JWK so VTA can authenticate inner authcrypt. */
  holderPublicJwk: { kid: string; jwk: PublicJwk };
  /**
   * Optional mediator identity. When set, the bridge first unpacks
   * the outer anoncrypt as the mediator and expects a
   * `routing/2.0/forward` envelope; the inner JWE is taken from
   * `attachments[0].data.json`. When omitted, the outer envelope is
   * treated as the inner authcrypt directly (mediator-less path).
   */
  mediator?: Identity;
  /** Per-message-type handlers; missing type → throws. */
  handlers: Record<string, InMemoryHandler>;
}

interface ForwardEnvelope {
  type: string;
  body: { next?: string };
  attachments?: Array<{ data?: { json?: unknown } }>;
}

interface InnerRequest {
  id?: string;
  type?: string;
  from?: string;
  body?: unknown;
}

/**
 * Deterministic, single-process simulator for the DIDComm send path.
 * Used to exercise `DidcommVtaTransport` end-to-end without standing
 * up a real mediator / VTA. The bridge plays both the mediator and
 * the responding VTA in sequence, then returns the reply JWE as if
 * it had arrived through the holder's mediator inbox.
 *
 * Not for production. Useful in tests and in `npm run dev:pwa` for
 * manually validating the protocol surface.
 */
export class InMemoryDidcommBridge implements DidcommMessageBridge {
  private readonly vta: Identity;
  private readonly mediator?: Identity;
  private readonly holderPublicJwk: { kid: string; jwk: PublicJwk };
  private readonly handlers: Record<string, InMemoryHandler>;

  constructor(opts: InMemoryDidcommBridgeOptions) {
    this.vta = opts.vta;
    if (opts.mediator !== undefined) this.mediator = opts.mediator;
    this.holderPublicJwk = opts.holderPublicJwk;
    this.handlers = opts.handlers;
  }

  async sendAndAwaitReply(
    outerPackedJwe: string,
    _expectThreadId: string,
    _options?: { timeoutMs?: number },
  ): Promise<string> {
    const innerJwe = this.mediator
      ? this.extractInnerViaMediator(outerPackedJwe)
      : outerPackedJwe;

    const inner = unpackMessage(
      { input: innerJwe, sender_public_jwk: this.holderPublicJwk.jwk },
      this.vta,
    );
    if (inner.kind !== "encrypted") {
      throw new Error(`bridge: expected encrypted inner, got ${inner.kind}`);
    }
    if (!inner.authenticated) {
      throw new Error("bridge: inner authcrypt failed sender authentication");
    }
    const req = inner.message as unknown as InnerRequest;
    if (!req.type) throw new Error("bridge: inner message missing `type`");
    if (!req.id) throw new Error("bridge: inner message missing `id`");

    const handler = this.handlers[req.type];
    if (!handler) {
      throw new Error(`bridge: no handler for ${req.type}`);
    }
    const reply = await handler({
      type: req.type,
      ...(req.from !== undefined ? { from: req.from } : {}),
      body: req.body ?? {},
      id: req.id,
    });

    if (!req.from) {
      throw new Error("bridge: inner message missing `from` (cannot reply)");
    }
    const replyJwe = packAuthcrypt(
      {
        type: reply.type,
        from: this.vta.did,
        to: [req.from],
        body: reply.body,
        thid: req.id,
      },
      this.vta,
      [this.holderPublicJwk],
    );
    return replyJwe;
  }

  private extractInnerViaMediator(outer: string): string {
    if (!this.mediator) throw new Error("unreachable");
    const mediatorView = unpackMessage({ input: outer }, this.mediator);
    if (mediatorView.kind !== "encrypted") {
      throw new Error(
        `bridge: expected outer anoncrypt, got ${mediatorView.kind}`,
      );
    }
    const env = mediatorView.message as unknown as ForwardEnvelope;
    if (env.type !== "https://didcomm.org/routing/2.0/forward") {
      throw new Error(`bridge: outer not a forward envelope (${env.type})`);
    }
    const innerJson = env.attachments?.[0]?.data?.json;
    if (innerJson === undefined) {
      throw new Error("bridge: forward envelope missing inner attachment");
    }
    return typeof innerJson === "string" ? innerJson : JSON.stringify(innerJson);
  }
}
