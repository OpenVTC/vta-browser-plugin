import type { MediatorConnection } from "../didcomm/index.js";
import type { DidcommMessageBridge, DidcommReply } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `DidcommMessageBridge` backed by the library's authenticated
 * `MediatorSession` (via {@link connectMediatorSession}). The session
 * owns the WebSocket, mediator auth, pickup live-delivery, inbound
 * unpacking, and `thid` correlation — this class just adapts its
 * `send` / `waitFor` to the bridge contract.
 *
 * Because the session only surfaces successfully sender-authenticated
 * authcrypt frames (anoncrypt is dropped), every reply this bridge
 * returns is already authenticated; callers validate `from` / `thid` /
 * `type` on the decrypted message.
 */
export class MediatorSessionBridge implements DidcommMessageBridge {
  private readonly connection: MediatorConnection;
  private readonly defaultTimeoutMs: number;

  constructor(connection: MediatorConnection, timeoutMs?: number) {
    this.connection = connection;
    this.defaultTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendAndAwaitReply(
    outerPackedJwe: string,
    expectThreadId: string,
    options?: { timeoutMs?: number },
  ): Promise<DidcommReply> {
    // Register the waiter before sending so a fast reply can't race
    // ahead of the correlation (the session also buffers unclaimed
    // frames, but registering first is unconditionally safe).
    const reply = this.connection.waitFor(
      expectThreadId,
      options?.timeoutMs ?? this.defaultTimeoutMs,
    );
    this.connection.send(outerPackedJwe);
    return (await reply) as DidcommReply;
  }

  async send(outerPackedJwe: string): Promise<void> {
    this.connection.send(outerPackedJwe);
  }

  /** Tear down the underlying session. */
  close(): void {
    this.connection.close();
  }
}
