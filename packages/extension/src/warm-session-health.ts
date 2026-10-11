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

/** How long a replaced connection stays open for the requests already on it:
 *  the longest reply wait (30 s) plus slack for the reply in transit. */
export const RETIRE_GRACE_MS = 35_000;

/** The parts of a `MediatorConnection` retiring one touches. */
export interface RetirableConnection extends ConnectionLiveness {
  close(): void;
}

/**
 * Close a connection the pool has stopped handing out, without breaking the
 * requests already using it.
 *
 * The pool replaces a connection the moment `isReusable` says no, but another
 * request may have been handed it a moment earlier and still be sending or
 * awaiting its reply. Closing it at once failed that request with
 * `mediator-transport: not connected` — and when the local clock runs ahead of
 * the mediator's, every connection reads expired on arrival, so concurrent
 * requests closed each other's sockets and the console could not load at all.
 *
 * A socket that is no longer open is closed now, because nothing on it can
 * succeed. An open one is closed after the grace period. A request that does
 * go into a dead-but-open socket fails on its own reply timeout, as it would
 * have anyway.
 */
export function retireConnection(
  conn: RetirableConnection,
  opts: {
    graceMs?: number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
  } = {},
): void {
  if (!conn.isOpen) {
    conn.close();
    return;
  }
  const set = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  set(() => conn.close(), opts.graceMs ?? RETIRE_GRACE_MS);
}

/**
 * Whether a connection that just closed has already been replaced in its pool.
 *
 * The mediator keeps one live socket per DID: when a second one authenticates
 * as the same holder it closes the first ("Duplicate WebSocket connection:
 * closing old session in favour of new one"). So replacing a pooled connection
 * — `retireConnection`, which deliberately leaves the old one open — gets the
 * old one closed by the far side, and its `onClose` fires as an unexpected
 * drop.
 *
 * If that handler acted on it, it deleted the *replacement's* pool entry, which
 * is keyed on the pair rather than on the connection, and scheduled a
 * reconnect. The reconnect found the pool empty, opened a third socket, the
 * mediator closed the second, whose `onClose` did the same — a self-sustaining
 * duel every couple of seconds, logged by the mediator as "Something is running
 * more than one live session for this DID". Replies addressed to the holder
 * went to whichever socket was newest, and the request waiting on another one
 * timed out. Seen in the field at gt-vta, 2026-10-11, starting at a token
 * expiry and restarting on the next replacement.
 *
 * `self` is read lazily: the entry resolves only once the connection has been
 * returned, which is when the caller has a name for it. An entry that failed
 * means nobody holds the pair, so the close is not superseded.
 */
export async function isSuperseded<T>(
  entry: Promise<T> | undefined,
  self: () => T | undefined,
): Promise<boolean> {
  if (!entry) return false;
  const current = await entry.catch(() => undefined);
  return current !== undefined && current !== self();
}
