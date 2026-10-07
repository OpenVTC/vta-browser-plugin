// When a cached mediator connection can be trusted with the next request.
//
// The warm pool reused any connection whose WebSocket read `isOpen`. After a
// laptop sleeps, that is not evidence of anything. The mediator closes every
// socket when its access token expires (15 minutes by default), and a close
// frame sent to a sleeping machine never arrives. On wake the browser still
// reports the socket open, and it can take minutes to notice the TCP connection
// is gone. A request written in that window reaches nobody. TSP surfaces it as
// `timed out awaiting reply frame` 30 seconds later, and restarting the
// extension was the only cure.
//
// Seen in the field: the mediator closed the glenn-vta holder's socket at
// 06:50:43 on token expiry while the machine slept. A proxy-login sent after
// wake (07:06) never reached the VTA. The retry after a fresh connect at
// 07:07:57 succeeded.
//
// Three checks, each catching what the others miss:
//   - `isReusable`: a connection past its token expiry is dead, whatever
//     `isOpen` says. Deterministic, and it covers the case above.
//   - `startWakeWatch`: a timer that fires far later than scheduled means the
//     machine slept. Every cached connection is suspect, so drop them all,
//     including ones whose token has not yet expired but whose socket the
//     network dropped.
//   - The pool's reply-timeout hook (in offscreen): whatever the cause, a
//     connection that just lost a reply is not handed to the next request.

/** How long before the mediator's expiry a connection stops being reused. The
 *  expiry is read off the mediator's clock, so this absorbs clock skew as well
 *  as a request still in flight when the socket closes. */
export const EXPIRY_MARGIN_MS = 30_000;

/** The parts of a `MediatorConnection` the reuse decision reads. */
export interface ConnectionLiveness {
  readonly isOpen: boolean;
  readonly expiresAt: number | undefined;
}

/** True when a cached connection may carry the next request. */
export function isReusable(
  conn: ConnectionLiveness,
  nowMs: number,
  marginMs: number = EXPIRY_MARGIN_MS,
): boolean {
  if (!conn.isOpen) return false;
  if (conn.expiresAt === undefined) return true;
  return nowMs < conn.expiresAt - marginMs;
}

export const WAKE_CHECK_INTERVAL_MS = 5_000;
/** How late a tick must be to count as a sleep. Generous on purpose: a
 *  throttled background timer runs late too, and a false positive costs a
 *  reconnect, nothing more. */
export const WAKE_TOLERANCE_MS = 20_000;

export interface WakeWatchOptions {
  /** Called with how long the gap was. */
  onWake: (gapMs: number) => void;
  intervalMs?: number;
  toleranceMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Detect that the machine slept: a repeating timer whose tick arrives much
 * later than scheduled. There is no sleep or wake event an offscreen document
 * can listen for, but timers do not run while the machine sleeps, so the gap
 * is visible on the first tick after wake. Returns a stop function.
 */
export function startWakeWatch(opts: WakeWatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? WAKE_CHECK_INTERVAL_MS;
  const toleranceMs = opts.toleranceMs ?? WAKE_TOLERANCE_MS;
  const now = opts.now ?? Date.now;
  const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear =
    opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  let last = now();
  const handle = set(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (gap > intervalMs + toleranceMs) opts.onWake(gap);
  }, intervalMs);
  return () => clear(handle);
}
