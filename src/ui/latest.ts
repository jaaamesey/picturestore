/**
 * Runs an expensive async job for the latest request only: at most one run
 * per `interval` ms and never two at once, so requests made meanwhile
 * collapse into the latest. Runs are sequential, so results are delivered
 * in order and the last is always for the latest request; a result is shown
 * even if newer requests are waiting (it's still newer than what's shown,
 * and continuous input keeps updating). The first request runs at once.
 */
export function createLatest<A, R>(job: (args: A) => Promise<R>, deliver: (result: R) => void, interval = 200) {
  let wanted: { args: A } | null = null;
  let running = false;
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const pump = () => {
    timer = null;
    if (running || !wanted || disposed) return;
    const wait = last + interval - performance.now();
    if (wait > 0) {
      timer = setTimeout(pump, wait);
      return;
    }
    const { args } = wanted;
    wanted = null;
    running = true;
    last = performance.now();
    job(args)
      .then((r) => {
        if (!disposed) deliver(r);
      })
      .catch((err: unknown) => console.warn("Preview failed:", err))
      .finally(() => {
        running = false;
        pump();
      });
  };

  return {
    request(args: A) {
      wanted = { args };
      if (!timer) pump();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
