/**
 * Deletes events past their 30 days (ADR 0014 D4), and with them their
 * deliveries (`webhook_deliveries.event_id` cascades).
 *
 * A registry entry for `@oxy.so/db/expiry` plus a timer — the one mechanism for
 * time-based retention — not a hand-rolled `DELETE`.
 *
 * Correctness never waits on it: every read in `db/events/eventRepository.ts`
 * filters on the same horizon, so an event the sweep has not reached is
 * already invisible to the API. A delivery still pending at 30 days cannot
 * exist — the retry schedule ends after three.
 *
 * What a swept event takes with it, checked for INTENT:
 * - its deliveries — the log of sending it; nothing else reads them;
 * - `recurring_observation_outbox.event_id` is set NULL, and that row's
 *   `relayed_at` is what records it was relayed, so it is not relayed again.
 */
import {
  sweepExpiredRows,
  type ExpirySweepResult,
  type ExpirySweepTarget,
} from '@oxy.so/db/expiry';
import { getDb } from '../db/postgres';
import { EVENT_RETENTION_DAYS } from '../db/events/eventRepository';
import { events } from '../db/schema';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export const EVENT_EXPIRY: ExpirySweepTarget = {
  table: events,
  column: events.createdAt,
  retentionSeconds: EVENT_RETENTION_DAYS * 24 * 60 * 60,
  reason:
    'the events API serves 30 days (ADR 0014 D4); a delivery is retried for three, so nothing older is still owed to anyone',
};

/** One pass: delete every expired event, in bounded batches. */
export function runEventSweep(): Promise<ExpirySweepResult> {
  return sweepExpiredRows(getDb(), EVENT_EXPIRY);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background sweep. A second call is a no-op. */
export function startEventSweeper(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runEventSweep().catch((error: unknown) => {
      process.emitWarning(
        `Peable event sweep tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopEventSweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
