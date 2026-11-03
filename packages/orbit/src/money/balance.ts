import type { Balance, BalanceAmount } from '@peable.to/shared-types';
import { normalizeCurrency, ORBIT_CURRENCY_DECIMALS } from '../format/money';

/** One currency's line of the balance: each figure, or `null` when the balance has none in it. */
export interface BalanceRow {
  currency: string;
  available: string | null;
  pending: string | null;
}

/** An informational (FairCoin) figure: on the books, never payable. */
export interface InformationalRow {
  currency: string;
  amount: string;
}

function byCurrency(amounts: readonly BalanceAmount[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of amounts) {
    const currency = normalizeCurrency(entry.currency);
    // One figure per currency on the wire; should one ever repeat, add exactly.
    const prior = out.get(currency);
    out.set(
      currency,
      prior === undefined ? entry.amount : String(BigInt(prior) + BigInt(entry.amount)),
    );
  }
  return out;
}

/**
 * The payable balance per currency, alphabetical. A currency present in only
 * one of `available` / `pending` keeps `null` in the other — absent, not zero.
 */
export function balanceRows(balance: Balance): BalanceRow[] {
  const available = byCurrency(balance.available);
  const pending = byCurrency(balance.pending);
  const currencies = [...new Set([...available.keys(), ...pending.keys()])].sort();
  return currencies.map((currency) => ({
    currency,
    available: available.get(currency) ?? null,
    pending: pending.get(currency) ?? null,
  }));
}

export function informationalRows(balance: Balance): InformationalRow[] {
  return [...byCurrency(balance.informational).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }));
}

/** The mismatches a later reconciliation run still sees, oldest first. */
export function unresolvedMismatches<T extends { resolved_at: number | null; detected_at: number }>(
  mismatches: readonly T[],
): T[] {
  return mismatches
    .filter((mismatch) => mismatch.resolved_at === null)
    .sort((a, b) => a.detected_at - b.detected_at);
}

/**
 * The currencies a payout can be asked in: those with a POSITIVE available
 * figure that Orbit can format — never FairCoin, which Orbit never holds.
 */
export function payableCurrencies(balance: Balance): InformationalRow[] {
  return balanceRows(balance)
    .filter(
      (row): row is BalanceRow & { available: string } =>
        row.available !== null &&
        BigInt(row.available) > 0n &&
        row.currency !== 'FAIR' &&
        Object.hasOwn(ORBIT_CURRENCY_DECIMALS, row.currency),
    )
    .map((row) => ({ currency: row.currency, amount: row.available }));
}
