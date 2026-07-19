/**
 * Bounded fetch for every outbound call (R1.2).
 *
 * A `fetch` with no timeout waits as long as the peer wants it to. Against a
 * blackholed or wedged VTA that is not "slow", it is forever: the page that
 * asked sits on a promise that never settles, and in MV3 the unresolved
 * `await` also pins the service worker awake and stacks later requests behind
 * it. Neither surfaces as an error, so nothing reports that anything is wrong.
 *
 * This module exists because the timeout has to be applied where `fetch` is
 * *injected*, not where it is *called*. Every network helper in this package
 * takes an optional `fetch` for testability and falls back to the global:
 *
 *     const f = opts.fetch ?? fetch.bind(globalThis);
 *
 * which means a literal `grep "fetch("` finds almost nothing and the real call
 * sites are spelled `f(...)`, `fetchFn(...)`, `this.fetchImpl(...)`. Wrapping
 * at the injection point covers them all, including the ones reached
 * indirectly — `getVtaBearer` runs before every REST request, so leaving it
 * unbounded would defeat a timeout applied anywhere downstream.
 */

/** Default ceiling for a single request. Matches the extension's page-facing
 *  proxy so a caller sees one consistent bound wherever the call originates. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Wrap a fetch implementation so every request it makes is bounded.
 *
 * Honours a caller-supplied `signal` by combining it with the timeout rather
 * than replacing it — dropping the caller's signal would silently disable
 * their cancellation, which is a worse bug than the one being fixed.
 */
export function withFetchTimeout(
  impl?: typeof fetch,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): typeof fetch {
  const base = impl ?? fetch.bind(globalThis);
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal;
    let signal: AbortSignal = timeout;
    if (caller) {
      // `AbortSignal.any` is Node >=20.3 / Chrome >=116. Both are inside this
      // package's supported range, but fall back rather than throw: losing the
      // combination is recoverable, losing the timeout is the bug we are here
      // to fix, so the timeout is what survives.
      signal =
        typeof AbortSignal.any === "function" ? AbortSignal.any([caller, timeout]) : timeout;
    }
    return base(input, { ...init, signal });
  };
}

/**
 * True when `err` is the abort raised by {@link withFetchTimeout}'s deadline.
 *
 * Matches on `DOMException.name`, which is the stable machine-readable
 * discriminant the platform defines — never on the message text (R3.7).
 */
export function isFetchTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}
