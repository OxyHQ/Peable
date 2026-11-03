import type { CurrencyCode } from '@peable.to/shared-types';

/**
 * Decimal places of each currency's smallest unit.
 *
 * Restated rather than imported: the `@peable.to/shared-types` root barrel also
 * exports the `node:crypto` webhook signer, which a browser or React Native
 * bundle cannot load (the wallet imports its tax values from `/tax` for the same
 * reason). `money.test.ts` pins this table to `CURRENCY_DECIMALS`, so the two
 * spellings of one fact cannot drift.
 */
export const ORBIT_CURRENCY_DECIMALS: Readonly<Record<CurrencyCode, number>> = {
  FAIR: 8,
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  CZK: 2,
  CAD: 2,
  AUD: 2,
  // Zero-decimal: `1500` is fifteen hundred yen.
  JPY: 0,
};

const BASE_UNITS = /^(0|[1-9][0-9]*)$/;

function decimalsOf(currency: string): number | null {
  return Object.hasOwn(ORBIT_CURRENCY_DECIMALS, currency)
    ? ORBIT_CURRENCY_DECIMALS[currency as CurrencyCode]
    : null;
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A base-unit amount string as a decimal number string, exactly — never through
 * a float, because a FAIR amount does not fit one (`CONVENTIONS.md` §Money).
 *
 * Fiat keeps its full precision (`12.50`). FAIR keeps at least two places and
 * drops the trailing zeros of the other six (`1.00`, `0.00012345`). Returns
 * `null` for a currency or an amount the gateway would never send.
 */
export function formatAmountValue(amount: string, currency: string): string | null {
  const decimals = decimalsOf(currency);
  if (decimals === null || !BASE_UNITS.test(amount)) return null;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  let fraction = padded.slice(padded.length - decimals);
  if (currency === 'FAIR') fraction = fraction.replace(/0+$/, '').padEnd(2, '0');
  return fraction ? `${group(whole)}.${fraction}` : group(whole);
}

/** `12.50 EUR`; an amount that cannot be read is shown as its raw base units. */
export function formatAmount(amount: string, currency: string): string {
  const value = formatAmountValue(amount, currency);
  return value === null ? `${amount} (base units) ${currency}` : `${value} ${currency}`;
}

/**
 * A currency code as Orbit's tables spell it. Provider-mirrored objects
 * (balances, balance transactions, payouts) may carry the provider's
 * lower-case `eur`; the amount means the same thing.
 */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * A SIGNED base-unit amount (`"-1500"`) — a ledger figure, where a refund or a
 * payout takes money out — formatted exactly: `-15.00 EUR`. Case-insensitive
 * in the currency. An unreadable amount is shown raw, like `formatAmount`.
 */
export function formatSignedAmount(amount: string, currency: string): string {
  const code = normalizeCurrency(currency);
  const negative = amount.startsWith('-');
  const magnitude = negative ? amount.slice(1) : amount;
  const value = magnitude === '0' && negative ? null : formatAmountValue(magnitude, code);
  if (value === null) return `${amount} (base units) ${code}`;
  return `${negative ? '-' : ''}${value} ${code}`;
}

/** A ledger figure that may be missing: `null` is "not reported", never zero. */
export function formatOptionalAmount(
  amount: string | null,
  currency: string,
  missing: string,
): string {
  return amount === null ? missing : formatSignedAmount(amount, currency);
}

/**
 * What a person typed (`12.5`, `1,000.00`) as base units of `currency`
 * (`"1250"`), exactly — or `null` when it is not a positive amount with at
 * most the currency's decimals. Never through a float.
 */
export function parseAmountInput(text: string, currency: string): string | null {
  const decimals = decimalsOf(normalizeCurrency(currency));
  if (decimals === null) return null;
  const cleaned = text.trim().replace(/,/g, '');
  const match = /^([0-9]+)(?:\.([0-9]*))?$/.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) return null;
  const units = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=[0-9])/, '');
  return units === '0' ? null : units;
}

/** Whether base-unit amount `a` is greater than `b` (both canonical, `b` may be negative). */
export function exceedsBaseUnits(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/** Sum base-unit strings exactly. Throws on anything that is not one. */
export function sumBaseUnits(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    if (!BASE_UNITS.test(amount)) throw new Error(`Not a base-unit amount: ${amount}`);
    total += BigInt(amount);
  }
  return total.toString();
}
