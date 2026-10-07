import { relayRecurringObservations } from './recurringDelivery';

/** Recovery polls the durable outbox; concurrent processes claim with SKIP LOCKED.
 * A failed pass remains pending for the next tick. No webhook is sent here. */
export function startRecurringRelay(
  options: Parameters<typeof relayRecurringObservations>[0],
  worker: { intervalMs?: number; pass?: typeof relayRecurringObservations; onError?: () => void } = {},
): () => void {
  if (options.enabled !== true) return () => {};
  const intervalMs = worker.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid recurring relay interval');
  let isRunning = false;
  let isStopped = false;
  const pass = worker.pass ?? relayRecurringObservations;
  const timer = setInterval(() => {
    if (isRunning || isStopped) return;
    isRunning = true;
    void pass(options).catch(() => {
      // Provider/merchant data and delivery URLs never appear in diagnostics.
      if (worker.onError) worker.onError();
      else process.emitWarning('Peable recurring relay pass failed; pending rows will retry');
    }).finally(() => { isRunning = false; });
  }, intervalMs);
  timer.unref?.();
  return () => { isStopped = true; clearInterval(timer); };
}
