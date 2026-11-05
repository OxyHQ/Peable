/**
 * The FairCoin price of a fiat order (ADR 0021 D4) — the ONE reader.
 *
 * FairCoin is offered on every fiat order, so a fiat total needs a FAIR amount.
 * That amount is PRICING, never exchange: the payer's wallet pays FAIR to the
 * payee's own address, and Peable never holds, buys, sells or converts FAIR
 * (AGENTS.md, product boundary). The quote is the label on that payment.
 *
 * ## Two sources, each fresh by its own rule, and no third
 *
 * - **FAIR/USD**: the FairCoin Explorer's `GET /api/price`, accepted only with
 *   `source: 'wfair-base'` (WFAIR/USDC on Base, the reference the wallet shows),
 *   a positive price and an `updatedAt` at most {@link PRICE_MAX_AGE_MS} old.
 * - **USD/other fiat**: the European Central Bank's daily reference rates,
 *   crossed through EUR, accepted only when the set is at most
 *   {@link REFERENCE_RATES_MAX_AGE_MS} old. The Explorer publishes USD only.
 *
 * Anything else — a stale reading, another source, a failed request, a missing
 * currency — fails CLOSED with {@link FaircoinPriceUnavailableError}: FairCoin
 * is unavailable on that order until a fresh price exists, and the card
 * methods are untouched. There is no cached-beyond-freshness, manual,
 * last-known or guessed rate.
 *
 * ## Exact arithmetic
 *
 * Every rate is parsed from its decimal string into a rational, and the FAIR
 * amount is `ceil(fiat × 10⁸ × usd_per_eur ÷ (10^decimals × usd_per_fair ×
 * currency_per_eur))` in `bigint` — no float enters it, and it replays from the
 * stored sources. The stored `rate` is only the display rounding.
 */
import {
  CURRENCY_DECIMALS,
  type FaircoinQuote as FaircoinQuoteDTO,
  type FiatCurrencyCode,
  isBaseUnitString,
} from '@peable.to/shared-types';
import { config } from '../../config';
import { fromUnix, toUnix } from '../../lib/time';

/** How old the Explorer's FAIR/USD reading may be when a quote uses it. */
export const PRICE_MAX_AGE_MS = 120_000;
/** How old the ECB's reference-rate set may be (a weekend plus the TARGET Easter holidays). */
export const REFERENCE_RATES_MAX_AGE_MS = 5 * 24 * 3600_000;
/** How long a quote holds. */
export const QUOTE_LIFETIME_MS = 10 * 60_000;
/** The one Explorer price source Orbit accepts. */
export const PRICE_SOURCE = 'wfair-base';
export const REFERENCE_RATES_SOURCE = 'ecb';
export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

const FAIR_DECIMALS = 8;
/** Bounded so a hostile body cannot make a rational with thousands of digits. */
const MAX_DECIMAL_LENGTH = 40;

/** No fresh price exists for this order right now; FairCoin is unavailable on it until one does. */
export class FaircoinPriceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaircoinPriceUnavailableError';
  }
}

/** The Explorer's FAIR/USD reading. */
export interface PriceReading {
  readonly usdPerFair: string;
  readonly observedAt: Date;
}

/** The ECB's reference set: units of each currency per 1 EUR (`EUR` itself is `1`). */
export interface ReferenceRates {
  readonly perEur: Readonly<Partial<Record<string, string>>>;
  readonly observedAt: Date;
}

export interface QuoteSources {
  readPrice(): Promise<PriceReading>;
  readReferenceRates(): Promise<ReferenceRates>;
}

/** A quote, as the gateway holds it (and stores as `payment_intents.faircoin_quote`). */
export interface FaircoinQuote {
  readonly currency: FiatCurrencyCode;
  /** Base units of `currency` — the order's computed total. */
  readonly amount: string;
  /** FAIR base units (10⁻⁸ FAIR) the payer pays. */
  readonly faircoinAmount: string;
  /** `currency` per 1 FAIR, rounded for display. */
  readonly rate: string;
  readonly price: PriceReading;
  /** `null` for a USD order, which needs no reference rate. */
  readonly referenceRates: {
    readonly usdPerEur: string;
    readonly currencyPerEur: string;
    readonly observedAt: Date;
  } | null;
  readonly quotedAt: Date;
  readonly expiresAt: Date;
}

// ---- Exact decimals ---------------------------------------------------------------

interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

/** A positive decimal string (`0.49`, `1.1224`, `4.9e-1`) as an exact rational; `null` otherwise. */
export function parsePositiveDecimal(value: string): Rational | null {
  if (value.length > MAX_DECIMAL_LENGTH) return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,2}))?$/.exec(value);
  if (!match) return null;
  const digits = `${match[1] ?? ''}${match[2] ?? ''}`;
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  let num = BigInt(digits);
  let den = 1n;
  if (exponent >= 0) num *= 10n ** BigInt(exponent);
  else den = 10n ** BigInt(-exponent);
  return num > 0n ? { num, den } : null;
}

function mustParse(value: string, what: string): Rational {
  const parsed = parsePositiveDecimal(value);
  if (!parsed) throw new FaircoinPriceUnavailableError(`${what} is not a positive decimal`);
  return parsed;
}

/** `currency` per 1 FAIR, as a rational: usd_per_fair × currency_per_eur ÷ usd_per_eur. */
function ratePerFair(
  usdPerFair: Rational,
  cross: { usdPerEur: Rational; currencyPerEur: Rational } | null,
): Rational {
  if (!cross) return usdPerFair;
  return {
    num: usdPerFair.num * cross.currencyPerEur.num * cross.usdPerEur.den,
    den: usdPerFair.den * cross.currencyPerEur.den * cross.usdPerEur.num,
  };
}

/**
 * FAIR base units for `amount` base units of `currency` at `rate` (currency
 * per FAIR), rounded UP to the base unit so the payee is never paid less than
 * the order.
 */
export function faircoinBaseUnitsFor(
  amount: string,
  currency: FiatCurrencyCode,
  rate: Rational,
): bigint {
  if (!isBaseUnitString(amount) || amount === '0')
    throw new Error(`invalid ${currency} amount: ${amount}`);
  // fair = amount / 10^dec / (num/den) * 10^8 = amount * den * 10^(8-dec) / num
  const scale = FAIR_DECIMALS - CURRENCY_DECIMALS[currency];
  let dividend = BigInt(amount) * rate.den;
  let divisor = rate.num;
  if (scale >= 0) dividend *= 10n ** BigInt(scale);
  else divisor *= 10n ** BigInt(-scale);
  return (dividend + divisor - 1n) / divisor;
}

/** A rational as a decimal string with `significant` significant digits (display only). */
function displayDecimal(value: Rational, significant = 10): string {
  let exponent = 0;
  let { num } = value;
  const { den } = value;
  // Scale so the integer part has `significant` digits.
  while (num / den >= 10n ** BigInt(significant)) {
    num /= 10n;
    exponent += 1;
  }
  while (num / den < 10n ** BigInt(significant - 1)) {
    num *= 10n;
    exponent -= 1;
  }
  const rounded = (num * 2n + den) / (2n * den);
  let digits = rounded.toString();
  if (exponent >= 0) return `${digits}${'0'.repeat(exponent)}`;
  const point = digits.length + exponent;
  if (point <= 0) digits = `${'0'.repeat(1 - point)}${digits}`;
  const at = digits.length + exponent;
  const fraction = digits.slice(at).replace(/0+$/, '');
  return fraction ? `${digits.slice(0, at)}.${fraction}` : digits.slice(0, at);
}

// ---- The sources ------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8000;
/** A reading is reused at most this long, and only while still fresh by its own rule. */
const PRICE_REUSE_MS = 15_000;
const REFERENCE_RATES_REUSE_MS = 3600_000;

async function fetchBody(url: string, accept: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
    headers: { Accept: accept, 'User-Agent': 'Peable/1.0' },
  });
  if (!response.ok) {
    throw new FaircoinPriceUnavailableError(`${url} answered ${String(response.status)}`);
  }
  return response.text();
}

/** The Explorer's reading, refused unless it is the one accepted source with a positive price. */
export function parsePriceBody(text: string): PriceReading {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FaircoinPriceUnavailableError('the FairCoin price is not JSON');
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (record.source !== PRICE_SOURCE) {
    throw new FaircoinPriceUnavailableError('the FairCoin price is not from the accepted source');
  }
  const price = record.price;
  const raw =
    typeof price === 'number' && Number.isFinite(price) && price > 0
      ? String(price)
      : typeof price === 'string'
        ? price
        : null;
  if (raw === null || !parsePositiveDecimal(raw)) {
    throw new FaircoinPriceUnavailableError('the FairCoin price is not a positive number');
  }
  const observed = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : Number.NaN;
  if (!Number.isFinite(observed)) {
    throw new FaircoinPriceUnavailableError('the FairCoin price has no observation time');
  }
  return { usdPerFair: raw, observedAt: new Date(observed) };
}

/** The ECB's daily XML: `<Cube time='YYYY-MM-DD'>` and `<Cube currency='USD' rate='1.1224'/>`. */
export function parseReferenceRatesBody(text: string): ReferenceRates {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(text)?.[1];
  if (!date) throw new FaircoinPriceUnavailableError('the reference rates carry no date');
  const perEur: Record<string, string> = { EUR: '1' };
  for (const match of text.matchAll(
    /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g,
  )) {
    const [, code, rate] = match;
    if (code && rate && parsePositiveDecimal(rate)) perEur[code] = rate;
  }
  // The reference rates are set at 16:00 CET; the date is the day they hold for.
  return { perEur, observedAt: new Date(`${date}T15:00:00Z`) };
}

function cached<T extends { observedAt: Date }>(read: () => Promise<T>, reuseMs: number) {
  let last: { value: T; at: number } | null = null;
  return async (): Promise<T> => {
    if (last && Date.now() - last.at < reuseMs) return last.value;
    const value = await read();
    last = { value, at: Date.now() };
    return value;
  };
}

/** The real sources: the Explorer and the ECB, each reading reused briefly. */
export function liveQuoteSources(): QuoteSources {
  return {
    readPrice: cached(
      async () =>
        parsePriceBody(await fetchBody(`${config.explorerBaseUrl}/api/price`, 'application/json')),
      PRICE_REUSE_MS,
    ),
    readReferenceRates: cached(
      async () => parseReferenceRatesBody(await fetchBody(ECB_DAILY_URL, 'application/xml')),
      REFERENCE_RATES_REUSE_MS,
    ),
  };
}

let sources: QuoteSources | null = null;

function currentSources(): QuoteSources {
  sources ??= liveQuoteSources();
  return sources;
}

/** Replace the sources (tests); answers a function that restores the previous ones. */
export function useQuoteSources(next: QuoteSources): () => void {
  const previous = sources;
  sources = next;
  return () => {
    sources = previous;
  };
}

async function readOrUnavailable<T>(read: () => Promise<T>, what: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof FaircoinPriceUnavailableError) throw error;
    throw new FaircoinPriceUnavailableError(
      `${what} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- Quoting ----------------------------------------------------------------------

/**
 * Quote `amount` base units of `currency` in FAIR, now.
 *
 * @throws {FaircoinPriceUnavailableError} when either source is missing, stale
 *   or malformed, or the currency has no reference rate.
 */
export async function quoteFaircoin(
  currency: FiatCurrencyCode,
  amount: string,
  options: { now?: Date } = {},
): Promise<FaircoinQuote> {
  const now = options.now ?? new Date();
  const source = currentSources();
  const price = await readOrUnavailable(() => source.readPrice(), 'the FairCoin price');
  const age = now.getTime() - price.observedAt.getTime();
  if (age > PRICE_MAX_AGE_MS || age < -1000) {
    throw new FaircoinPriceUnavailableError('the FairCoin price is not fresh');
  }
  let referenceRates: FaircoinQuote['referenceRates'] = null;
  if (currency !== 'USD') {
    const rates = await readOrUnavailable(() => source.readReferenceRates(), 'the reference rates');
    const ratesAge = now.getTime() - rates.observedAt.getTime();
    if (ratesAge > REFERENCE_RATES_MAX_AGE_MS) {
      throw new FaircoinPriceUnavailableError('the reference rates are not fresh');
    }
    const usdPerEur = rates.perEur.USD;
    const currencyPerEur = rates.perEur[currency];
    if (!usdPerEur || !currencyPerEur) {
      throw new FaircoinPriceUnavailableError(`no reference rate for ${currency}`);
    }
    referenceRates = { usdPerEur, currencyPerEur, observedAt: rates.observedAt };
  }
  const rate = rateOf(price.usdPerFair, referenceRates);
  return {
    currency,
    amount,
    faircoinAmount: faircoinBaseUnitsFor(amount, currency, rate).toString(),
    rate: displayDecimal(rate),
    price,
    referenceRates,
    quotedAt: now,
    expiresAt: new Date(now.getTime() + QUOTE_LIFETIME_MS),
  };
}

function rateOf(usdPerFair: string, cross: FaircoinQuote['referenceRates']): Rational {
  return ratePerFair(
    mustParse(usdPerFair, 'the FairCoin price'),
    cross
      ? {
          usdPerEur: mustParse(cross.usdPerEur, 'the USD reference rate'),
          currencyPerEur: mustParse(cross.currencyPerEur, 'the reference rate'),
        }
      : null,
  );
}

/** Whether a quote in `currency` can be made now — what an order shows before the payer chooses. */
export async function faircoinPriceAvailable(currency: FiatCurrencyCode): Promise<boolean> {
  try {
    await quoteFaircoin(currency, '1');
    return true;
  } catch (error) {
    if (error instanceof FaircoinPriceUnavailableError) return false;
    throw error;
  }
}

/** The FAIR amount a stored quote's sources give — the replay a reviewer can run. */
export function replayFaircoinAmount(quote: FaircoinQuoteDTO): string {
  return faircoinBaseUnitsFor(
    quote.amount,
    quote.currency,
    rateOf(
      quote.price.usd_per_fair,
      quote.reference_rates
        ? {
            usdPerEur: quote.reference_rates.usd_per_eur,
            currencyPerEur: quote.reference_rates.currency_per_eur,
            observedAt: fromUnix(quote.reference_rates.observed_at),
          }
        : null,
    ),
  ).toString();
}

// ---- The wire ----------------------------------------------------------------------

/** The quote as the wire (and `payment_intents.faircoin_quote`) holds it. */
export function toFaircoinQuoteDTO(quote: FaircoinQuote): FaircoinQuoteDTO {
  return {
    currency: quote.currency,
    amount: quote.amount,
    rate: quote.rate,
    price: {
      source: PRICE_SOURCE,
      usd_per_fair: quote.price.usdPerFair,
      observed_at: toUnix(quote.price.observedAt),
    },
    reference_rates: quote.referenceRates
      ? {
          source: REFERENCE_RATES_SOURCE,
          usd_per_eur: quote.referenceRates.usdPerEur,
          currency_per_eur: quote.referenceRates.currencyPerEur,
          observed_at: toUnix(quote.referenceRates.observedAt),
        }
      : null,
    quoted_at: toUnix(quote.quotedAt),
    expires_at: toUnix(quote.expiresAt),
  };
}
