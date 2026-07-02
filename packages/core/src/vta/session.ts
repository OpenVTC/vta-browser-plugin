// Layer 3 — the transport-agnostic VTA session.
//
// Holds an ordered set of TrustTaskChannels (priority TSP > DIDComm > REST)
// and routes every Trust-Task request over the highest-priority channel that
// can carry it. Domain ops (vault/*, acl/*, passkey/*, …) call `session.send`
// and never learn which transport answered.
//
// Fallback is capability-driven, not error-driven: a channel is skipped when
// its `supports(taskType)` returns false, or when it raises the explicit
// `e.client.unsupported` signal. We deliberately do NOT fall back on a generic
// `trust-task-error` (e.g. a malformed-request reject) — retrying a genuinely
// bad request on another transport would be wrong, and for mutating tasks
// unsafe without server-side idempotency on the envelope id. Once TSP lands
// and the VTA advertises per-task capability, `supports` does the selection up
// front and this stays a no-surprise single hop in the common case.

import type { SendOpts, TrustTaskChannel, TrustTaskChannelKind } from "./channel.js";
import { VtaClientError } from "./errors.js";
import type { TrustTask } from "./protocol.js";

/** Selection order when a VTA advertises more than one transport. */
export const CHANNEL_PRIORITY: readonly TrustTaskChannelKind[] = ["tsp", "didcomm", "rest"];

/** Sort channels by {@link CHANNEL_PRIORITY} (TSP first, REST last). Stable for
 *  channels of the same kind. */
export function orderChannelsByPriority(channels: TrustTaskChannel[]): TrustTaskChannel[] {
  return [...channels].sort(
    (a, b) => CHANNEL_PRIORITY.indexOf(a.kind) - CHANNEL_PRIORITY.indexOf(b.kind),
  );
}

/**
 * A ready VTA session: an ordered channel chain plus the routing logic that
 * picks a channel per request and degrades to the next when the top one can't
 * carry a task. Construct it with whatever channels the app could build for a
 * VTA (a live DIDComm channel, a REST channel, later a TSP channel) — the
 * session orders them and hides the choice.
 */
export class VtaSession {
  private readonly channels: TrustTaskChannel[];

  constructor(channels: TrustTaskChannel[]) {
    if (channels.length === 0) {
      throw new VtaClientError(
        "e.client.unsupported",
        "VtaSession requires at least one channel",
      );
    }
    this.channels = orderChannelsByPriority(channels);
  }

  /** The transport that will handle a request with no capability constraints —
   *  the highest-priority channel. For diagnostics / UI ("connected via TSP"). */
  get primaryKind(): TrustTaskChannelKind {
    return this.channels[0]!.kind;
  }

  /** The ordered transport kinds in this session. */
  get kinds(): TrustTaskChannelKind[] {
    return this.channels.map((c) => c.kind);
  }

  /**
   * Route a Trust-Task request over the first channel that can carry it,
   * returning the decoded response payload. Throws the underlying
   * `VtaClientError` — a channel-level failure that isn't an explicit
   * "unsupported" does NOT trigger fallback.
   */
  async send<Res>(envelope: TrustTask<unknown>, opts?: SendOpts): Promise<Res> {
    const candidates = this.channels.filter(
      (c) => !c.supports || c.supports(envelope.type),
    );
    if (candidates.length === 0) {
      throw new VtaClientError(
        "e.client.unsupported",
        `no channel routes trust task ${envelope.type}`,
      );
    }

    let lastUnsupported: VtaClientError | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const channel = candidates[i]!;
      try {
        return await channel.send<Res>(envelope, opts);
      } catch (err) {
        // Only an explicit "this channel doesn't carry this task" degrades to
        // the next candidate; anything else (auth, reject, network) is real.
        const isLast = i === candidates.length - 1;
        if (
          err instanceof VtaClientError &&
          err.code === "e.client.unsupported" &&
          !isLast
        ) {
          lastUnsupported = err;
          continue;
        }
        throw err;
      }
    }

    // Unreachable in practice (the last iteration always throws or returns),
    // but keeps the type checker honest and preserves the last signal.
    throw (
      lastUnsupported ??
      new VtaClientError(
        "e.client.unsupported",
        `no channel routes trust task ${envelope.type}`,
      )
    );
  }

  /** Release every channel's live transport (mediator pickup, TSP session).
   *  REST channels are stateless and no-op. */
  async close(): Promise<void> {
    for (const channel of this.channels) {
      await channel.close?.();
    }
  }
}
