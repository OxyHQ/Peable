/**
 * The retry behind the post-authorization judgment (ADR 0022 D3): a charge
 * whose snapshot was never read, or whose judgment threw, is judged on the
 * next pass. The claim inside `judgeAuthorization` keeps every pass and every
 * task from judging one charge twice; a charge older than a day is left alone
 * (the payment has long moved on, and judging it now would be retroactive).
 */
import { findUnjudgedCharges } from '../../db/payments/chargeRepository';
import { findIntentById } from '../../db/payments/paymentIntentRepository';
import { getDb } from '../../db/postgres';
import { syncChargeFromProvider } from '../charges';

const DEFAULT_INTERVAL_MS = 60 * 1000;
const BATCH = 50;

/** One pass: read the snapshot of each unjudged charge, which judges it. */
export async function runJudgeSweep(): Promise<number> {
  const db = getDb();
  const due = await findUnjudgedCharges(db, BATCH);
  for (const { paymentIntentId } of due) {
    const intent = await findIntentById(db, paymentIntentId);
    // `syncChargeFromProvider` reads the payment's charge and its snapshot,
    // and the snapshot write runs the judgment. Never throws.
    if (intent) await syncChargeFromProvider(intent);
  }
  return due.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background retry. A second call is a no-op. */
export function startJudgeSweeper(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void runJudgeSweep().catch((error: unknown) => {
      process.emitWarning(
        `Peable risk-rule judge sweep tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
}

export function stopJudgeSweeper(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
