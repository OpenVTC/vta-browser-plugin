// A small queue for background fetches the console starts on its own.
//
// Opening the newest records, reading room profiles and fetching thumbnails are
// all things the pane does without being asked, and started together they
// contend with each other and with what the person *did* ask for: the first row
// arrives no sooner than the last, and a click waits behind them all. A limiter
// runs a few at a time, in the order asked, so the top of the screen fills in
// first. What a person clicks does not go through one.

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency) return;
    const start = waiting.shift();
    if (start) start();
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          active++;
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        });
        next();
      });
    },
  };
}
