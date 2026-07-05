// Production TspTransport — rides the shared mediator WebSocket.
//
// This is the network plumbing behind `TspChannel` (which owns the trust-task
// binding + pack/unpack). It does NOT open its own socket: the mediator
// multiplexes TSP and DIDComm onto ONE socket per holder DID (it sniffs the
// 0xF8 magic on a binary frame → TSP, else DIDComm), so a TSP message is sent
// as a binary frame over the existing DIDComm mediator session and the sealed
// reply arrives back on that same session as a TSP frame.
//
// This mirrors the mediator's own single-socket design and sidesteps the
// one-socket-per-DID rule (ADR 0005): there is no second socket to conflict
// with the wallet's DIDComm inbox. It replaced an earlier dedicated raw-TSP
// socket that could send but never received replies — the mediator delivers a
// holder's inbound over its single live-delivery socket (the DIDComm one), so
// the dedicated socket's flush-on-connect never saw the live reply.
//
// The socket, mediator auth, TSP-frame demux (base64url(qb2) → 0xF8 bytes), and
// FIFO reply correlation all live in the shared `MediatorConnection`
// (`connectMediatorSession`). This class is just the `TspTransport` adapter:
// send binary, await the reply frame, with the transport-phase error codes
// `TspChannel`/`VtaSession` expect.

import { VtaClientError } from "./errors.js";
import type { TspTransport } from "./tsp-channel.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/** The subset of a mediator connection the TSP transport rides — the TSP
 *  send/receive surface of `MediatorConnection`. */
export interface TspCapableConnection {
  /** Send a raw TSP message (qb2 bytes) as a binary frame over the socket. */
  sendBinary(bytes: Uint8Array): void;
  /** Await the next inbound TSP frame (FIFO). Rejects on timeout. */
  awaitTspFrame(timeoutMs: number): Promise<Uint8Array>;
}

export interface MediatorSessionTspTransportOptions {
  /** The shared, already-connected mediator session (the warm DIDComm session
   *  for this holder DID). Its socket carries both DIDComm and TSP. */
  connection: TspCapableConnection;
  /** Per-request reply timeout (default 30s). */
  timeoutMs?: number;
}

/**
 * {@link TspTransport} over a shared {@link MediatorConnection}. Sends the
 * packed TSP envelope as a binary frame and awaits the sealed reply frame off
 * the same socket.
 *
 * Failure surface, by phase, is deliberate:
 * - **Send failure** (pre-send — the socket write threw, nothing reached the
 *   VTA) raises `e.client.unsupported`, so a `VtaSession` cleanly falls back to
 *   its next channel (DIDComm) without risk.
 * - **Reply timeout / socket drop** (post-send — the request may already have
 *   been applied) raises `e.client.network` and does NOT fall back: retrying a
 *   possibly-applied mutation on another transport would be unsafe.
 *
 * The socket lifecycle is owned by the warm-session pool, so this has no
 * `close()` — closing the shared session is the pool's job, not a per-op TSP
 * transport's.
 */
export class MediatorSessionTspTransport implements TspTransport {
  private readonly conn: TspCapableConnection;
  private readonly timeoutMs: number;

  constructor(opts: MediatorSessionTspTransportOptions) {
    this.conn = opts.connection;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendAndAwaitReply(
    packed: Uint8Array,
    options: { timeoutMs?: number } = {},
  ): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    // Register the reply waiter BEFORE sending (both synchronous — no frame can
    // arrive between them), per the MediatorConnection contract.
    const replyPromise = this.conn.awaitTspFrame(timeoutMs);

    try {
      this.conn.sendBinary(packed);
    } catch (err) {
      // Pre-send: the socket write failed, so nothing reached the VTA. Swallow
      // the now-orphaned waiter's eventual timeout, and signal a safe fallback.
      replyPromise.catch(() => {});
      throw new VtaClientError(
        "e.client.unsupported",
        `tsp: send failed (${(err as Error).message}) — falling back`,
      );
    }

    try {
      return await replyPromise;
    } catch (err) {
      // Post-send: timeout or socket drop. The request may already have applied
      // — hard-fail (no VtaSession fallback for a possible mutation).
      throw new VtaClientError("e.client.network", `tsp: ${(err as Error).message}`);
    }
  }
}
