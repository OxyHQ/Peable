/**
 * Read-only display values. Never use these estimates to authorize a payment.
 *
 * This entry is imported by every Oxy app's startup bundle (through
 * `@oxy.so/services`), and Metro does not tree-shake: it imports nothing but
 * `./core/timeoutSignal`, which itself imports nothing.
 * `@fairco.in/core` exposes only its root barrel, which drags in the whole
 * wallet stack, so the Explorer origin is restated here and a test pins it to
 * the core constant.
 */

import { timeoutSignal } from './core/timeoutSignal';

/** Same value as `EXPLORER_BASE_URL` in `@fairco.in/core`. */
const DISPLAY_RATES_ORIGIN = 'https://explorer.fairco.in';
const DISPLAY_RATES_TIMEOUT_MS = 8000;
const ECB_RATES_URL =
  'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata';
const ECB_RATES_TIMEOUT_MS = 2500;
const ECB_RATE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export const DISPLAY_CURRENCIES = ['USD', 'EUR', 'FAIR'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];
export interface DisplayRates {
  /** Currency units per FAIR, as exact decimal strings. */
  usdPerFair: string;
  /** EUR per FAIR, rounded to 18 decimal places; null when the ECB quote is unavailable. */
  eurPerFair: string | null;
  /** USD per EUR from the ECB; absent when no fresh official observation is available. */
  eurReference?: {
    usdPerEur: string;
    source: string;
    observedAt: string;
    expiresAt: string;
  } | null;
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

function decimal(numerator: bigint, denominator: bigint, places = 18): string {
  if (numerator <= 0n || denominator <= 0n) throw new Error('Invalid display rate');
  const scale = 10n ** BigInt(places);
  const rounded = (numerator * scale * 2n + denominator) / (2n * denominator);
  const whole = rounded / scale;
  const fractional = (rounded % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole.toString();
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

function ecbReferenceIsFresh(
  reference: NonNullable<DisplayRates['eurReference']>,
  now: number,
): boolean {
  const observed = Date.parse(reference.observedAt);
  const expires = Date.parse(reference.expiresAt);
  return (
    Number.isFinite(observed) &&
    observed <= now + 1000 &&
    observed >= now - ECB_RATE_MAX_AGE_MS &&
    expires > now &&
    expires === observed + ECB_RATE_MAX_AGE_MS
  );
}

/** Parse just the columns needed from the ECB's CSV response, preserving quoted CSV fields. */
function csvRecords(csv: string): string[][] {
  if (csv.length > 64_000) throw new Error('Exchange rate unavailable');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') {
      if (field) throw new Error('Exchange rate unavailable');
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('Exchange rate unavailable');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}

async function readEcbReference(
  fetcher: typeof fetch,
  parentSignal: AbortSignal | undefined,
  now: number,
): Promise<DisplayRates['eurReference']> {
  const request = timeoutSignal(
    ECB_RATES_TIMEOUT_MS,
    parentSignal,
    'ECB exchange rate request timed out',
  );
  try {
    const response = await fetcher(ECB_RATES_URL, {
      signal: request.signal,
      redirect: 'error',
      headers: { Accept: 'text/csv' },
    });
    if (!response.ok) return null;
    const rows = csvRecords(await response.text());
    const header = rows[0];
    const observation = rows[1];
    if (
      !header ||
      !observation ||
      rows.length !== 2 ||
      header[0] !== 'KEY' ||
      header[6] !== 'TIME_PERIOD' ||
      header[7] !== 'OBS_VALUE' ||
      header[8] !== 'OBS_STATUS' ||
      observation[0] !== 'EXR.D.USD.EUR.SP00.A' ||
      observation[1] !== 'D' ||
      observation[2] !== 'USD' ||
      observation[3] !== 'EUR' ||
      observation[4] !== 'SP00' ||
      observation[5] !== 'A' ||
      observation[8] !== 'A'
    )
      return null;
    const day = observation[6];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return null;
    const observed = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(observed) || new Date(observed).toISOString().slice(0, 10) !== day)
      return null;
    const usdPerEur = observation[7];
    if (!usdPerEur || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(usdPerEur)) return null;
    const parsedUsdPerEur = fraction(usdPerEur);
    if (
      parsedUsdPerEur.numerator * 10n < parsedUsdPerEur.denominator ||
      parsedUsdPerEur.numerator > parsedUsdPerEur.denominator * 10n
    )
      return null;
    const reference = {
      usdPerEur,
      source: ECB_RATES_URL,
      observedAt: new Date(observed).toISOString(),
      expiresAt: new Date(observed + ECB_RATE_MAX_AGE_MS).toISOString(),
    };
    return ecbReferenceIsFresh(reference, now) ? reference : null;
  } catch {
    // USD/FAIR remain available if ECB is down or returns an unusable observation.
    return null;
  } finally {
    request.dispose();
  }
}

/** Uses the owning FairCoin source; no cached fallback after expiry or failure.
 * Set `includeEur` only for EUR display: the ECB request is optional, separate,
 * and bounded so USD/FAIR-only views do not wait on it.
 */
export async function readDisplayRates(
  options: { fetch?: typeof fetch; signal?: AbortSignal; now?: number; includeEur?: boolean } = {},
): Promise<DisplayRates> {
  const source = `${DISPLAY_RATES_ORIGIN}/api/price`;
  const now = options.now ?? Date.now();
  const fetcher = options.fetch ?? fetch;
  const eurReferencePromise = options.includeEur
    ? readEcbReference(fetcher, options.signal, now)
    : Promise.resolve(null);
  const request = timeoutSignal(
    DISPLAY_RATES_TIMEOUT_MS,
    options.signal,
    'Exchange rate request timed out',
  );
  let body: unknown;
  try {
    const response = await fetcher(source, {
      signal: request.signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Exchange rate unavailable');
    body = await response.json();
  } finally {
    request.dispose();
  }
  if (!body || typeof body !== 'object' || !('price' in body) || !('updatedAt' in body))
    throw new Error('Exchange rate unavailable');
  const price = body.price;
  if (
    (typeof price !== 'number' && typeof price !== 'string') ||
    !('source' in body) ||
    body.source !== 'wfair-base' ||
    typeof body.updatedAt !== 'string'
  )
    throw new Error('Exchange rate unavailable');
  const usdPerFair = String(price);
  fraction(usdPerFair);
  const observed = Date.parse(body.updatedAt);
  if (!Number.isFinite(observed)) throw new Error('Exchange rate unavailable');
  const receivedEurReference = await eurReferencePromise;
  const eurReference = receivedEurReference
    ? ecbReferenceIsFresh(receivedEurReference, options.now ?? Date.now())
      ? receivedEurReference
      : null
    : null;
  const usd = fraction(usdPerFair);
  const eurPerFair = eurReference
    ? decimal(
        usd.numerator * fraction(eurReference.usdPerEur).denominator,
        usd.denominator * fraction(eurReference.usdPerEur).numerator,
      )
    : null;
  const rates = {
    usdPerFair,
    eurPerFair,
    eurReference,
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
  if (input.displayCurrency === 'EUR') {
    const reference = input.rates.eurReference;
    const now = input.now ?? Date.now();
    if (!reference || !ecbReferenceIsFresh(reference, now)) return null;
    const usdPerEur = fraction(reference.usdPerEur);
    const usdPerFair = fraction(input.rates.usdPerFair);
    const numerator =
      units *
      (input.currency === 'FAIR' ? usdPerFair.numerator : 1n) *
      usdPerEur.denominator *
      100n;
    const denominator =
      sourceScale * (input.currency === 'FAIR' ? usdPerFair.denominator : 1n) * usdPerEur.numerator;
    return formatDisplayUnits(
      (numerator * 2n + denominator) / (2n * denominator),
      targetDecimals,
      input.displayCurrency,
    );
  }
  const destinationRate = input.rates.usdPerFair;
  const usd = fraction(input.rates.usdPerFair);
  const destination =
    input.displayCurrency === 'FAIR'
      ? { numerator: 1n, denominator: 1n }
      : fraction(destinationRate);
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
