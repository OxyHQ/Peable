/**
 * What the billing engine is handed rather than reaching for (ADR 0018 §3):
 * the wall clock and Peable Tax (email goes through Orbit's one outbox,
 * `services/email/*`). `createGateway` configures it;
 * tests replace any part.
 *
 * ## The clock
 *
 * The engine never calls `new Date()` for a billing decision. It asks
 * {@link engineNow} for the instant of ONE customer's world: the test clock's
 * `frozen_time` when the customer lives on one (test mode only), the wall
 * clock otherwise.
 */
import { eq } from 'drizzle-orm';
import { testClocks } from '../../db/schema';
import type { DatabaseOrTransaction } from '../../db/postgres';
import type { TaxService } from '../tax/taxService';

export interface BillingEngineRuntime {
  readonly wallClock: () => Date;
  readonly tax: TaxService | undefined;
}

let runtime: BillingEngineRuntime = {
  wallClock: () => new Date(),
  tax: undefined,
};

export function configureBillingEngine(next: Partial<BillingEngineRuntime>): void {
  runtime = { ...runtime, ...next };
}

export function billingEngineRuntime(): BillingEngineRuntime {
  return runtime;
}

/** The wall clock — the instant of every customer NOT on a test clock. */
export function wallNow(): Date {
  return runtime.wallClock();
}

/**
 * "Now" for objects on `testClockId`: its frozen time, or the wall clock for
 * `null`. A deleted clock still answers its last frozen time — nothing on it
 * is acted on any more, but a read stays consistent.
 */
export async function engineNow(
  db: DatabaseOrTransaction,
  testClockId: string | null,
): Promise<Date> {
  if (testClockId === null) return wallNow();
  const [clock] = await db
    .select({ frozenTime: testClocks.frozenTime })
    .from(testClocks)
    .where(eq(testClocks.id, testClockId));
  if (!clock) throw new Error(`test clock ${testClockId} vanished`);
  return clock.frozenTime;
}
