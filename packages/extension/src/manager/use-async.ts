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
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void run().then(
      (value) => {
        if (!live) return;
        setData(value);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        // The previous answer is deliberately kept. A refresh that fails should
        // not blank a list the operator is reading — the error says the data is
        // stale, which is more useful than an empty page that says nothing.
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [run, nonce]);

  return { data, loading, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}
