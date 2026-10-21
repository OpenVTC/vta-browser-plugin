// When an agent stops answering through its mediator, use REST for a while.
//
// The field case: a wallet's socket to `fpdev-mediator` opened cleanly (101,
// handshake done), every request to `gt-vta` went out over it, and no reply
// came back. Each request waited 30 seconds and failed. The agent's REST
// endpoint was healthy the whole time, but `buildVtaSession` only skips a
// mediator channel it cannot *connect* to, and this one connected fine, so
// TSP kept winning the selection and the console could not load at all.
//
// A reply timeout is the evidence. It is not a reason to resend the request
// that timed out: that one may already have been applied at the agent, which
// is why a post-send failure hard-fails rather than falling back (R1.4). It is
// a reason not to send the *next* one the same way. So after a timeout the
// pair's mediator channels sit out for `FALLBACK_COOLDOWN_MS`, then get tried
// again, since a mediator that recovers should get its traffic back without
// anyone noticing.
//
// The fallback is announced, never silent. A wallet that quietly moved to
// REST would hide the other thing this evidence means: the agent pushes
// approval requests through the same mediator, and if replies are not getting
// through, those may not be either (R7.2).
//
// Keyed on the (agent, relay) pair, like the warm pool: one relay can be one
// agent's working inbox and another's broken outbound hop.
//
// Kept free of `chrome` so the rules are testable.

import { TRANSPORT_DIAGNOSIS } from "./transport-diagnosis.js";
import type { Transport, TransportHealth } from "./transports.js";

/** How long the mediator channels sit out after a reply timeout. */
export const FALLBACK_COOLDOWN_MS = 5 * 60_000;

/** At most one alert per agent in this window. A mediator that keeps failing
 *  re-enters the fallback every cooldown, and a notification every five
 *  minutes is noise a person learns to dismiss. */
export const NOTIFY_QUIET_MS = 30 * 60_000;

const SEP = "\u0000";

export class MediatorFallback {
  private readonly until = new Map<string, number>();
  private readonly lastNotified = new Map<string, number>();

  /** A request through `mediatorDid` to `vtaDid` got no reply. */
  noteNoReply(vtaDid: string, mediatorDid: string, now: number): void {
    this.until.set(vtaDid + SEP + mediatorDid, now + FALLBACK_COOLDOWN_MS);
  }

  /** Whether the pair's mediator channels should sit this session out. */
  isSittingOut(vtaDid: string, mediatorDid: string, now: number): boolean {
    const key = vtaDid + SEP + mediatorDid;
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.until.delete(key);
    return false;
  }

  /** Whether any of `vtaDid`'s mediator channels is sitting out at `now`.
   *  Read-only, unlike {@link isSittingOut}, so a status read cannot change
   *  what the next session build decides. */
  isAnySittingOut(vtaDid: string, now: number): boolean {
    const prefix = vtaDid + SEP;
    for (const [key, until] of this.until) {
      if (key.startsWith(prefix) && now < until) return true;
    }
    return false;
  }

  /** Whether to alert that `vtaDid` fell back now. Records the alert, so call
   *  it once per fallback actually taken. */
  claimNotification(vtaDid: string, now: number): boolean {
    const last = this.lastNotified.get(vtaDid);
    if (last !== undefined && now - last < NOTIFY_QUIET_MS) return false;
    this.lastNotified.set(vtaDid, now);
    return true;
  }
}

/** The health detail for a channel sitting out. Says what was observed. */
export function noReplyDetail(mediatorDid: string): string {
  return (
    `no reply through ${mediatorDid} within the request timeout, so requests ` +
    `go over REST for a few minutes. Approval requests from this agent come ` +
    `through the same mediator and may not be arriving either.`
  );
}

/** The notification a person sees when an agent falls back to REST. */
export function fallbackNotification(agent: string): { title: string; message: string } {
  return {
    title: "Your agent switched to REST",
    message:
      `${agent} stopped replying through its mediator, so the wallet is ` +
      `using REST instead. Approval requests from it may not reach you ` +
      `until its mediator connection is fixed.`,
  };
}

/** A short name for an agent a person can recognise: `host/path` for a
 *  `did:webvh` (its SCID means nothing to anyone) or a did:scid DID URL (the
 *  host and path its `src` names), the DID otherwise. */
export function agentLabel(did: string): string {
  const src = scidSrcLabel(did);
  if (src) return src;
  const parts = did.split(":");
  if (parts[0] === "did" && parts[1] === "webvh" && parts.length >= 4) {
    return parts.slice(3).map(decodeURIComponent).join("/");
  }
  return did;
}

/** The mediator transports that are sitting out with no reply, from a health
 *  snapshot. Empty when nothing has fallen back. Matched on the code, never
 *  the detail (R3.7). */
export function sittingOutTransports(health: TransportHealth): Transport[] {
  return (["TSP", "DIDComm"] as const).filter(
    (t) => health[t]?.state === "down" && health[t]?.code === TRANSPORT_DIAGNOSIS.noReply,
  );
}

/**
 * `health` as it stands at the moment it is read, given whether the agent is
 * still sitting out.
 *
 * A no-reply record is written by the session build that skips the mediator,
 * and nothing replaces it until a build after the cooldown tries the mediator
 * again. An agent with no request in between kept a fallback that had already
 * ended, so switching the console back to it showed the warning for an agent
 * the wallet would happily use the mediator for. Once the cooldown is over the
 * record is dropped: nothing has been observed since, which is what an absent
 * entry means.
 */
export function withExpiredFallbackDropped(
  health: TransportHealth,
  stillSittingOut: boolean,
): TransportHealth {
  if (stillSittingOut) return health;
  const out: TransportHealth = { ...health };
  for (const t of sittingOutTransports(health)) delete out[t];
  return out;
}

/** `host/path` from a did:scid DID URL's `src`, or undefined. */
export function scidSrcLabel(did: string): string | undefined {
  const match = /^did:scid:[a-z0-9]+:[0-9]+:[^?#]+\?src=([^?#&]+)$/.exec(did);
  if (!match) return undefined;
  const src = match[1]!.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  try {
    return decodeURIComponent(src) || undefined;
  } catch {
    return src || undefined;
  }
}
