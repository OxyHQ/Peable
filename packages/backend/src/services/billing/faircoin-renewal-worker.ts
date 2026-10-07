import type { Database } from '../../db/postgres';
import { createPostgresFaircoinRenewalRepository, listPendingFaircoinRenewals } from '../../db/billing/faircoinRenewalRepository';
import { createFaircoinRenewalConsumer, type FaircoinRenewalExecutor } from './faircoin-renewal-consumer';
import { faircoinRenewalNamespace, type FaircoinRenewalActor } from './faircoin-renewal';

export async function consumeFaircoinRenewalPass(options: { db: Database; actors: readonly FaircoinRenewalActor[]; executor: FaircoinRenewalExecutor; now?: () => Date; limit?: number; cursors?: Map<string, number> }) {
  const consumer = createFaircoinRenewalConsumer({ repository: createPostgresFaircoinRenewalRepository(options.db), executor: options.executor, now: options.now });
  let consumed = 0;
  for (const actor of options.actors) {
    const namespace = faircoinRenewalNamespace(actor);
    const batch = await listPendingFaircoinRenewals(options.db, actor, options.limit, options.cursors?.get(namespace) ?? 0);
    options.cursors?.set(namespace, batch.length ? (options.cursors.get(namespace) ?? 0) + batch.length : 0);
    for (const instruction of batch) {
      try { await consumer.consume(actor, instruction); consumed++; }
      catch { process.emitWarning('Peable renewal instruction failed; durable state will retry'); }
    }
  }
  return consumed;
}
/** Opt-in only. Stop awaits the active pass; never release a dispatch barrier
 * while an executor call can still submit work. No default financial executor. */
export function startFaircoinRenewalWorker(options: Parameters<typeof consumeFaircoinRenewalPass>[0], worker: { intervalMs?: number; pass?: typeof consumeFaircoinRenewalPass; onError?: () => void } = {}) {
  const interval = worker.intervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('Invalid renewal interval');
  const scopedOptions = { ...options, cursors: options.cursors ?? new Map<string, number>() };
  let stopped = false; let pending: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = (worker.pass ?? consumeFaircoinRenewalPass)(scopedOptions).catch(() => {
      if (worker.onError) worker.onError(); else process.emitWarning('Peable renewal pass failed; durable instructions will retry');
    }).finally(() => { pending = undefined; });
  }, interval);
  timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
