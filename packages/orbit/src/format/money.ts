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

/** Sum base-unit strings exactly. Throws on anything that is not one. */
export function sumBaseUnits(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    if (!BASE_UNITS.test(amount)) throw new Error(`Not a base-unit amount: ${amount}`);
    total += BigInt(amount);
  }
  return total.toString();
}
