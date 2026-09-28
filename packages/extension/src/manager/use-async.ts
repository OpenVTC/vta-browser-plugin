// One fetch-and-reload hook for the panes.
//
// The three states are kept separate on purpose — see `table.tsx`. `data`
// stays `null` until the agent answers, so "not asked yet" and "answered with
// an empty list" are never the same value; a pane that defaulted `data` to `[]`
// would render its empty state during the first load and tell the operator they
// have no keys before anyone had asked.

import { useCallback, useEffect, useState } from "react";

export interface Async<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Run `fetcher` on mount and whenever `deps` change.
 *
 * `fetcher` must be stable or memoised by the caller; `deps` is what actually
 * drives re-fetching, and in this console it is nearly always the selected
 * context id — changing the compartment is what changes the question.
 *
 * **A new question clears the old answer; a reload keeps it.** The two look
 * alike from inside the effect and mean opposite things on screen. `reload`
 * re-asks the *same* question — after a delete, say — and blanking the list the
 * operator is reading would make the page jump for nothing. Changing `deps`
 * asks a *different* one, and holding the previous answer there drew the old
 * context's DIDs under the new context's heading until the agent replied: a
 * list that looked like a wrong answer rather than a pending one. So the state
 * is tagged with the question it answers (`run`, which changes exactly when
 * `deps` do), and a state for any other question reads as not-yet-asked during
 * the very render that changes it — not one effect later, which would still
 * paint the stale rows for a frame.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Answer<T>>({ run, data: null, error: null, loading: true });

  useEffect(() => {
    let live = true;
    setState((s) =>
      s.run === run
        ? { ...s, loading: true, error: null }
        : { run, data: null, error: null, loading: true },
    );
    void run().then(
      (value) => {
        if (!live) return;
        setState({ run, data: value, error: null, loading: false });
      },
      (e: unknown) => {
        if (!live) return;
        // The previous answer *to this question* is deliberately kept. A
        // refresh that fails should not blank a list the operator is reading —
        // the error says the data is stale, which is more useful than an empty
        // page that says nothing. An answer to a different question was
        // already dropped above, so it cannot survive here as "stale".
        const error = e instanceof Error ? e.message : String(e);
        setState((s) => ({ run, data: s.run === run ? s.data : null, error, loading: false }));
      },
    );
    return () => {
      live = false;
    };
  }, [run, nonce]);

  const current = state.run === run ? state : { data: null, error: null, loading: true };
  return {
    data: current.data,
    loading: current.loading,
    error: current.error,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}

/** What the hook holds, tagged with the question it answers. */
interface Answer<T> {
  run: () => Promise<T>;
  data: T | null;
  error: string | null;
  loading: boolean;
}
