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

/** Who created a refund row — this API, or the provider. */
export type RefundOrigin = 'merchant' | 'provider';

export interface RefundRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  /** `null` for an IMPORTED refund — the merchant did not make it. */
  readonly externalRef: string | null;
  readonly origin: RefundOrigin;
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
  origin: refunds.origin,
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

/**
 * Record the provider's refund object WITHOUT claiming the money moved.
 *
 * The write that was missing. `createRefund` called `markRefundSucceeded` as
 * soon as `provider.refund` returned, without reading `result.state` — so a
 * refund the provider reported as `pending` was stored as `succeeded`, counted
 * toward the payment's refunded total, and moved the payment to `refunded`. A
 * refund that then FAILED left a payment permanently claiming money had gone
 * back that never did, and the merchant's own reconciliation is the only place
 * it would ever surface.
 *
 * The provider's id has to be stored anyway, and immediately: it is the only
 * handle a later `refund.updated` can be matched on
 * (`refunds_provider_object_key`), so a pending refund with no id recorded is
 * one whose eventual outcome lands as `unmatched`.
 *
 * Guarded on `provider_object_id IS NULL` for the same reason its sibling is.
 */
export async function linkRefundObject(
  db: DatabaseOrTransaction,
  refundId: string,
  providerObjectId: string
): Promise<RefundRow | null> {
  const [row] = await db
    .update(refunds)
    .set({ providerObjectId })
    .where(and(eq(refunds.id, refundId), isNull(refunds.providerObjectId)))
    .returning(REFUND_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Move a refund to whatever the provider now says it is.
 *
 * The AUTHORITATIVE write, used by the event drain and by reconciliation. Takes
 * a status rather than a direction, because the mapping from the provider's
 * vocabulary belongs in one place and a helper per edge would scatter it.
 *
 * ## Three legal edges, and the two that are refused
 *
 *  - `pending → succeeded` and `pending → failed` are the ordinary outcomes.
 *  - `succeeded → failed` is the one that is easy to leave out and expensive to
 *    omit: a bank can reject a refund DAYS after the provider accepted it, and
 *    without this edge the row stays `succeeded`, the payment stays `refunded`,
 *    and the merchant's books say money went back that is still with them.
 *  - `failed → anything` is refused. A failed refund is terminal at the
 *    provider; a merchant who still wants to refund creates a new one, and
 *    reviving this row would make the two the same refund.
 *  - `succeeded → pending` is refused, which is what makes an out-of-order
 *    delivery harmless: the `pending` that preceded a success is redelivered
 *    routinely, and applying it would walk the money back.
 *
 * Expressed in the WHERE rather than read-then-written, so two drain passes on
 * two tasks cannot both decide from the same stale read.
 */
export async function applyRefundState(
  db: DatabaseOrTransaction,
  refundId: string,
  status: RefundStatus,
  failureCode: string | null
): Promise<RefundRow | null> {
  const [row] = await db
    .update(refunds)
    .set({ status, failureCode })
    .where(
      and(
        eq(refunds.id, refundId),
        status === 'failed'
          ? sql`${refunds.status} in ('pending', 'succeeded')`
          : eq(refunds.status, 'pending')
      )
    )
    .returning(REFUND_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Record a refund that appeared AT THE PROVIDER — a dashboard refund, or the
 * network resolving a dispute.
 *
 * `origin: 'provider'` and no `external_ref`: the merchant did not make this
 * and has no id for it, and inventing one would claim they had.
 * `refunds_origin_ref_agrees_check` says the same in the database.
 *
 * @returns the row, or `null` when `(provider, provider_object_id)` already
 *   exists — a redelivery, converged on rather than read first.
 */
export async function importProviderRefund(
  db: DatabaseOrTransaction,
  params: {
    readonly publicId: string;
    readonly merchantId: string;
    readonly paymentIntentId: string;
    readonly amount: string;
    readonly currency: CurrencyCode;
    readonly provider: ProviderId;
    readonly providerObjectId: string;
    readonly status: RefundStatus;
  }
): Promise<RefundRow | null> {
  try {
    const [row] = await db
      .insert(refunds)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        paymentIntentId: params.paymentIntentId,
        externalRef: null,
        origin: 'provider',
        amount: params.amount,
        currency: params.currency,
        status: params.status,
        provider: params.provider,
        providerObjectId: params.providerObjectId,
      })
      .returning(REFUND_COLUMNS);
    return row ? toRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'refunds_provider_object_key')) return null;
    throw error;
  }
}

/**
 * Record that the refund failed. Nothing moved.
 *
 * `providerObjectId` is OPTIONAL and the two cases differ: a call that never
 * reached the provider has no object to name, while a provider that CREATED a
 * refund object and then reported it failed does — and that id is what a later
 * `refund.updated` would be matched on, so dropping it makes the eventual event
 * `unmatched`.
 */
export async function markRefundFailed(
  db: DatabaseOrTransaction,
  refundId: string,
  failureCode: string,
  providerObjectId?: string
): Promise<RefundRow | null> {
  const [row] = await db
    .update(refunds)
    .set({
      status: 'failed',
      failureCode,
      ...(providerObjectId === undefined ? {} : { providerObjectId }),
    })
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

/**
 * What this payment has COMMITTED to giving back — succeeded AND pending.
 *
 * Different from `sumSucceededRefunds` and both are needed. The payment's own
 * `refunded` / `partially_refunded` status is derived from money that actually
 * moved, so that one counts successes only. This one is the BUDGET: a refund
 * sitting `pending` at the provider will most likely land, and two concurrent
 * refunds that each read only the succeeded total would both pass a check that
 * only one of them should — sending the payer more than they paid, which
 * nothing reverses automatically.
 */
export async function sumCommittedRefunds(
  db: DatabaseOrTransaction,
  paymentIntentId: string
): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${refunds.amount}::numeric), 0)::text`,
    })
    .from(refunds)
    .where(
      and(eq(refunds.paymentIntentId, paymentIntentId), sql`${refunds.status} <> 'failed'`)
    );
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
