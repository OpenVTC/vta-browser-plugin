/// <reference types="chrome" />

// The Mediator Lens's side of the runtime bridge.
//
// A `TrustTaskSender` bound to one (relay, agent) pair, so the typed helpers in
// `@openvtc/pnm-core/mediator` — and `auditList` / `configShow` from the admin
// subpath, which the mediator serves under the same URIs a VTA does — can be
// pointed at a mediator unchanged. The carrier rule is `sender.ts`'s: only
// `type` and `payload` cross; the offscreen document mints and signs.

import type { SendOpts, TrustTask, TrustTaskSender } from "@openvtc/pnm-core";
import {
  MEDIATOR_MONITOR_PORT,
  RUNTIME_MEDIATOR,
  type MediatorOp,
  type MediatorOpResult,
  type MonitorMessage,
  type MonitorOpen,
  type RuntimeMediatorResponse,
} from "../bridge-protocol.js";
import { sendToBackground } from "../send-message.js";
import { carrierParams, interpretOutcome, RelayTaskError } from "./carrier.js";

/** Run one lens operation, throwing a coded {@link RelayTaskError} on refusal. */
export async function mediatorOp<R extends MediatorOpResult>(op: MediatorOp): Promise<R> {
  const reply = await sendToBackground<RuntimeMediatorResponse>({ type: RUNTIME_MEDIATOR, op });
  if (!reply.ok) throw new RelayTaskError(op.kind, reply.error, reply);
  return reply.result as R;
}

export class MediatorTaskSender implements TrustTaskSender {
  constructor(
    readonly mediatorDid: string,
    readonly vtaDid: string,
  ) {}

  async send<Res>(envelope: TrustTask<unknown>, opts?: SendOpts): Promise<Res> {
    const reply = await sendToBackground<RuntimeMediatorResponse>({
      type: RUNTIME_MEDIATOR,
      op: {
        kind: "task",
        mediatorDid: this.mediatorDid,
        vtaDid: this.vtaDid,
        params: carrierParams(envelope),
      },
    });
    return interpretOutcome<Res>(
      envelope.type,
      opts?.operationLabel ?? envelope.type,
      reply as Parameters<typeof interpretOutcome>[2],
    );
  }
}

/** Longer than two of the mediator's 30-second heartbeats. */
const QUIET_MS = 75_000;

/**
 * Open a live traffic feed. The feed lives as long as the returned `close` is
 * not called and the tab stays open; the offscreen document holds the
 * subscription and releases it when this port goes away.
 */
export function openMonitorPort(
  open: Omit<MonitorOpen, "kind">,
  onMessage: (m: MonitorMessage) => void,
): () => void {
  const port = chrome.runtime.connect({ name: MEDIATOR_MONITOR_PORT });
  let closed = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    if (quiet) clearTimeout(quiet);
    onMessage({ kind: "ended", reason });
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
  };
  // A port's disconnect reaches this page only when EVERY other end has
  // closed, and the service worker holds one too — so an offscreen document
  // torn down mid-feed can leave this port open and silent. The mediator sends
  // a heartbeat every 30 s, so a feed quiet for much longer than that has ended
  // whether or not anyone said so.
  const arm = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => end("the feed went quiet — nothing, not even a heartbeat, for 75 s"), QUIET_MS);
  };
  port.onMessage.addListener((m) => {
    const msg = m as MonitorMessage;
    if (closed) return;
    if (msg.kind === "ended") {
      closed = true;
      if (quiet) clearTimeout(quiet);
      onMessage(msg);
      return;
    }
    arm();
    onMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    // `lastError` is read so Chrome does not log it as unchecked.
    void chrome.runtime.lastError;
    end("the feed disconnected");
  });
  port.postMessage({ kind: "open", ...open } satisfies MonitorOpen);
  arm();
  return () => {
    if (closed) return;
    closed = true;
    if (quiet) clearTimeout(quiet);
    port.disconnect();
  };
}
