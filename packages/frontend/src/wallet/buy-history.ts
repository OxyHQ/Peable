/**
 * Local record of buy orders.
 *
 * A buy is the one flow in this wallet whose state lives on a server rather
 * than on the chain or in the local UTXO set. Until now nothing on the device
 * remembered that an order existed: the order id was passed to the quote screen
 * as a navigation param and lost the moment the user went back. If they closed
 * the screen while a payment was in flight — or the app was killed, or they
 * simply wanted to check later — there was no way to find out what happened to
 * their money.
 *
 * So every order is written here the instant the bridge accepts it, before the
 * user is navigated anywhere. Rows are a cache of the bridge's state, never the
 * source of truth: `status` is refreshed from `GET /api/buy/status/:id` and the
 * bridge always wins.
 *
 * Only non-sensitive order metadata is stored. The delivery address is one of
 * the wallet's own receive addresses and is already in `addresses`.
 */

import type { Database } from "../storage/database";
import type { BuyOrderStatus, PaymentCurrency } from "../api/buy";

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
const TERMINAL_STATUSES: ReadonlySet<BuyOrderStatus> = new Set([
  "DELIVERED",
  "FAILED",
  "EXPIRED",
]);

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
  entry: Omit<BuyHistoryEntry, "updatedAt" | "deliveryTxId" | "errorMessage">,
): Promise<void> {
  await db.upsertBuyOrder({
    id: entry.id,
    fair_amount_sats: entry.fairAmountSats.toString(),
    payment_currency: entry.paymentCurrency,
    payment_amount: entry.paymentAmountFormatted,
    payment_symbol: entry.paymentSymbol,
    status: entry.status,
    delivery_txid: "",
    error_message: "",
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
    options.deliveryTxId ?? "",
    options.errorMessage ?? "",
    Math.floor(Date.now() / 1000),
  );
}

export async function listBuyOrders(
  db: Database,
  limit: number,
): Promise<BuyHistoryEntry[]> {
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
    deliveryTxId: row.delivery_txid === "" ? null : row.delivery_txid,
    errorMessage: row.error_message === "" ? null : row.error_message,
  }));
}
