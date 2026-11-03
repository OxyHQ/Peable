/**
 * Deletes request logs past their 30 days.
 *
 * A registry entry for `@oxy.so/db/expiry` plus a timer — the one mechanism for
 * time-based retention — as `eventSweeper.ts` is for events. Correctness never
 * waits on it: every read in `db/requestLogs/requestLogRepository.ts` filters
 * on the same horizon, so a row the sweep has not reached is already invisible.
 */
import {
  sweepExpiredRows,
  type ExpirySweepResult,
  type ExpirySweepTarget,
} from '@oxy.so/db/expiry';
import { REQUEST_LOG_RETENTION_DAYS } from '@peable.to/shared-types';
import { getDb } from '../db/postgres';
import { apiRequestLogs } from '../db/schema';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export const REQUEST_LOG_EXPIRY: ExpirySweepTarget = {
  table: apiRequestLogs,
  column: apiRequestLogs.createdAt,
  retentionSeconds: REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60,
  reason:
    'the request log serves 30 days to the merchant (Orbit, peable logs tail); nothing else reads it',
};

/** One pass: delete every expired request log, in bounded batches. */
export function runRequestLogSweep(): Promise<ExpirySweepResult> {
  return sweepExpiredRows(getDb(), REQUEST_LOG_EXPIRY);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background sweep. A second call is a no-op. */
export function startRequestLogSweeper(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runRequestLogSweep().catch((error: unknown) => {
      process.emitWarning(
        `Peable request log sweep tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopRequestLogSweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
