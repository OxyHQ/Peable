/** Read-only display values. Never use these estimates to authorize a payment. */
import { EXPLORER_BASE_URL } from '@fairco.in/core';

export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'FAIR'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];
export interface DisplayRates {
  /** Currency units per FAIR, as exact decimal strings. */
  usdPerFair: string;
  eurPerFair: string;
  source: string;
  observedAt: string;
  expiresAt: string;
}
export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return DISPLAY_CURRENCIES.some((currency) => currency === value);
}

function fraction(value: string): { numerator: bigint; denominator: bigint } {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(value);
  if (!match || value.length > 80) throw new Error('Invalid display rate');
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
    throw new Error('Invalid display rate');
  let numerator = BigInt(`${match[1]}${match[2] ?? ''}`);
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  if (numerator <= 0n) throw new Error('Invalid display rate');
  return { numerator, denominator };
}

export function displayRatesAreFresh(rates: DisplayRates, now = Date.now()): boolean {
  const observed = Date.parse(rates.observedAt);
  const expires = Date.parse(rates.expiresAt);
  return (
    Number.isFinite(observed) &&
    observed <= now + 1000 &&
    observed >= now - 120_000 &&
    expires > now &&
    expires <= observed + 120_000
  );
}

/** Uses the owning FairCoin source; no cached fallback after expiry or failure. */
export async function readDisplayRates(
  options: { fetch?: typeof fetch; signal?: AbortSignal; now?: number } = {},
): Promise<DisplayRates> {
  const source = `${EXPLORER_BASE_URL}/api/price`;
  const response = await (options.fetch ?? fetch)(source, {
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Exchange rate unavailable');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('price' in body) || !('timestamp' in body))
    throw new Error('Exchange rate unavailable');
  const price = body.price;
  if (
    !price ||
    typeof price !== 'object' ||
    !('usd' in price) ||
    !('eur' in price) ||
    typeof body.timestamp !== 'string'
  )
    throw new Error('Exchange rate unavailable');
  const usdPerFair = String(price.usd);
  const eurPerFair = String(price.eur);
  fraction(usdPerFair);
  fraction(eurPerFair);
  const observed = Date.parse(body.timestamp);
  if (!Number.isFinite(observed)) throw new Error('Exchange rate unavailable');
  const rates = {
    usdPerFair,
    eurPerFair,
    source,
    observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(observed + 120_000).toISOString(),
  };
  if (!displayRatesAreFresh(rates, options.now ?? Date.now()))
    throw new Error('Exchange rate unavailable');
  return rates;
}

/** Decimal string formatting preserves all eight FAIR decimals and large values. */
export function formatDisplayUnits(units: bigint, decimals: number, currency: string): string {
  if (units < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 8)
    throw new Error('Invalid display amount');
  const digits = units.toString().padStart(decimals + 1, '0');
  return `${decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits} ${currency}`;
}

/** Round half up once, at the destination currency's precision. */
export function convertDisplayAmount(input: {
  units: string;
  currency: 'USD' | 'FAIR';
  displayCurrency: DisplayCurrency;
  rates?: DisplayRates | null;
  now?: number;
}): string | null {
  if (!/^(0|[1-9][0-9]*)$/.test(input.units) || input.units.length > 30)
    throw new Error('Invalid display amount');
  const units = BigInt(input.units);
  const sourceScale = input.currency === 'FAIR' ? 100_000_000n : 100n;
  const targetDecimals = input.displayCurrency === 'FAIR' ? 8 : 2;
  if (input.currency === input.displayCurrency || units === 0n)
    return formatDisplayUnits(units === 0n ? 0n : units, targetDecimals, input.displayCurrency);
  if (!input.rates || !displayRatesAreFresh(input.rates, input.now)) return null;
  const usd = fraction(input.rates.usdPerFair);
  const destination =
    input.displayCurrency === 'FAIR'
      ? { numerator: 1n, denominator: 1n }
      : fraction(input.displayCurrency === 'USD' ? input.rates.usdPerFair : input.rates.eurPerFair);
  const numerator =
    units *
    destination.numerator *
    10n ** BigInt(targetDecimals) *
    (input.currency === 'USD' ? usd.denominator : 1n);
  const denominator =
    sourceScale * destination.denominator * (input.currency === 'USD' ? usd.numerator : 1n);
  return formatDisplayUnits(
    (numerator * 2n + denominator) / (2n * denominator),
    targetDecimals,
    input.displayCurrency,
  );
}
