/**
 * Deletes `Idempotency-Key` rows past their 24 hours (ADR 0014 D3).
 *
 * Postgres has no TTL index, and `@oxy.so/db/expiry` is the one mechanism for
 * time-based retention, so this is a registry entry for it plus a timer — not a
 * hand-rolled `DELETE`.
 *
 * Correctness never waits on it. `findIdempotencyKey` ignores an expired row
 * and `claimIdempotencyKey` takes one over, so a row the sweep has not reached
 * yet answers nobody. The sweep only keeps the table from growing forever.
 *
 * Every task runs it; two sweeps deleting the same expired rows is harmless.
 */

import {
  sweepExpiredRows,
  type ExpirySweepResult,
  type ExpirySweepTarget,
} from '@oxy.so/db/expiry';
import { getDb } from '../db/postgres';
import { idempotencyKeys } from '../db/schema';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export const IDEMPOTENCY_KEY_EXPIRY: ExpirySweepTarget = {
  table: idempotencyKeys,
  // The column IS the deadline: `created_at` + 24 hours, written at claim time.
  column: idempotencyKeys.expiresAt,
  retentionSeconds: 0,
  reason:
    'a key past its 24 hours replays nothing and binds nothing; the business idempotency beneath it is durable',
};

/** One pass: delete every expired key, in bounded batches. */
export function runIdempotencySweep(): Promise<ExpirySweepResult> {
  return sweepExpiredRows(getDb(), IDEMPOTENCY_KEY_EXPIRY);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background sweep. A second call is a no-op. */
export function startIdempotencySweeper(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runIdempotencySweep().catch((error: unknown) => {
      // One failed pass must not crash the process; the next tick retries.
      process.emitWarning(
        `Peable idempotency sweep tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopIdempotencySweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
