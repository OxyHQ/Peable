/**
 * The FairCoin quote (ADR 0021 D4): exact arithmetic, the one accepted source,
 * freshness by each source's own rule, and failing CLOSED — never a guessed
 * rate. No network: every case installs its own sources.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FaircoinPriceUnavailableError,
  faircoinAvailability,
  faircoinBaseUnitsFor,
  parsePositiveDecimal,
  parsePriceBody,
  parseReferenceRatesBody,
  PRICE_MAX_AGE_MS,
  QUOTE_LIFETIME_MS,
  quoteFaircoin,
  REFERENCE_RATES_MAX_AGE_MS,
  replayFaircoinAmount,
  toFaircoinQuoteDTO,
  useQuoteSources,
} from '../quote';
import { must } from '../../../__tests__/helpers/must';

const NOW = new Date('2026-11-05T20:00:00Z');
let restore: (() => void) | null = null;

function sources(options: {
  usdPerFair?: string;
  priceAt?: Date;
  perEur?: Record<string, string>;
  ratesAt?: Date;
  priceDown?: boolean;
}) {
  restore = useQuoteSources({
    readPrice: async () => {
      if (options.priceDown) throw new Error('connect ECONNREFUSED');
      return { usdPerFair: options.usdPerFair ?? '0.5', observedAt: options.priceAt ?? NOW };
    },
    readReferenceRates: async () => ({
      perEur: options.perEur ?? { EUR: '1', USD: '1.25', JPY: '160' },
      observedAt: options.ratesAt ?? NOW,
    }),
  });
}

afterEach(() => {
  restore?.();
  restore = null;
});

describe('exact arithmetic', () => {
  test('a decimal string is an exact rational; anything else is refused', () => {
    expect(parsePositiveDecimal('0.4908275003129989')).toEqual({
      num: 4908275003129989n,
      den: 10n ** 16n,
    });
    expect(parsePositiveDecimal('4.9e-1')).toEqual({ num: 49n, den: 100n });
    for (const bad of ['0', '-1', '1.', 'abc', '1e999', '0x10', '']) {
      expect(parsePositiveDecimal(bad)).toBeNull();
    }
  });

  test('the FAIR amount is rounded UP to the base unit, so the payee is never paid less', () => {
    // 19.99 USD at 0.49 USD/FAIR = 40.795918367… FAIR → 4079591837 base units.
    const rate = must(parsePositiveDecimal('0.49'));
    expect(faircoinBaseUnitsFor('1999', 'USD', rate)).toBe(4_079_591_837n);
    // An exact division is not rounded: 10.00 USD at 0.5 → 20 FAIR.
    expect(faircoinBaseUnitsFor('1000', 'USD', must(parsePositiveDecimal('0.5')))).toBe(
      2_000_000_000n,
    );
    // A zero-decimal currency scales by 10⁸ (1000 JPY at 80 JPY/FAIR = 12.5 FAIR).
    expect(faircoinBaseUnitsFor('1000', 'JPY', must(parsePositiveDecimal('80')))).toBe(
      1_250_000_000n,
    );
  });
});

describe('the sources', () => {
  test('only the wfair-base price with a positive number and a time is accepted', () => {
    const at = '2026-11-05T20:06:42.864Z';
    expect(
      parsePriceBody(
        JSON.stringify({ price: 0.4908275003129989, source: 'wfair-base', updatedAt: at }),
      ),
    ).toEqual({ usdPerFair: '0.4908275003129989', observedAt: new Date(at) });
    for (const body of [
      { price: 0.49, source: 'coingecko', updatedAt: at },
      { price: 0, source: 'wfair-base', updatedAt: at },
      { price: -1, source: 'wfair-base', updatedAt: at },
      { price: 'NaN', source: 'wfair-base', updatedAt: at },
      { price: 0.49, source: 'wfair-base' },
    ]) {
      expect(() => parsePriceBody(JSON.stringify(body))).toThrow(FaircoinPriceUnavailableError);
    }
    expect(() => parsePriceBody('<html>')).toThrow(FaircoinPriceUnavailableError);
  });

  test("the ECB's daily XML gives every currency per EUR, dated", () => {
    const rates = parseReferenceRatesBody(
      "<Cube><Cube time='2026-11-05'><Cube currency='USD' rate='1.1224'/><Cube currency='GBP' rate='0.83393'/></Cube></Cube>",
    );
    expect(rates.perEur).toEqual({ EUR: '1', USD: '1.1224', GBP: '0.83393' });
    expect(rates.observedAt.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(() => parseReferenceRatesBody('<Cube/>')).toThrow(FaircoinPriceUnavailableError);
  });
});

describe('quoting', () => {
  test('a USD order needs only the FairCoin price; it lives ten minutes', async () => {
    sources({ usdPerFair: '0.5' });
    const quote = await quoteFaircoin('USD', '1999', { now: NOW });
    expect(quote).toMatchObject({
      currency: 'USD',
      amount: '1999',
      faircoinAmount: '3998000000',
      rate: '0.5',
      referenceRates: null,
    });
    expect(quote.expiresAt.getTime() - NOW.getTime()).toBe(QUOTE_LIFETIME_MS);
  });

  test('another fiat currency is crossed through the reference rates, and replays exactly', async () => {
    sources({ usdPerFair: '0.4908275003129989', perEur: { EUR: '1', USD: '1.1224' } });
    const quote = await quoteFaircoin('EUR', '4200', { now: NOW });
    // 42.00 EUR × 1.1224 / 0.4908275003129989 = 96.043518… FAIR, rounded up.
    expect(quote.faircoinAmount).toBe('9604351829');
    expect(quote.rate).toBe('0.4373017644');
    const dto = toFaircoinQuoteDTO(quote);
    expect(dto).toMatchObject({
      currency: 'EUR',
      amount: '4200',
      price: { source: 'wfair-base', usd_per_fair: '0.4908275003129989' },
      reference_rates: { source: 'ecb', usd_per_eur: '1.1224', currency_per_eur: '1' },
    });
    expect(replayFaircoinAmount(dto)).toBe(quote.faircoinAmount);
  });

  test('a stale, missing or unreachable source fails closed — never a guessed rate', async () => {
    sources({ priceAt: new Date(NOW.getTime() - PRICE_MAX_AGE_MS - 1) });
    await expect(quoteFaircoin('USD', '100', { now: NOW })).rejects.toThrow(
      FaircoinPriceUnavailableError,
    );
    restore?.();
    sources({ ratesAt: new Date(NOW.getTime() - REFERENCE_RATES_MAX_AGE_MS - 1) });
    await expect(quoteFaircoin('EUR', '100', { now: NOW })).rejects.toThrow(
      FaircoinPriceUnavailableError,
    );
    // Stale reference rates do not stop a USD order, which never reads them.
    expect((await quoteFaircoin('USD', '100', { now: NOW })).faircoinAmount).toBe('200000000');
    restore?.();
    sources({ perEur: { EUR: '1', USD: '1.25' } });
    await expect(quoteFaircoin('GBP', '100', { now: NOW })).rejects.toThrow('no reference rate');
    restore?.();
    sources({ priceDown: true });
    await expect(quoteFaircoin('USD', '100', { now: NOW })).rejects.toThrow(
      FaircoinPriceUnavailableError,
    );
  });

  test('availability says why FairCoin cannot be paid with, and never hides it', async () => {
    sources({ priceDown: true });
    expect(await faircoinAvailability({ network: null, currency: 'EUR' })).toEqual({
      available: false,
      unavailable_reason: 'faircoin_account_missing',
    });
    expect(await faircoinAvailability({ network: 'mainnet', currency: 'EUR' })).toEqual({
      available: false,
      unavailable_reason: 'price_unavailable',
    });
    // A FAIR order needs no price.
    expect(await faircoinAvailability({ network: 'mainnet', currency: 'FAIR' })).toEqual({
      available: true,
      unavailable_reason: null,
    });
  });
});
