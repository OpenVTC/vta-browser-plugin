import {
  Identity,
  packAuthcrypt,
  unpackMessage,
  type PublicJwk,
} from "../didcomm/index.js";
import { readJweSenderKid } from "./bridge-websocket.js";
import type { DidcommMessageBridge } from "./transport.js";

const FORWARD_TYPE = "https://didcomm.org/routing/2.0/forward";

/** Reply contract a fake-VTA or fake-mediator handler returns to the bridge. */
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
  /** Fake VTA identity (unpacks inner authcrypt + signs replies). */
  vta?: Identity;
  /** Sender public JWK so VTA can authenticate inner authcrypt. */
  holderPublicJwk: { kid: string; jwk: PublicJwk };
  /**
   * Fake mediator identity. When set, the bridge tries to unpack
   * the outer message with the mediator first. If the result is a
   * `routing/2.0/forward` envelope, the inner JWE is extracted from
   * attachments and dispatched against `vtaHandlers`; otherwise the
   * decrypted message is dispatched against `mediatorHandlers`.
   *
   * When omitted, the outer is treated as the inner authcrypt
   * directly (VTA-only, mediator-less transport).
   */
  mediator?: Identity;
  /** Handlers for messages that reached the (fake) VTA. */
  vtaHandlers?: Record<string, InMemoryHandler>;
  /** Handlers for direct-to-mediator messages (coordinate-mediation, pickup, …). */
  mediatorHandlers?: Record<string, InMemoryHandler>;
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
 * Deterministic, single-process simulator covering two delivery
 * patterns:
 *
 * 1. **Forward-wrapped to VTA** (passkey-management): outer anoncrypt
 *    to mediator → forward envelope → inner authcrypt holder→VTA.
 *    The bridge unwraps the forward, decrypts the inner as VTA,
 *    dispatches against `vtaHandlers`, and authcrypts the reply
 *    VTA→holder.
 * 2. **Direct to mediator** (coordinate-mediation): outer authcrypt
 *    holder→mediator. The bridge decrypts as mediator, dispatches
 *    against `mediatorHandlers`, and authcrypts the reply
 *    mediator→holder.
 *
 * Pattern detection is runtime — try mediator-unpack first and
 * inspect the decoded `type`. Falls back to direct VTA-unpack if no
 * mediator is configured.
 *
 * Not for production. Drives the smokes in `./smoke.ts`.
 */
export class InMemoryDidcommBridge implements DidcommMessageBridge {
  private readonly vta?: Identity;
  private readonly mediator?: Identity;
  private readonly holderPublicJwk: { kid: string; jwk: PublicJwk };
  private readonly vtaHandlers: Record<string, InMemoryHandler>;
  private readonly mediatorHandlers: Record<string, InMemoryHandler>;

  constructor(opts: InMemoryDidcommBridgeOptions) {
    if (opts.vta !== undefined) this.vta = opts.vta;
    if (opts.mediator !== undefined) this.mediator = opts.mediator;
    this.holderPublicJwk = opts.holderPublicJwk;
    this.vtaHandlers = opts.vtaHandlers ?? {};
    this.mediatorHandlers = opts.mediatorHandlers ?? {};
  }

  async sendAndAwaitReply(
    outerPackedJwe: string,
    _expectThreadId: string,
    _options?: { timeoutMs?: number },
  ): Promise<string> {
    // ── Pattern 1 + 2: mediator configured → try mediator-unpack first
    if (this.mediator) {
      const outerIsAuthcrypt = readJweSenderKid(outerPackedJwe) !== undefined;
      const outerView = unpackMessage(
        {
          input: outerPackedJwe,
          ...(outerIsAuthcrypt
            ? { sender_public_jwk: this.holderPublicJwk.jwk }
            : {}),
        },
        this.mediator,
      );
      if (outerView.kind !== "encrypted") {
        throw new Error(
          `bridge: outer unpack returned ${outerView.kind}, expected encrypted`,
        );
      }
      const outer = outerView.message as unknown as ForwardEnvelope &
        InnerRequest;

      if (outer.type === FORWARD_TYPE) {
        return this.handleForwarded(outer);
      }
      return this.handleMediatorDirect(outer);
    }

    // ── Pattern 3: no mediator, outer IS the inner authcrypt to VTA
    return this.handleDirectVta(outerPackedJwe);
  }

  private async handleForwarded(outer: ForwardEnvelope): Promise<string> {
    if (!this.vta) {
      throw new Error("bridge: forward envelope received but no VTA identity configured");
    }
    const innerJson = outer.attachments?.[0]?.data?.json;
    if (innerJson === undefined) {
      throw new Error("bridge: forward envelope missing inner attachment");
    }
    const innerJwe =
      typeof innerJson === "string" ? innerJson : JSON.stringify(innerJson);
    return this.handleDirectVta(innerJwe);
  }

  private async handleDirectVta(innerJwe: string): Promise<string> {
    if (!this.vta) {
      throw new Error("bridge: direct-to-VTA path requires `vta` identity");
    }
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
    return this.dispatch(
      inner.message as unknown as InnerRequest,
      this.vtaHandlers,
      this.vta,
    );
  }

  private async handleMediatorDirect(decrypted: InnerRequest): Promise<string> {
    if (!this.mediator) {
      throw new Error("unreachable: mediator-direct without mediator");
    }
    return this.dispatch(decrypted, this.mediatorHandlers, this.mediator);
  }

  private async dispatch(
    req: InnerRequest,
    handlers: Record<string, InMemoryHandler>,
    replier: Identity,
  ): Promise<string> {
    if (!req.type) throw new Error("bridge: message missing `type`");
    if (!req.id) throw new Error("bridge: message missing `id`");
    if (!req.from) {
      throw new Error("bridge: message missing `from` (cannot reply)");
    }
    const handler = handlers[req.type];
    if (!handler) {
      throw new Error(`bridge: no handler for ${req.type}`);
    }
    const reply = await handler({
      type: req.type,
      from: req.from,
      body: req.body ?? {},
      id: req.id,
    });
    const replyJwe = packAuthcrypt(
      {
        type: reply.type,
        from: replier.did,
        to: [req.from],
        body: reply.body,
        thid: req.id,
      },
      replier,
      [this.holderPublicJwk],
    );
    return replyJwe;
  }
}
