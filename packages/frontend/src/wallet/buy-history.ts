/**
 * Compatibility access to historical currency-purchase records. Peable no longer
 * offers that flow or calls the bridge. Keep local records readable; removing a
 * product surface must not erase a user's financial history.
 */

import type { Database } from '../storage/database';
export type PaymentCurrency = 'USDC_BASE' | 'ETH_BASE' | 'ETH_MAINNET' | 'BTC' | 'CARD';
export type BuyOrderStatus =
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_DETECTED'
  | 'SWAPPING'
  | 'BURNING'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'FAILED'
  | 'EXPIRED';

export interface BuyHistoryEntry {
  readonly id: string;
  readonly fairAmountSats: bigint;
  readonly paymentCurrency: PaymentCurrency;
  /** Human-facing payment amount, e.g. "0.516487". */
  readonly paymentAmountFormatted: string;
  readonly paymentSymbol: string;
  readonly status: BuyOrderStatus;
  /** Unix seconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** FairCoin txid of the delivery, once the bridge has sent it. */
  readonly deliveryTxId: string | null;
  /** Bridge-reported failure reason, when the order failed. */
  readonly errorMessage: string | null;
}

/**
 * Statuses the bridge will never move away from. Used to skip refreshing
 * orders that can no longer change.
 */
const TERMINAL_STATUSES: ReadonlySet<BuyOrderStatus> = new Set(['DELIVERED', 'FAILED', 'EXPIRED']);

export function isTerminalBuyStatus(status: BuyOrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Whether an order still needs polling: not terminal, so the bridge may still
 * advance it.
 */
export function needsStatusRefresh(entry: BuyHistoryEntry): boolean {
  return !isTerminalBuyStatus(entry.status);
}

export async function recordBuyOrder(
  db: Database,
  entry: Omit<BuyHistoryEntry, 'updatedAt' | 'deliveryTxId' | 'errorMessage'>,
): Promise<void> {
  await db.upsertBuyOrder({
    id: entry.id,
    fair_amount_sats: entry.fairAmountSats.toString(),
    payment_currency: entry.paymentCurrency,
    payment_amount: entry.paymentAmountFormatted,
    payment_symbol: entry.paymentSymbol,
    status: entry.status,
    delivery_txid: '',
    error_message: '',
    created_at: entry.createdAt,
    updated_at: entry.createdAt,
  });
}

export async function updateBuyOrderStatus(
  db: Database,
  id: string,
  status: BuyOrderStatus,
  options: { deliveryTxId?: string | null; errorMessage?: string | null } = {},
): Promise<void> {
  await db.updateBuyOrderStatus(
    id,
    status,
    options.deliveryTxId ?? '',
    options.errorMessage ?? '',
    Math.floor(Date.now() / 1000),
  );
}

export async function listBuyOrders(db: Database, limit: number): Promise<BuyHistoryEntry[]> {
  const rows = await db.getBuyOrders(limit);
  return rows.map((row) => ({
    id: row.id,
    fairAmountSats: BigInt(row.fair_amount_sats),
    paymentCurrency: row.payment_currency as PaymentCurrency,
    paymentAmountFormatted: row.payment_amount,
    paymentSymbol: row.payment_symbol,
    status: row.status as BuyOrderStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveryTxId: row.delivery_txid === '' ? null : row.delivery_txid,
    errorMessage: row.error_message === '' ? null : row.error_message,
  }));
}
