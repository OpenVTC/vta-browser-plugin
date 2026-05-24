// Lightweight phase timing for the auth flows, so the demo can show how long
// each step takes. Marks are wall-clock deltas (ms) between successive
// `mark()` calls; `total()` is elapsed since creation.

export interface TimingMark {
  label: string;
  ms: number;
}

export interface Stopwatch {
  /** Record a phase: ms elapsed since the previous mark (or creation). */
  mark(label: string): void;
  /** The recorded phase marks, in order. */
  readonly marks: TimingMark[];
  /** Total ms elapsed since the stopwatch was created. */
  total(): number;
}

export function createStopwatch(): Stopwatch {
  const t0 = Date.now();
  let last = t0;
  const marks: TimingMark[] = [];
  return {
    marks,
    mark(label: string) {
      const now = Date.now();
      marks.push({ label, ms: now - last });
      last = now;
    },
    total() {
      return Date.now() - t0;
    },
  };
}
