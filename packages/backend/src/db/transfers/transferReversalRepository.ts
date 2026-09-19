/**
 * Reads and writes for `transfer_reversals`.
 *
 * These rows are NOT the seller's balance. `transfers.amount_reversed` is, and
 * it holds the PROVIDER's cumulative figure — which includes reversals this
 * gateway did not make. What these rows carry is the operation: which reversal
 * was asked for, under whose reference, and how it ended.
 *
 * The split matters when the two disagree. A sum of these rows would be a
 * second answer to "how much came back", and the two would part company the
 * first time an operator reversed a transfer from the provider's dashboard.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { CurrencyCode } from '@peable.to/shared-types';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { transferReversals } from '../schema';
import type { DatabaseOrTransaction } from '../postgres';
import type { ProviderId } from '../../services/providers/provider';

export type TransferReversalStatus = 'pending' | 'succeeded' | 'failed';

export interface TransferReversalRow {
  readonly id: string;
  readonly publicId: string;
  readonly merchantId: string;
  readonly transferId: string;
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly status: TransferReversalStatus;
  readonly provider: ProviderId;
  readonly providerObjectId: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const REVERSAL_COLUMNS = {
  id: transferReversals.id,
  publicId: transferReversals.publicId,
  merchantId: transferReversals.merchantId,
  transferId: transferReversals.transferId,
  externalRef: transferReversals.externalRef,
  amount: transferReversals.amount,
  currency: transferReversals.currency,
  status: transferReversals.status,
  provider: transferReversals.provider,
  providerObjectId: transferReversals.providerObjectId,
  failureMessage: transferReversals.failureMessage,
  createdAt: transferReversals.createdAt,
  updatedAt: transferReversals.updatedAt,
} as const;

function toRow(row: Record<string, unknown>): TransferReversalRow {
  return row as unknown as TransferReversalRow;
}

export interface InsertTransferReversalParams {
  readonly publicId: string;
  readonly merchantId: string;
  readonly transferId: string;
  readonly externalRef: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly provider: ProviderId;
}

/**
 * Record a reversal this gateway is about to make.
 *
 * @returns the row, or `null` when `(merchant_id, external_ref)` already exists
 *   — the merchant is retrying a reversal they already made. The caller
 *   re-reads the winner rather than taking a second amount off a seller.
 *
 * Written BEFORE the provider call, like every other money movement here: a
 * crash in that window must leave a row naming the operation, because the
 * provider idempotency key is derived from this row's `public_id` and recovery
 * has nowhere else to find it.
 */
export async function insertTransferReversal(
  db: DatabaseOrTransaction,
  params: InsertTransferReversalParams
): Promise<TransferReversalRow | null> {
  try {
    const [row] = await db
      .insert(transferReversals)
      .values({
        id: uuidv7(),
        publicId: params.publicId,
        merchantId: params.merchantId,
        transferId: params.transferId,
        externalRef: params.externalRef,
        amount: params.amount,
        currency: params.currency,
        provider: params.provider,
      })
      .returning(REVERSAL_COLUMNS);
    return row ? toRow(row) : null;
  } catch (error) {
    if (isUniqueViolation(error, 'transfer_reversals_merchant_external_ref_key')) return null;
    throw error;
  }
}

/**
 * Link the provider's reversal object and mark it succeeded.
 *
 * Guarded on `provider_object_id IS NULL`, so it fills the gap and never
 * repoints: a second provider reversal for one row means a seller lost the
 * amount twice, and moving the row would hide the first rather than surface it.
 */
export async function markTransferReversalSucceeded(
  db: DatabaseOrTransaction,
  reversalId: string,
  providerObjectId: string
): Promise<TransferReversalRow | null> {
  const [row] = await db
    .update(transferReversals)
    .set({ providerObjectId, status: 'succeeded', failureMessage: null })
    .where(
      and(eq(transferReversals.id, reversalId), isNull(transferReversals.providerObjectId))
    )
    .returning(REVERSAL_COLUMNS);
  return row ? toRow(row) : null;
}

/** Record that the provider refused. Nothing moved. */
export async function markTransferReversalFailed(
  db: DatabaseOrTransaction,
  reversalId: string,
  failureMessage: string
): Promise<TransferReversalRow | null> {
  const [row] = await db
    .update(transferReversals)
    .set({ status: 'failed', failureMessage })
    .where(eq(transferReversals.id, reversalId))
    .returning(REVERSAL_COLUMNS);
  return row ? toRow(row) : null;
}

/** The merchant's own address for a reversal — the idempotency lookup. */
export async function findTransferReversalByExternalRef(
  db: DatabaseOrTransaction,
  merchantId: string,
  externalRef: string
): Promise<TransferReversalRow | null> {
  const [row] = await db
    .select(REVERSAL_COLUMNS)
    .from(transferReversals)
    .where(
      and(
        eq(transferReversals.merchantId, merchantId),
        eq(transferReversals.externalRef, externalRef)
      )
    );
  return row ? toRow(row) : null;
}

/** Every reversal against one settlement. Newest first. */
export async function listReversalsForTransfer(
  db: DatabaseOrTransaction,
  transferId: string
): Promise<readonly TransferReversalRow[]> {
  const rows = await db
    .select(REVERSAL_COLUMNS)
    .from(transferReversals)
    .where(eq(transferReversals.transferId, transferId))
    .orderBy(desc(transferReversals.createdAt));
  return rows.map(toRow);
}
