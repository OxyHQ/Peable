import type { RecurringObservationOptions } from './recurring/contracts';
/**
 * The drain: stored provider events become payment state.
 *
 * `ingress.ts` answers the provider in milliseconds and writes the event down.
 * This is what happens next, on this gateway's own clock rather than on
 * Stripe's. Without it the card rail charges a payer and never settles the
 * payment — the events arrive, verify, and sit in a table nobody reads.
 *
 * Shaped like `webhookOutbox` next door, with one deliberate difference: there
 * is **no lease**. The outbox makes an outbound HTTP call whose duration is not
 * bounded by anything this process controls, so two dispatchers claiming one
 * row would deliver twice. A pass here does database work only, and the
 * idempotency is structural — `applyEvent` short-circuits when the intent is
 * already at the target status, so a second processor re-running an event finds
 * the work done and marks it handled. Adding a lease would buy nothing and
 * would add a way for a killed process to hold rows.
 */
import { getDb } from '../db/postgres';
import {
  findUnprocessedProviderEvents,
  deferProviderEvents,
} from '../db/providers/providerEventRepository';
import { processProviderEvent } from './providers/eventProcessor';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 50;

export interface DrainPassOptions {
  readonly batchSize?: number;
  /** Explicit operator-approved composition only; omitted until boot opt-in. */
  readonly recurring?: RecurringObservationOptions;
  readonly now?: () => Date;
}

export interface DrainPassResult {
  readonly examined: number;
  readonly applied: number;
  /** Already at the target status — a provider redelivery. */
  readonly noop: number;
  /** An event type this drain does not act on. */
  readonly skipped: number;
  /** Names an object no intent claims. Stays for the next pass. */
  readonly unmatched: number;
  readonly failed: number;
}

/** Payment effects may already be committed when retry scheduling fails.
 * Callers must retry this pending deferral before starting another pass. */
export class ProviderEventDeferralError extends Error {
  constructor(
    readonly progress: DrainPassResult,
    readonly pendingEventIds: readonly string[],
    cause: unknown,
  ) {
    super(
      `Provider event retry scheduling failed after committed progress: examined=${progress.examined}, applied=${progress.applied}, pending=${pendingEventIds.length}`,
      { cause },
    );
    this.name = 'ProviderEventDeferralError';
  }
}

/** Retry only scheduling; completed rows are excluded by the repository write.
 * Start the backoff at retry completion time, never at the old failed attempt. */
export async function retryProviderEventDrainDeferral(
  failure: ProviderEventDeferralError,
  options: Pick<DrainPassOptions, 'now'> = {},
): Promise<void> {
  await deferProviderEvents(
    getDb(),
    failure.pendingEventIds,
    new Date((options.now ?? (() => new Date()))().getTime() + 60_000),
  );
}

/**
 * One pass over the unprocessed events, oldest first.
 *
 * Sequential rather than concurrent, and that is the point: two events about
 * one payment (`processing` then `succeeded`) arrive in order and mean
 * different things applied in the wrong one. Concurrency here would buy
 * throughput this gateway does not need and would make the ordering a race.
 */
export async function runProviderEventDrainPass(
  options: DrainPassOptions = {},
): Promise<DrainPassResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (options.recurring && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100))
    throw new Error('Invalid recurring drain batch size');
  const events = await findUnprocessedProviderEvents(
    getDb(),
    batchSize,
    options.recurring ? { dueAt: (options.now ?? (() => new Date()))() } : undefined,
  );

  const deferred: string[] = [];
  let applied = 0;
  let noop = 0;
  let skipped = 0;
  let unmatched = 0;
  let failed = 0;

  for (const event of events) {
    const outcome = await (options.recurring
      ? processProviderEvent(event, options.recurring)
      : processProviderEvent(event));
    if (options.recurring && (outcome.kind === 'failed' || outcome.kind === 'unmatched'))
      deferred.push(event.id);
    switch (outcome.kind) {
      case 'observed':
      case 'applied':
        applied += 1;
        break;
      case 'unchanged':
      case 'already_processed':
      case 'noop':
        noop += 1;
        break;
      case 'no_mapping':
        skipped += 1;
        break;
      case 'unmatched':
        unmatched += 1;
        break;
      case 'failed':
        failed += 1;
        break;
    }
  }

  const progress = { examined: events.length, applied, noop, skipped, unmatched, failed };
  if (options.recurring && deferred.length) {
    try {
      await deferProviderEvents(
        getDb(),
        deferred,
        new Date((options.now ?? (() => new Date()))().getTime() + 60_000),
      );
    } catch (cause) {
      throw new ProviderEventDeferralError(progress, [...deferred], cause);
    }
  }
  return progress;
}

let timer: ReturnType<typeof setInterval> | null = null;

export interface StartDrainOptions extends DrainPassOptions {
  readonly intervalMs?: number;
}

export function startProviderEventDrain(options: StartDrainOptions = {}): void {
  if (timer !== null) return;
  let pendingDeferral: ProviderEventDeferralError | null = null;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      if (pendingDeferral) {
        await retryProviderEventDrainDeferral(pendingDeferral, options);
        pendingDeferral = null;
      }
      await runProviderEventDrainPass(options);
    })()
      .catch((error: unknown) => {
        if (error instanceof ProviderEventDeferralError) pendingDeferral = error;
        process.emitWarning(
          `Peable provider event drain tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  // Same as the settlement watcher's and the outbox's: the loop must never be
  // the reason a process or a test run refuses to exit.
  timer.unref?.();
}

export function stopProviderEventDrain(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
