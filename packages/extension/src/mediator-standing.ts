// Which mediators the console may operate, and as whom.
//
// The Mediator Lens runs `messaging/*` tasks over a session the wallet already
// holds with a mediator, authenticated as one agent's holder. The rule here is
// that the console can only look through a session the wallet opened **for its
// own traffic** — an agent's inbox, or a relay the wallet dials to reach that
// agent. It can never point the device at a new mediator.
//
// That is not caution for its own sake. Authenticating to a mediator is not
// free of side effects: many create an account for any DID that completes the
// handshake, so "just look at this other relay" would register this holder
// somewhere it had never been, and the mediator would record it. The console is
// driven by an extension page, and an XSS there must not be able to choose
// where the device establishes itself.
//
// Free of relative imports so it can be unit-tested in plain Node.

export interface RelayPair {
  mediatorDid: string;
  vtaDid: string;
}

export interface KnownSessions {
  /** `settings.inboxes`: agent → the relay it pushes to this wallet through. */
  inboxes: Record<string, { did: string } | undefined>;
  /** Every (relay, agent) pair the wallet has opened a session for. */
  pooled: readonly RelayPair[];
}

export type StandingDecision =
  | { ok: true; isInbox: boolean }
  | { ok: false; code: "mediator/no-standing"; reason: string };

/** Whether the console may operate `pair`'s mediator, as that agent's holder. */
export function mayOperateMediator(pair: RelayPair, known: KnownSessions): StandingDecision {
  const inbox = known.inboxes[pair.vtaDid]?.did;
  if (inbox === pair.mediatorDid) return { ok: true, isInbox: true };
  if (known.pooled.some((p) => p.mediatorDid === pair.mediatorDid && p.vtaDid === pair.vtaDid)) {
    return { ok: true, isInbox: false };
  }
  return {
    ok: false,
    code: "mediator/no-standing",
    reason:
      `this wallet holds no session with ${pair.mediatorDid} for that agent. ` +
      `The lens only looks through a relay the wallet already uses — it never ` +
      `signs in somewhere new.`,
  };
}

/**
 * Every pair the console may open, inbox first. A relay that is both an inbox
 * and pooled appears once, as an inbox.
 */
export function knownRelays(
  known: KnownSessions,
  stateOf: (pair: RelayPair) => "connecting" | "live" | "closed" | undefined,
): Array<RelayPair & { isInbox: boolean; state: "connecting" | "live" | "closed" }> {
  const out = new Map<string, RelayPair & { isInbox: boolean; state: "connecting" | "live" | "closed" }>();
  const key = (p: RelayPair) => `${p.mediatorDid}|${p.vtaDid}`;
  for (const [vtaDid, rec] of Object.entries(known.inboxes)) {
    if (!rec?.did) continue;
    const pair = { mediatorDid: rec.did, vtaDid };
    out.set(key(pair), { ...pair, isInbox: true, state: stateOf(pair) ?? "closed" });
  }
  for (const p of known.pooled) {
    if (out.has(key(p))) continue;
    out.set(key(p), { ...p, isInbox: false, state: stateOf(p) ?? "closed" });
  }
  return [...out.values()].sort((a, b) => Number(b.isInbox) - Number(a.isInbox));
}

/**
 * The task types the lens may run.
 *
 * An allow-list, enforced in the offscreen document, on top of the mediator's
 * own authorisation. Two things are deliberately absent. `config/patch` and
 * `config/reload` change a running mediator and need `rootAdmin` — a standing
 * this design never grants to a browser-held key, so the console shows
 * configuration read-only and says where to change it. `messaging/message/get`
 * returns a stored envelope; the wallet can decrypt only its own mail, and its
 * own mail already arrives through the inbox.
 */
export const LENS_TASK_TYPES: readonly string[] = [
  "https://trusttasks.org/spec/messaging/stats/show/0.1",
  "https://trusttasks.org/spec/messaging/queue/list/0.1",
  "https://trusttasks.org/spec/messaging/queue/status/0.1",
  "https://trusttasks.org/spec/messaging/queue/purge/0.1",
  "https://trusttasks.org/spec/messaging/account/get/0.1",
  "https://trusttasks.org/spec/messaging/account/list/0.1",
  "https://trusttasks.org/spec/messaging/account/update/0.1",
  "https://trusttasks.org/spec/messaging/message/list/0.1",
  "https://trusttasks.org/spec/messaging/message/delete/0.1",
  "https://trusttasks.org/spec/audit/list/0.1",
  "https://trusttasks.org/spec/config/show/0.1",
];

export function isLensTask(type: string): boolean {
  return LENS_TASK_TYPES.includes(type);
}
