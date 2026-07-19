/**
 * Re-arming exponential backoff for inbound mediator sessions (R1.5).
 *
 * A listener that stops retrying is a listener that silently misses every
 * consent request that arrives afterwards — the human check for a gated action
 * never happens and nothing reports that it didn't (R7.2). So the contract
 * here is deliberately narrow and deliberately relentless:
 *
 *   - retry forever; cap the DELAY, never the attempt count
 *   - re-arm on EVERY failure, including the first-connect case where no
 *     session ever opened (an `onClose`-driven retry cannot cover that — no
 *     open means no close)
 *   - never let two timers stack for the same key
 *   - reset to the base delay on success, so a recovered session doesn't carry
 *     a grown delay into its next outage
 *
 * `attempt` must not throw: it reports success as a boolean. A throw escaping
 * the timer callback would kill the loop, which is precisely how the previous
 * fire-and-forget `.catch(() => undefined)` retry gave up for good.
 *
 * Timer functions are injectable so the loop is testable without real waiting.
 */

export interface ReconnectTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ReconnectOptions {
  /** First retry delay, and the value reset to on success. */
  baseMs: number;
  /** Ceiling for the doubling delay. Bounds the blind window after recovery. */
  maxMs: number;
  /** Bring the session up. Must resolve `true` on success, `false` on ANY
   *  failure. Must not throw. */
  attempt: (key: string) => Promise<boolean>;
  /** Optional gate consulted before each attempt and again before re-arming.
   *  Returning false abandons the loop and clears state — used for "the
   *  operator locked this identity", which must beat a retry in flight. */
  shouldRetry?: (key: string) => boolean;
  timers?: ReconnectTimers;
}

interface Entry {
  delayMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class ReconnectScheduler {
  readonly #opts: ReconnectOptions;
  readonly #timers: ReconnectTimers;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: ReconnectOptions) {
    this.#opts = opts;
    this.#timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
    };
  }

  /** Queue a retry for `key`, or do nothing if one is already queued. */
  schedule(key: string): void {
    if (this.#opts.shouldRetry && !this.#opts.shouldRetry(key)) {
      this.clear(key);
      return;
    }
    const entry = this.#entries.get(key) ?? { delayMs: this.#opts.baseMs, timer: undefined };
    if (entry.timer) return; // already queued — never stack timers for one key
    entry.timer = this.#timers.setTimeout(() => {
      entry.timer = undefined;
      void this.#opts.attempt(key).then((ok) => {
        if (ok) {
          this.clear(key);
          return;
        }
        // A lock (or equivalent) during the attempt wins over the retry.
        if (this.#opts.shouldRetry && !this.#opts.shouldRetry(key)) {
          this.clear(key);
          return;
        }
        // Don't resurrect a backoff cancelled while this attempt was in flight
        // — `clear()` dropped the entry, and re-arming would revive a loop the
        // caller explicitly ended.
        if (this.#entries.get(key) !== entry) return;
        entry.delayMs = Math.min(entry.delayMs * 2, this.#opts.maxMs);
        this.schedule(key);
      });
    }, entry.delayMs);
    this.#entries.set(key, entry);
  }

  /** Cancel any pending retry for `key` and reset its delay to the base. */
  clear(key: string): void {
    const entry = this.#entries.get(key);
    if (entry?.timer) this.#timers.clearTimeout(entry.timer);
    this.#entries.delete(key);
  }

  /** Cancel every pending retry. */
  clearAll(): void {
    for (const key of [...this.#entries.keys()]) this.clear(key);
  }

  /** The delay the NEXT retry for `key` would use. Test/telemetry surface. */
  pendingDelayMs(key: string): number | undefined {
    return this.#entries.get(key)?.delayMs;
  }

  /** Whether a retry is currently queued for `key`. */
  isArmed(key: string): boolean {
    return this.#entries.get(key)?.timer !== undefined;
  }
}
