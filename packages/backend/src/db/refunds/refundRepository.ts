/**
 * Reads and writes for `refunds`.
 *
 * The read that matters is `sumSucceededRefunds`. A payment's refunded total is
 * DERIVED from these rows and never stored on the payment, because a stored
 * total is a second place the same fact lives and the two disagree the first
 * time a write is lost.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { refunds } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ProviderId } from '../../services/providers/provider';

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface RefundRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly status: RefundStatus;
  readonly provider: ProviderId;
  readonly providerObjectId: string | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const REFUND_COLUMNS = {
  id: refunds.id,
  publicId: refunds.publicId,
  merchantId: refunds.merchantId,
  paymentIntentId: refunds.paymentIntentId,
  externalRef: refunds.externalRef,
  amount: refunds.amount,
  currency: refunds.currency,
  status: refunds.status,
  provider: refunds.provider,
  providerObjectId: refunds.providerObjectId,
  failureCode: refunds.failureCode,
  createdAt: refunds.createdAt,
  updatedAt: refunds.updatedAt,
} as const;

function toRow(row: Record<string, unknown>): RefundRow {
  return row as unknown as RefundRow;
}

export interface InsertRefundParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly provider: ProviderId;
}

/**
 * Record a refund this gateway is about to make.
 *
 * @returns the row, or `null` when `(merchant_id, external_ref)` already exists
 *   — the merchant is retrying a refund they already made. The caller re-reads
 *   the winner rather than sending the payer their money twice, which nothing
 *   reverses automatically and which the payer has no reason to report.
 */
export async function insertRefund(
  db: DatabaseOrTransaction,
  params: InsertRefundParams
): Promise<RefundRow | null> {
  try {
    const [row] = await db
      .insert(refunds)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        paymentIntentId: params.paymentIntentId,
        externalRef: params.externalRef,
        amount: params.amount,
        currency: params.currency,
        provider: params.provider,
      })
      .returning(REFUND_COLUMNS);
    return row ? toRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'refunds_merchant_external_ref_key')) return null;
    throw error;
  }
}

/**
 * Link the provider's refund and mark it succeeded.
 *
 * Guarded on `provider_object_id IS NULL`, so it fills the gap and never
 * repoints: a second provider refund for one row means the payer was paid
 * twice, and moving the row would hide the first rather than surface it.
 */
export async function markRefundSucceeded(
  db: DatabaseOrTransaction,
  refundId: string,
  providerObjectId: string
): Promise<RefundRow | null> {
  const [row] = await db
    .update(refunds)
    .set({ providerObjectId, status: 'succeeded', failureCode: null })
    .where(and(eq(refunds.id, refundId), isNull(refunds.providerObjectId)))
    .returning(REFUND_COLUMNS);
  return row ? toRow(row) : null;
}

/** Record that the provider refused. Nothing moved. */
export async function markRefundFailed(
  db: DatabaseOrTransaction,
  refundId: string,
  failureCode: string
): Promise<RefundRow | null> {
  const [row] = await db
    .update(refunds)
    .set({ status: 'failed', failureCode })
    .where(eq(refunds.id, refundId))
    .returning(REFUND_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * What has actually gone back off one payment.
 *
 * **`succeeded` only.** A `pending` refund has not moved money and a `failed`
 * one never will; counting either would refuse a legitimate later refund
 * because the payment looked exhausted. Summed as NUMERIC — these are canonical
 * integer strings, and `'9' + '10'` concatenates while `'9' > '10'` is false.
 *
 * Returns a canonical integer string, so it composes with every other amount in
 * this codebase without a second representation appearing.
 */
export async function sumSucceededRefunds(
  db: DatabaseOrTransaction,
  paymentIntentId: string
): Promise<string> {
  const [row] = await db
    .select({
      // `coalesce`, because `sum` over no rows is NULL rather than 0 — and a
      // NULL here would read as "unknown" at every call site that then has to
      // remember to default it.
      total: sql<string>`coalesce(sum(${refunds.amount}::numeric), 0)::text`,
    })
    .from(refunds)
    .where(and(eq(refunds.paymentIntentId, paymentIntentId), eq(refunds.status, 'succeeded')));
  return row?.total ?? '0';
}

/** The merchant's own address for a refund — the idempotency lookup. */
export async function findRefundByExternalRef(
  db: DatabaseOrTransaction,
  merchantId: string,
  externalRef: string
): Promise<RefundRow | null> {
  const [row] = await db
    .select(REFUND_COLUMNS)
    .from(refunds)
    .where(and(eq(refunds.merchantId, merchantId), eq(refunds.externalRef, externalRef)));
  return row ? toRow(row) : null;
}

/** By `re_…`, SCOPED TO THE MERCHANT. */
export async function findRefundByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string
): Promise<RefundRow | null> {
  const [row] = await db
    .select(REFUND_COLUMNS)
    .from(refunds)
    .where(and(eq(refunds.merchantId, merchantId), eq(refunds.publicId, publicId)));
  return row ? toRow(row) : null;
}

/** Where an inbound refund event lands. Not merchant-scoped, by design. */
export async function findRefundByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string
): Promise<RefundRow | null> {
  const [row] = await db
    .select(REFUND_COLUMNS)
    .from(refunds)
    .where(and(eq(refunds.provider, provider), eq(refunds.providerObjectId, providerObjectId)));
  return row ? toRow(row) : null;
}

/** Every refund against one payment. Newest first. */
export async function listRefundsForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string
): Promise<readonly RefundRow[]> {
  const rows = await db
    .select(REFUND_COLUMNS)
    .from(refunds)
    .where(eq(refunds.paymentIntentId, paymentIntentId))
    .orderBy(desc(refunds.createdAt));
  return rows.map(toRow);
}
