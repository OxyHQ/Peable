/**
 * The wallet's init queue (N-1, R6-7, R7-9): a real mutex. Every task waits
 * for the one before it, whoever calls; a failed task does not poison the
 * ones after it (its caller still sees the rejection).
 *
 * It is NOT re-entrant, on purpose. The previous queue ran a call inline
 * whenever any task was in flight, meant for a task's own nested call — but
 * it could not tell that from a call made from outside (a focus re-run,
 * "Check again"), so two legacy moves ran at once on one scratch file. A
 * task that needs another step of the same work calls that step's body
 * directly (`initializeHeld` in `wallet-store.ts`), never the queued entry.
 */
export function createInitQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const run = (): Promise<void> => task();
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}
