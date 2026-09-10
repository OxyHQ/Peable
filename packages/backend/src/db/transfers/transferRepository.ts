/**
 * Reads and writes for `transfers`.
 *
 * The reversal write is the one to read carefully. It adds to a cumulative
 * total and derives the status from it **in one statement**, because a
 * read-then-write there loses a concurrent partial reversal: two refunds
 * landing together both read `0`, both write their own leg, and the seller
 * keeps money that was taken back.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { CurrencyCode } from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { transfers } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ProviderId } from '../../services/providers/provider';

export type TransferStatus =
  | 'pending'
  | 'paid'
  | 'partially_reversed'
  | 'reversed'
  | 'failed';

export interface TransferRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly connectedAccountId: string;
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly amountReversed: string;
  readonly status: TransferStatus;
  readonly provider: ProviderId;
  readonly providerObjectId: string | null;
  readonly sourcePaymentObjectId: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const TRANSFER_COLUMNS = {
  id: transfers.id,
  publicId: transfers.publicId,
  merchantId: transfers.merchantId,
  paymentIntentId: transfers.paymentIntentId,
  connectedAccountId: transfers.connectedAccountId,
  externalRef: transfers.externalRef,
  amount: transfers.amount,
  currency: transfers.currency,
  amountReversed: transfers.amountReversed,
  status: transfers.status,
  provider: transfers.provider,
  providerObjectId: transfers.providerObjectId,
  sourcePaymentObjectId: transfers.sourcePaymentObjectId,
  failureMessage: transfers.failureMessage,
  createdAt: transfers.createdAt,
  updatedAt: transfers.updatedAt,
} as const;

function toRow(row: Record<string, unknown>): TransferRow {
  return row as unknown as TransferRow;
}

export interface InsertTransferParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly connectedAccountId: string;
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly provider: ProviderId;
  readonly sourcePaymentObjectId: string | null;
}

/**
 * Record a transfer this gateway is about to make.
 *
 * @returns the row, or `null` when `(merchant_id, external_ref)` already
 *   exists — the merchant is settling an order they already settled. The
 *   caller re-reads the winner and reports it, rather than paying twice.
 *
 * Written BEFORE the provider call, like a payment intent and for the same
 * reason: a crash between the two must leave a row, not an untracked movement
 * of a seller's money.
 */
export async function insertTransfer(
  db: DatabaseOrTransaction,
  params: InsertTransferParams
): Promise<TransferRow | null> {
  try {
    const [row] = await db
      .insert(transfers)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        paymentIntentId: params.paymentIntentId,
        connectedAccountId: params.connectedAccountId,
        externalRef: params.externalRef,
        amount: params.amount,
        currency: params.currency,
        provider: params.provider,
        sourcePaymentObjectId: params.sourcePaymentObjectId,
      })
      .returning(TRANSFER_COLUMNS);
    return row ? toRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'transfers_merchant_external_ref_key')) {
      return null;
    }
    throw error;
  }
}

/**
 * Link the provider's object and mark the transfer paid.
 *
 * Guarded on `provider_object_id IS NULL`, so it fills the gap and never
 * repoints a linked row: a second provider call for a transfer that already has
 * an object means a seller was paid twice, and silently moving the row to the
 * new object would hide the first payment rather than surface it.
 */
export async function markTransferPaid(
  db: DatabaseOrTransaction,
  transferId: string,
  providerObjectId: string
): Promise<TransferRow | null> {
  const [row] = await db
    .update(transfers)
    .set({ providerObjectId, status: 'paid', failureMessage: null })
    .where(and(eq(transfers.id, transferId), isNull(transfers.providerObjectId)))
    .returning(TRANSFER_COLUMNS);
  return row ? toRow(row) : null;
}

/** Record that the provider refused. Terminal, and nothing ever moved. */
export async function markTransferFailed(
  db: DatabaseOrTransaction,
  transferId: string,
  failureMessage: string
): Promise<TransferRow | null> {
  const [row] = await db
    .update(transfers)
    .set({ status: 'failed', failureMessage })
    .where(and(eq(transfers.id, transferId), isNull(transfers.providerObjectId)))
    .returning(TRANSFER_COLUMNS);
  return row ? toRow(row) : null;
}

/**
 * Set the CUMULATIVE reversed total, and derive the status from it.
 *
 * `total` is the provider's own cumulative figure (`amount_reversed` on the
 * transfer object), not this leg's amount — a caller adding legs up itself
 * would get the second partial reversal wrong whenever it had not seen the
 * first.
 *
 * The status is derived HERE, in the same statement, because
 * `transfers_reversal_status_agrees_check` refuses the two disagreeing: a
 * writer that set one without the other would leave a seller's balance
 * disagreeing with the row that explains it, and the database would rather stop
 * than store that.
 *
 * Guarded on the new total being no smaller than the stored one, so a provider
 * event arriving out of order cannot walk a reversal backwards — that case
 * answers `null`, because a late first leg is ordinary and not an error.
 *
 * A total LARGER than the transfer throws instead, and the difference is
 * deliberate: it is not an ordering artefact, it is the provider claiming more
 * came back than ever went out, and nothing downstream can do anything sensible
 * with `null` there. `transfers_reversed_within_amount_check` is still the
 * backstop; this exists so the error names what actually happened. Left to the
 * database, the `>=` in the status CASE below turns an over-total into
 * `'reversed'` first, and the constraint that fires is the status-agreement one
 * — measured, and it points a reader at the wrong problem.
 */
export class TransferReversalTooLargeError extends Error {
  constructor(total: string, amount: string) {
    super(`a reversal total of ${total} exceeds the transfer amount of ${amount}`);
    this.name = 'TransferReversalTooLargeError';
  }
}

export async function applyTransferReversal(
  db: DatabaseOrTransaction,
  transferId: string,
  total: string
): Promise<TransferRow | null> {
  const [current] = await db
    .select({ amount: transfers.amount })
    .from(transfers)
    .where(eq(transfers.id, transferId));
  if (current && BigInt(total) > BigInt(current.amount)) {
    // `BigInt`, not `Number`: these are unbounded canonical integer strings and
    // a currency with many minor units can exceed `Number.MAX_SAFE_INTEGER`,
    // where the comparison would start rounding.
    throw new TransferReversalTooLargeError(total, current.amount);
  }

  const [row] = await db
    .update(transfers)
    .set({
      amountReversed: total,
      status: sql`case
        when ${total}::numeric >= ${transfers.amount}::numeric then 'reversed'
        when ${total}::numeric > 0 then 'partially_reversed'
        else ${transfers.status}
      end`,
    })
    .where(
      and(
        eq(transfers.id, transferId),
        // Out-of-order provider events are ordinary. A `reversed` transfer must
        // not be walked back to `partially_reversed` by a late delivery of the
        // first leg.
        sql`${total}::numeric >= ${transfers.amountReversed}::numeric`
      )
    )
    .returning(TRANSFER_COLUMNS);
  return row ? toRow(row) : null;
}

/** The merchant's own address for a settlement — the idempotency lookup. */
export async function findTransferByExternalRef(
  db: DatabaseOrTransaction,
  merchantId: string,
  externalRef: string
): Promise<TransferRow | null> {
  const [row] = await db
    .select(TRANSFER_COLUMNS)
    .from(transfers)
    .where(and(eq(transfers.merchantId, merchantId), eq(transfers.externalRef, externalRef)));
  return row ? toRow(row) : null;
}

/** By `tr_…`, SCOPED TO THE MERCHANT — see `findAccountByPublicId` on why. */
export async function findTransferByPublicId(
  db: DatabaseOrTransaction,
  merchantId: string,
  publicId: string
): Promise<TransferRow | null> {
  const [row] = await db
    .select(TRANSFER_COLUMNS)
    .from(transfers)
    .where(and(eq(transfers.merchantId, merchantId), eq(transfers.publicId, publicId)));
  return row ? toRow(row) : null;
}

/** Where an inbound transfer event lands. Not merchant-scoped, by design. */
export async function findTransferByProviderObject(
  db: DatabaseOrTransaction,
  provider: ProviderId,
  providerObjectId: string
): Promise<TransferRow | null> {
  const [row] = await db
    .select(TRANSFER_COLUMNS)
    .from(transfers)
    .where(
      and(eq(transfers.provider, provider), eq(transfers.providerObjectId, providerObjectId))
    );
  return row ? toRow(row) : null;
}

/** "What did this payment settle?" — the reconciliation read. */
export async function listTransfersForIntent(
  db: DatabaseOrTransaction,
  paymentIntentId: string
): Promise<readonly TransferRow[]> {
  const rows = await db
    .select(TRANSFER_COLUMNS)
    .from(transfers)
    .where(eq(transfers.paymentIntentId, paymentIntentId))
    .orderBy(desc(transfers.createdAt));
  return rows.map(toRow);
}
