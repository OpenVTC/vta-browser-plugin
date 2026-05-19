import { Identity, unpackMessage, type PublicJwk } from "../didcomm/index.js";
import type { RemoteDidcommEndpoint } from "./didcomm.js";
import { VtaClientError } from "./errors.js";
import { PickupProtocol } from "./pickup.js";
import type { DidcommMessageBridge } from "./transport.js";

/**
 * Extract zero or more inner DIDComm message strings from a single
 * WebSocket frame. The simplest case (`RawDispatcher`) passes the
 * frame straight through. A `Pickup3Dispatcher` would unpack the
 * frame as a `pickup/3.0/delivery` envelope and return its
 * attachments.
 *
 * Returning multiple strings is supported because a single pickup
 * delivery can carry batched messages.
 */
export interface MessageDispatcher {
  extract(frame: string): Promise<string[]> | string[];
}

/**
 * Pass-through dispatcher. Use against mediators that deliver each
 * inner JWE as its own WebSocket frame (the simplest live-mode
 * pattern). For Pickup 3.0 mediators, swap in a Pickup 3.0
 * dispatcher.
 */
export class RawDispatcher implements MessageDispatcher {
  extract(frame: string): string[] {
    return [frame];
  }
}

export interface Pickup3DispatcherOptions {
  holder: Identity;
  mediator: Pick<RemoteDidcommEndpoint, "did" | "keyAgreementPublicJwk">;
}

interface DeliveryAttachmentShape {
  id?: string;
  data?: { json?: unknown };
}

interface PickupMessageShape {
  type?: string;
  from?: string;
  attachments?: DeliveryAttachmentShape[];
}

/**
 * `pickup/3.0/delivery`-aware dispatcher.
 *
 * For each WebSocket frame:
 * 1. Parse the JWE protected header for `skid`. If the sender DID
 *    isn't the configured mediator, pass the frame through
 *    unchanged — the bridge's standard peek handles it.
 * 2. Otherwise unpack as authcrypt mediator → holder. If the
 *    decoded message's `type` is `pickup/3.0/delivery`, return each
 *    `attachments[].data.json` as an inner JWE string. The bridge
 *    then re-peeks each inner JWE with its own sender registry to
 *    find the right pending thid (typically the VTA's reply).
 * 3. Anything else from the mediator (status, status-request reply,
 *    etc.) passes through so the bridge's normal thid demuxer can
 *    route it to the awaiting MediatorClient request.
 *
 * Failure modes (malformed delivery, sender-auth failure) are
 * silent here — the bridge's `console.warn` for dropped frames
 * provides operator visibility.
 */
export class Pickup3Dispatcher implements MessageDispatcher {
  private readonly holder: Identity;
  private readonly mediator: Pickup3DispatcherOptions["mediator"];

  constructor(opts: Pickup3DispatcherOptions) {
    this.holder = opts.holder;
    this.mediator = opts.mediator;
  }

  extract(frame: string): string[] {
    const skid = readJweSenderKid(frame);
    if (!skid || didFromKid(skid) !== this.mediator.did) return [frame];

    let msg: PickupMessageShape;
    try {
      const result = unpackMessage(
        { input: frame, sender_public_jwk: this.mediator.keyAgreementPublicJwk },
        this.holder,
      );
      if (result.kind !== "encrypted" || !result.authenticated) return [frame];
      msg = result.message as PickupMessageShape;
    } catch {
      return [frame];
    }

    if (msg.type !== PickupProtocol.delivery) return [frame];
    if (msg.from !== this.mediator.did) return [frame];

    const out: string[] = [];
    for (const att of msg.attachments ?? []) {
      const json = att.data?.json;
      if (json === undefined) continue;
      out.push(typeof json === "string" ? json : JSON.stringify(json));
    }
    return out;
  }
}

/**
 * Minimal WebSocket-like surface we depend on. The browser's
 * `WebSocket` global satisfies it; Node 22+ has the same global.
 * Tests can inject any duck-typed implementation.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: "open", handler: () => void): void;
  addEventListener(event: "message", handler: (e: { data: unknown }) => void): void;
  addEventListener(event: "close", handler: () => void): void;
  addEventListener(event: "error", handler: () => void): void;
  readyState: number;
  // 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WebSocketDidcommBridgeOptions {
  /** Mediator WebSocket URL (`wss://…`). */
  url: string;
  /** Holder identity used to unpack every inner JWE. */
  holder: Identity;
  /**
   * Public JWKs of every expected counterparty, keyed by their DID
   * (no `#fragment`). When peeking an inbound JWE, the bridge parses
   * the protected header's `skid` to resolve which sender's JWK to
   * use for ECDH-1PU decryption. Senders not in the map fall back
   * to anoncrypt unpack (no sender authentication).
   *
   * Components that share a bridge (e.g. DidcommVtaTransport +
   * MediatorClient) should each register their counterparty here or
   * via `addExpectedSender()`.
   */
  expectedSenders?: Record<string, PublicJwk>;
  /** How to extract inner JWEs from each WebSocket frame. */
  dispatcher?: MessageDispatcher;
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket`. Tests
   * inject a fake.
   */
  webSocketFactory?: WebSocketFactory;
  /** Handler for delivered messages with no matching thid (unsolicited inbox). */
  onInbox?: (msg: { type: string; thid?: string; body: unknown }) => void;
  /** Per-request timeout (ms). Default 30s. */
  timeoutMs?: number;
}

/**
 * Parse a JWE protected-header `skid` (sender kid) without
 * decrypting. The protected header is base64url-encoded JSON; `skid`
 * is set for authcrypt (ECDH-1PU) and absent for anoncrypt
 * (ECDH-ES).
 *
 * Exported for tests; production callers should rely on the
 * bridge's automatic resolution.
 */
export function readJweSenderKid(jwe: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(jwe);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const protectedB64 = (parsed as { protected?: unknown }).protected;
    if (typeof protectedB64 !== "string") return undefined;
    const headerJson = atob(
      protectedB64.replaceAll("-", "+").replaceAll("_", "/"),
    );
    const header: unknown = JSON.parse(headerJson);
    if (typeof header !== "object" || header === null) return undefined;
    const skid = (header as { skid?: unknown }).skid;
    return typeof skid === "string" ? skid : undefined;
  } catch {
    return undefined;
  }
}

/** Strip the `#fragment` from a DID URL to get the bare DID. */
export function didFromKid(kid: string): string {
  const hash = kid.indexOf("#");
  return hash === -1 ? kid : kid.slice(0, hash);
}

interface Pending {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Concrete `DidcommMessageBridge` over a WebSocket mediator. Holds
 * one connection, multiplexes concurrent request/reply exchanges by
 * DIDComm `thid`.
 *
 * Connection lifecycle: lazy — the WebSocket is opened on the first
 * `sendAndAwaitReply`. Subsequent sends reuse the connection until
 * `close()` is called or the socket drops. Reconnection is not
 * automatic — callers detect `e.client.network` errors and rebuild.
 *
 * Frame demultiplexing: each frame is handed to the configured
 * `MessageDispatcher`. Each extracted string is unpacked with the
 * holder identity; if the result is a JWE message with a `thid`
 * matching a pending request, the waiting promise resolves with
 * that inner JWE string (callers re-unpack with their expected
 * sender JWK for type-aware validation). Otherwise the message is
 * delivered to `onInbox` if set, or logged via `console.warn`.
 */
export class WebSocketDidcommBridge implements DidcommMessageBridge {
  private readonly url: string;
  private readonly holder: Identity;
  private readonly senders = new Map<string, PublicJwk>();
  private readonly dispatcher: MessageDispatcher;
  private readonly factory: WebSocketFactory;
  private readonly onInbox?: (msg: {
    type: string;
    thid?: string;
    body: unknown;
  }) => void;
  private readonly defaultTimeoutMs: number;

  private socket: WebSocketLike | null = null;
  private openPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: WebSocketDidcommBridgeOptions) {
    this.url = opts.url;
    this.holder = opts.holder;
    if (opts.expectedSenders) {
      for (const [did, jwk] of Object.entries(opts.expectedSenders)) {
        this.senders.set(did, jwk);
      }
    }
    this.dispatcher = opts.dispatcher ?? new RawDispatcher();
    this.factory =
      opts.webSocketFactory ??
      ((url: string) => new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));
    if (opts.onInbox !== undefined) this.onInbox = opts.onInbox;
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Register an expected counterparty after construction. Returns
   * the bridge so callers can chain
   * (`new WebSocketDidcommBridge(...).addExpectedSender(...)`).
   */
  addExpectedSender(senderDid: string, jwk: PublicJwk): this {
    this.senders.set(senderDid, jwk);
    return this;
  }

  /** Resolve the JWK we should use to decrypt the given JWE, by
   *  parsing the protected header for `skid` and looking up the DID. */
  private resolveSenderJwk(jwe: string): PublicJwk | undefined {
    const skid = readJweSenderKid(jwe);
    if (!skid) return undefined;
    return this.senders.get(didFromKid(skid));
  }

  async sendAndAwaitReply(
    outerPackedJwe: string,
    expectThreadId: string,
    options?: { timeoutMs?: number },
  ): Promise<string> {
    await this.ensureOpen();
    const socket = this.socket;
    if (!socket) throw new VtaClientError("e.client.network", "socket unavailable");

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(expectThreadId);
        reject(
          new VtaClientError(
            "e.client.network",
            `timed out waiting for thid ${expectThreadId} after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(expectThreadId, { resolve, reject, timer });
    });

    try {
      socket.send(outerPackedJwe);
    } catch (err) {
      const p = this.pending.get(expectThreadId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(expectThreadId);
      }
      throw new VtaClientError("e.client.network", (err as Error).message);
    }

    return reply;
  }

  async send(outerPackedJwe: string): Promise<void> {
    await this.ensureOpen();
    const socket = this.socket;
    if (!socket) throw new VtaClientError("e.client.network", "socket unavailable");
    try {
      socket.send(outerPackedJwe);
    } catch (err) {
      throw new VtaClientError("e.client.network", (err as Error).message);
    }
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.openPromise = null;
    for (const [thid, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(new VtaClientError("e.client.network", "bridge closed"));
      this.pending.delete(thid);
    }
  }

  private ensureOpen(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = this.factory(this.url);
      } catch (err) {
        reject(new VtaClientError("e.client.network", (err as Error).message));
        return;
      }
      this.socket = socket;

      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new VtaClientError("e.client.network", "websocket error")),
      );
      socket.addEventListener("close", () => {
        this.socket = null;
        this.openPromise = null;
        for (const [thid, p] of this.pending.entries()) {
          clearTimeout(p.timer);
          p.reject(new VtaClientError("e.client.network", "socket closed mid-request"));
          this.pending.delete(thid);
        }
      });
      socket.addEventListener("message", (e: { data: unknown }) => {
        void this.handleFrame(typeof e.data === "string" ? e.data : String(e.data));
      });
    });
    return this.openPromise;
  }

  private async handleFrame(frame: string): Promise<void> {
    let extracted: string[];
    try {
      extracted = await this.dispatcher.extract(frame);
    } catch (err) {
      console.warn("[pnm/ws-bridge] dispatcher.extract failed:", err);
      return;
    }

    for (const innerJwe of extracted) {
      this.routeOne(innerJwe);
    }
  }

  private peekMessage(
    innerJwe: string,
  ): { type?: string; thid?: string; body?: unknown } | undefined {
    const senderJwk = this.resolveSenderJwk(innerJwe);
    try {
      const result = unpackMessage(
        {
          input: innerJwe,
          ...(senderJwk !== undefined ? { sender_public_jwk: senderJwk } : {}),
        },
        this.holder,
      );
      return result.message as { type?: string; thid?: string; body?: unknown };
    } catch (err) {
      console.warn("[pnm/ws-bridge] unable to peek inner JWE:", err);
      return undefined;
    }
  }

  private routeOne(innerJwe: string): void {
    // Peek the JWE once, here, to read the `thid` and (for the
    // inbox fallback) the `type` + `body`. Callers of
    // sendAndAwaitReply re-unpack with their own expected sender
    // JWK for proper authentication; this peek is purely for
    // routing. Trade-off: an extra HPKE decrypt per inbound
    // message. Acceptable at expected wallet rates.
    const msg = this.peekMessage(innerJwe);
    const thid = msg?.thid;

    if (thid !== undefined) {
      const pending = this.pending.get(thid);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(thid);
        pending.resolve(innerJwe);
        return;
      }
    }

    if (this.onInbox && msg) {
      this.onInbox({
        type: msg.type ?? "(unknown)",
        ...(msg.thid !== undefined ? { thid: msg.thid } : {}),
        body: msg.body,
      });
      return;
    }

    console.warn(
      `[pnm/ws-bridge] dropped delivery: no pending thid${thid ? ` (${thid})` : ""} and no inbox handler`,
    );
  }
}
