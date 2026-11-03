import { describe, expect, it } from 'bun:test';
import type { Product } from '@peable.to/shared-types';
import {
  buildCreatePriceBody,
  buildCreateProductBody,
  buildPriceData,
  buildUpdateProductBody,
  decimalToBaseUnits,
  EMPTY_PRICE_FORM,
  EMPTY_PRODUCT_FORM,
  formatPriceLabel,
  productFormOf,
} from './productForm';

const PRODUCT: Product = {
  id: 'prod_1',
  object: 'product',
  livemode: false,
  active: true,
  name: 'Plus',
  description: 'Everything',
  images: [],
  metadata: {},
  tax_code: null,
  default_price: null,
  unit_label: null,
  url: null,
  statement_descriptor: 'PLUS',
  marketing_features: [],
  created: 1,
  updated: 1,
};

describe('decimalToBaseUnits', () => {
  it('moves digits by the currency decimals, exactly', () => {
    expect(decimalToBaseUnits('19.99', 'EUR')).toBe('1999');
    expect(decimalToBaseUnits('19.9', 'EUR')).toBe('1990');
    expect(decimalToBaseUnits('19', 'USD')).toBe('1900');
    expect(decimalToBaseUnits(' 0.5 ', 'EUR')).toBe('50');
    expect(decimalToBaseUnits('0', 'EUR')).toBe('0');
    expect(decimalToBaseUnits('0.00', 'EUR')).toBe('0');
    expect(decimalToBaseUnits('007.10', 'EUR')).toBe('710');
    expect(decimalToBaseUnits('1.', 'EUR')).toBe('100');
  });

  it('keeps FAIR exact at eight decimals and beyond a float', () => {
    expect(decimalToBaseUnits('1', 'FAIR')).toBe('100000000');
    expect(decimalToBaseUnits('0.00000001', 'FAIR')).toBe('1');
    expect(decimalToBaseUnits('123456789.12345678', 'FAIR')).toBe('12345678912345678');
  });

  it('refuses more decimals than the currency, signs, separators and words', () => {
    for (const text of ['19.999', '-1', '1,50', '1e3', 'abc', '', '.5', '0.000000001']) {
      expect([text, decimalToBaseUnits(text, text === '0.000000001' ? 'FAIR' : 'EUR')]).toEqual([
        text,
        null,
      ]);
    }
  });
});

describe('buildPriceData', () => {
  it('a monthly price leaves interval_count and tax_behavior to their defaults', () => {
    expect(buildPriceData({ ...EMPTY_PRICE_FORM, amount: '4.99' })).toEqual({
      ok: true,
      body: { currency: 'EUR', unit_amount: '499', recurring: { interval: 'month' } },
    });
  });

  it('a quarterly, tax-inclusive price says both', () => {
    expect(
      buildPriceData({
        ...EMPTY_PRICE_FORM,
        amount: '12.50',
        intervalCount: '3',
        taxBehavior: 'inclusive',
      }),
    ).toEqual({
      ok: true,
      body: {
        currency: 'EUR',
        unit_amount: '1250',
        recurring: { interval: 'month', interval_count: 3 },
        tax_behavior: 'inclusive',
      },
    });
  });

  it('a one-time price has no recurring', () => {
    expect(
      buildPriceData({ ...EMPTY_PRICE_FORM, type: 'one_time', currency: 'FAIR', amount: '2' }),
    ).toEqual({ ok: true, body: { currency: 'FAIR', unit_amount: '200000000' } });
  });

  it('names the field a person got wrong', () => {
    expect(buildPriceData({ ...EMPTY_PRICE_FORM, amount: '1.234' })).toEqual({
      ok: false,
      error: 'amount',
    });
    expect(buildPriceData({ ...EMPTY_PRICE_FORM, amount: '1', intervalCount: '0' })).toEqual({
      ok: false,
      error: 'intervalCount',
    });
    expect(buildPriceData({ ...EMPTY_PRICE_FORM, amount: '1', intervalCount: '1.5' })).toEqual({
      ok: false,
      error: 'intervalCount',
    });
  });
});

describe('buildCreatePriceBody', () => {
  it('names the product it prices', () => {
    expect(
      buildCreatePriceBody('prod_1', { ...EMPTY_PRICE_FORM, type: 'one_time', amount: '3' }),
    ).toEqual({ ok: true, body: { product: 'prod_1', currency: 'EUR', unit_amount: '300' } });
  });
});

describe('buildCreateProductBody', () => {
  it('trims, omits empty optionals, and adds a first price when given', () => {
    expect(
      buildCreateProductBody(
        { ...EMPTY_PRODUCT_FORM, name: ' Plus ', description: '  ', unitLabel: 'seat' },
        { ...EMPTY_PRICE_FORM, amount: '5' },
      ),
    ).toEqual({
      ok: true,
      body: {
        name: 'Plus',
        unit_label: 'seat',
        default_price_data: {
          currency: 'EUR',
          unit_amount: '500',
          recurring: { interval: 'month' },
        },
      },
    });
    expect(buildCreateProductBody({ ...EMPTY_PRODUCT_FORM, name: 'Plus' }, null)).toEqual({
      ok: true,
      body: { name: 'Plus' },
    });
  });

  it('refuses a missing name or a bad first price', () => {
    expect(buildCreateProductBody(EMPTY_PRODUCT_FORM, null)).toEqual({ ok: false, error: 'name' });
    expect(
      buildCreateProductBody({ ...EMPTY_PRODUCT_FORM, name: 'Plus' }, EMPTY_PRICE_FORM),
    ).toEqual({ ok: false, error: 'amount' });
  });
});

describe('buildUpdateProductBody', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildUpdateProductBody(productFormOf(PRODUCT), PRODUCT)).toEqual({ ok: true, body: {} });
  });

  it("sends what changed, and '' for a field that was emptied", () => {
    expect(
      buildUpdateProductBody(
        { name: 'Plus+', description: '', unitLabel: 'seat', statementDescriptor: 'PLUS' },
        PRODUCT,
      ),
    ).toEqual({ ok: true, body: { name: 'Plus+', description: '', unit_label: 'seat' } });
  });

  it('refuses an empty name', () => {
    expect(buildUpdateProductBody({ ...productFormOf(PRODUCT), name: ' ' }, PRODUCT)).toEqual({
      ok: false,
      error: 'name',
    });
  });
});

describe('formatPriceLabel', () => {
  const base = {
    unit_amount: '1999',
    currency: 'EUR' as const,
    recurring: null,
    billing_scheme: 'per_unit' as const,
    tiers_mode: null,
  };

  it('reads one-time, per-interval and every-n-intervals prices', () => {
    expect(formatPriceLabel(base)).toBe('19.99 EUR');
    expect(
      formatPriceLabel({
        ...base,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      }),
    ).toBe('19.99 EUR / month');
    expect(
      formatPriceLabel({
        ...base,
        unit_amount: '1250',
        recurring: { interval: 'month', interval_count: 3, usage_type: 'licensed' },
      }),
    ).toBe('12.50 EUR every 3 months');
    expect(formatPriceLabel({ ...base, currency: 'FAIR', unit_amount: '150000000' })).toBe(
      '1.50 FAIR',
    );
  });

  it('names a tiered price by its mode', () => {
    expect(
      formatPriceLabel({
        ...base,
        unit_amount: null,
        billing_scheme: 'tiered',
        tiers_mode: 'graduated',
      }),
    ).toBe('Tiered (graduated) · EUR');
  });
});
