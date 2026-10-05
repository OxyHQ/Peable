import type {RecurringObservationOptions} from './recurring/contracts';
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
import { getDb } from "../db/postgres";
import { findUnprocessedProviderEvents } from "../db/providers/providerEventRepository";
import { processProviderEvent } from "./providers/eventProcessor";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 50;

export interface DrainPassOptions {
  readonly batchSize?: number;
  /** Explicit operator-approved composition only; server boot supplies none. */
  readonly recurring?:RecurringObservationOptions;
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
  const events = await findUnprocessedProviderEvents(
    getDb(),
    options.batchSize ?? DEFAULT_BATCH_SIZE,
  );

  let applied = 0;
  let noop = 0;
  let skipped = 0;
  let unmatched = 0;
  let failed = 0;

  for (const event of events) {
    const outcome = await (options.recurring?processProviderEvent(event,options.recurring):processProviderEvent(event));
    switch (outcome.kind) {
      case "observed":
      case "applied":
        applied += 1;
        break;
      case "unchanged":
      case "already_processed":
      case "noop":
        noop += 1;
        break;
      case "no_mapping":
        skipped += 1;
        break;
      case "unmatched":
        unmatched += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }

  return { examined: events.length, applied, noop, skipped, unmatched, failed };
}

let timer: ReturnType<typeof setInterval> | null = null;

export interface StartDrainOptions extends DrainPassOptions {
  readonly intervalMs?: number;
}

export function startProviderEventDrain(options: StartDrainOptions = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runProviderEventDrainPass(options).catch((error: unknown) => {
      process.emitWarning(
        `Peable provider event drain tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
