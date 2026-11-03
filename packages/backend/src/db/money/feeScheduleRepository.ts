/**
 * `fee_schedules` — Orbit's fee per merchant (ADR 0015 §3). Operator data: the
 * only writer is `setFeeSchedule`, reached from the operator CLI and tests,
 * never from a merchant-facing route.
 */
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { feeSchedules } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { FeePaymentMethodType } from '../schema/valueSets';

export interface FeeScheduleRow {
  readonly paymentMethodType: FeePaymentMethodType;
  readonly currency: string;
  readonly percentBps: number;
  readonly fixedAmount: string;
}

export async function findFeeSchedule(
  db: DatabaseOrTransaction,
  merchantId: string,
  paymentMethodType: FeePaymentMethodType,
  currency: string,
): Promise<FeeScheduleRow | null> {
  const [row] = await db
    .select({
      paymentMethodType: feeSchedules.paymentMethodType,
      currency: feeSchedules.currency,
      percentBps: feeSchedules.percentBps,
      fixedAmount: feeSchedules.fixedAmount,
    })
    .from(feeSchedules)
    .where(
      and(
        eq(feeSchedules.merchantId, merchantId),
        eq(feeSchedules.paymentMethodType, paymentMethodType),
        eq(feeSchedules.currency, currency),
      ),
    );
  return row ? (row as FeeScheduleRow) : null;
}

/** Set (or replace) one merchant's rate for a method and currency. */
export async function setFeeSchedule(
  db: DatabaseOrTransaction,
  params: {
    readonly merchantId: string;
    readonly paymentMethodType: FeePaymentMethodType;
    readonly currency: string;
    readonly percentBps: number;
    readonly fixedAmount: string;
  },
): Promise<void> {
  await db
    .insert(feeSchedules)
    .values({ id: uuidv7(), ...params })
    .onConflictDoUpdate({
      target: [feeSchedules.merchantId, feeSchedules.paymentMethodType, feeSchedules.currency],
      set: { percentBps: params.percentBps, fixedAmount: params.fixedAmount },
    });
}
