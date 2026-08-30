/// <reference types="chrome" />

// What the wallet's transports are actually doing, for the screens that say so.
//
// One hook rather than a per-screen effect, for the same reason `transports.ts`
// is one module: three surfaces name the active transport, and a screen that
// resolved it differently from the others would be wrong somewhere. The
// selection rule stays in `transports.ts`; this only fetches the evidence it
// takes.
//
// An empty result is the honest default and the common one — nothing is
// observed until a session has been built. Callers pass it straight to
// `activeTransport`, which then falls back to what the agent advertises.

import { useEffect, useState } from "react";
import {
  RUNTIME_TRANSPORT_HEALTH,
  type InboxSessionView,
  type RuntimeTransportHealthResponse,
} from "./bridge-protocol.js";
import type { TransportHealth } from "./transports.js";

export interface TransportDiagnostics {
  health: TransportHealth;
  /** Every warm mediator session the offscreen document holds. */
  sessions: InboxSessionView[];
}

const EMPTY: TransportDiagnostics = { health: {}, sessions: [] };

/**
 * Transport observations for `vtaDid`.
 *
 * Failure is deliberately silent: the fallback is the advertised-transport
 * answer the UI gave before this existed, which is a reasonable guess, and an
 * error banner because a diagnostic lookup failed would be noise about noise.
 *
 * @param vtaDid the VTA whose session health to report. Undefined (no
 *   connection yet) yields an empty result.
 */
export function useTransportHealth(vtaDid: string | undefined): TransportDiagnostics {
  const [state, setState] = useState<TransportDiagnostics>(EMPTY);

  useEffect(() => {
    if (!vtaDid) {
      setState(EMPTY);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: RUNTIME_TRANSPORT_HEALTH,
        })) as RuntimeTransportHealthResponse | undefined;
        if (!live) return;
        setState(
          res?.ok
            ? {
                health: res.result.byVta[vtaDid] ?? {},
                sessions: res.result.sessions.filter((s) => s.vtaDid === vtaDid),
              }
            : EMPTY,
        );
      } catch {
        if (live) setState(EMPTY);
      }
    })();
    return () => {
      live = false;
    };
  }, [vtaDid]);

  return state;
}
