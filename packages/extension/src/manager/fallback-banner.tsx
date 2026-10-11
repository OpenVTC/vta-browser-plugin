// Says so when the wallet has stopped using this agent's mediator.
//
// The browser notification is the alert; this is the standing explanation for
// whoever is looking at the console, which is where the failures it explains
// showed up. It reads the same health snapshot the Transports pane draws, so
// the two cannot disagree, and polls because a fallback happens while the
// console is open. See `mediator-fallback.ts`.

import { Note } from "../ui.js";
import { useTransportHealth } from "../use-transport-health.js";
import { sittingOutTransports } from "../mediator-fallback.js";

const POLL_MS = 10_000;

export function FallbackBanner({ agentDid }: { agentDid: string }) {
  const { health } = useTransportHealth(agentDid, POLL_MS);
  const sitting = sittingOutTransports(health);
  if (sitting.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <Note tone="warn">
        Your agent stopped replying through its mediator ({sitting.join(" and ")}), so the
        wallet is using REST for now and will try the mediator again in a few minutes. Approval
        requests from this agent come through the same mediator and may not reach you until
        its connection is fixed.
      </Note>
    </div>
  );
}
