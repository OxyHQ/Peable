/**
 * The shared price validators: one shape rule, one `param`, wherever a price
 * is described (`POST /v1/prices`, `default_price_data`, `price_data`).
 */
import { describe, expect, test } from 'bun:test';
import { paramFromPath } from '../../../lib/http';
import { amountForQuantity } from '../pricing';
import { pricingPriceOfShape } from '../pricingRows';
import {
  createPriceBodySchema,
  defaultPriceDataSchema,
  generatePromotionCode,
  maxBaseUnits,
  percentOffSchema,
  priceDataSchema,
} from '../params';

/** The `param` the gateway would answer for the first issue (`sendValidationError`'s rule). */
function firstParam(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; keys?: string[] }[] };
}) {
  expect(result.success).toBe(false);
  const issue = result.error?.issues[0];
  const unknownKey = issue?.keys?.[0];
  const path = issue?.path ?? [];
  return paramFromPath(unknownKey === undefined ? path : [...path, unknownKey]);
}

describe('createPriceBodySchema', () => {
  test('a per-unit one-time price', () => {
    const parsed = createPriceBodySchema.parse({
      product: 'prod_1',
      currency: 'EUR',
      unit_amount: '1999',
    });
    expect(parsed.shape).toEqual({
      currency: 'EUR',
      unitAmount: '1999',
      billingScheme: 'per_unit',
      tiers: null,
      tiersMode: null,
      transformQuantity: null,
      recurring: null,
      taxBehavior: 'unspecified',
    });
  });

  test('a recurring price defaults to one interval, licensed', () => {
    const parsed = createPriceBodySchema.parse({
      product: 'prod_1',
      currency: 'USD',
      unit_amount: '500',
      recurring: { interval: 'month' },
      tax_behavior: 'exclusive',
    });
    expect(parsed.shape.recurring).toEqual({
      interval: 'month',
      intervalCount: 1,
      usageType: 'licensed',
    });
    expect(parsed.shape.taxBehavior).toBe('exclusive');
  });

  test('a tiered price stores its tiers with the open tier as null', () => {
    const parsed = createPriceBodySchema.parse({
      product: 'prod_1',
      currency: 'EUR',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: 10, unit_amount: '100' },
        { up_to: 'inf', unit_amount: '80', flat_amount: '500' },
      ],
    });
    expect(parsed.shape.tiers).toEqual([
      { up_to: 10, unit_amount: '100', flat_amount: null },
      { up_to: null, unit_amount: '80', flat_amount: '500' },
    ]);
    expect(amountForQuantity(pricingPriceOfShape(parsed.shape), 12n)).toBe(1000n + 160n + 500n);
  });

  test('amounts are base-unit strings, never numbers or decimals', () => {
    for (const unit_amount of [1999, '19.99', '-1', '01']) {
      expect(
        firstParam(
          createPriceBodySchema.safeParse({ product: 'prod_1', currency: 'EUR', unit_amount }),
        ),
      ).toBe('unit_amount');
    }
  });

  test('amounts are bounded per currency by its decimals', () => {
    expect(maxBaseUnits('EUR')).toBe(99_999_999_999n);
    expect(maxBaseUnits('FAIR')).toBe(99_999_999_999_999_999n);
    const over = (currency: 'EUR' | 'FAIR') =>
      createPriceBodySchema.safeParse({
        product: 'prod_1',
        currency,
        unit_amount: String(maxBaseUnits(currency) + 1n),
      });
    expect(firstParam(over('EUR'))).toBe('unit_amount');
    expect(firstParam(over('FAIR'))).toBe('unit_amount');
    expect(
      createPriceBodySchema.safeParse({
        product: 'prod_1',
        currency: 'FAIR',
        unit_amount: String(maxBaseUnits('FAIR')),
      }).success,
    ).toBe(true);
  });

  test('names the field of each shape rule it breaks', () => {
    const base = { product: 'prod_1', currency: 'EUR' };
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'unit_amount'],
      [{ unit_amount: '1', tiers: [{ up_to: 'inf', unit_amount: '1' }] }, 'tiers'],
      [{ unit_amount: '1', tiers_mode: 'volume' }, 'tiers_mode'],
      [{ billing_scheme: 'tiered', tiers_mode: 'volume' }, 'tiers'],
      [{ billing_scheme: 'tiered', tiers: [{ up_to: 'inf', unit_amount: '1' }] }, 'tiers_mode'],
      [
        {
          billing_scheme: 'tiered',
          tiers_mode: 'volume',
          unit_amount: '1',
          tiers: [{ up_to: 'inf', unit_amount: '1' }],
        },
        'unit_amount',
      ],
      [
        {
          billing_scheme: 'tiered',
          tiers_mode: 'volume',
          tiers: [{ up_to: 5, unit_amount: '1' }],
        },
        'tiers[0][up_to]',
      ],
      [
        {
          billing_scheme: 'tiered',
          tiers_mode: 'volume',
          tiers: [
            { up_to: 'inf', unit_amount: '1' },
            { up_to: 'inf', unit_amount: '1' },
          ],
        },
        'tiers[0][up_to]',
      ],
      [
        {
          billing_scheme: 'tiered',
          tiers_mode: 'volume',
          tiers: [
            { up_to: 5, unit_amount: '1' },
            { up_to: 5, unit_amount: '1' },
            { up_to: 'inf', unit_amount: '1' },
          ],
        },
        'tiers[1][up_to]',
      ],
      [{ billing_scheme: 'tiered', tiers_mode: 'volume', tiers: [{ up_to: 'inf' }] }, 'tiers[0]'],
      [
        {
          billing_scheme: 'tiered',
          tiers_mode: 'volume',
          tiers: [{ up_to: 'inf', unit_amount: '1' }],
          transform_quantity: { divide_by: 10, round: 'up' },
        },
        'transform_quantity',
      ],
      [
        { unit_amount: '1', recurring: { interval: 'month', interval_count: 37 } },
        'recurring[interval_count]',
      ],
      [
        { unit_amount: '1', recurring: { interval: 'day', interval_count: 1096 } },
        'recurring[interval_count]',
      ],
      [
        { unit_amount: '1', recurring: { interval: 'month', usage_type: 'metered' } },
        'recurring[usage_type]',
      ],
      [{ unit_amount: '1', currency: 'BRL' }, 'currency'],
      [{ unit_amount: '1', transfer_lookup_key: true }, 'transfer_lookup_key'],
      [{ unit_amount: '1', unknown: true }, 'unknown'],
    ];
    for (const [body, param] of cases) {
      expect([body, firstParam(createPriceBodySchema.safeParse({ ...base, ...body }))]).toEqual([
        body,
        param,
      ]);
    }
  });

  test('the longest intervals are exactly three years', () => {
    for (const [interval, interval_count] of [
      ['day', 1095],
      ['week', 156],
      ['month', 36],
      ['year', 3],
    ] as const) {
      expect(
        createPriceBodySchema.safeParse({
          product: 'prod_1',
          currency: 'EUR',
          unit_amount: '1',
          recurring: { interval, interval_count },
        }).success,
      ).toBe(true);
    }
  });
});

describe('price_data and default_price_data', () => {
  test('price_data names its product and is per-unit only', () => {
    const parsed = priceDataSchema.parse({
      product: 'prod_1',
      currency: 'EUR',
      unit_amount: '250',
      recurring: { interval: 'year' },
    });
    expect(parsed.product).toBe('prod_1');
    expect(parsed.shape.recurring?.interval).toBe('year');
    expect(amountForQuantity(pricingPriceOfShape(parsed.shape), 4n)).toBe(1000n);
    expect(firstParam(priceDataSchema.safeParse({ product: 'prod_1', currency: 'EUR' }))).toBe(
      'unit_amount',
    );
    expect(
      firstParam(
        priceDataSchema.safeParse({
          product: 'prod_1',
          currency: 'EUR',
          unit_amount: '1',
          billing_scheme: 'tiered',
        }),
      ),
    ).toBe('billing_scheme');
  });

  test('default_price_data takes no product', () => {
    expect(
      defaultPriceDataSchema.parse({ currency: 'FAIR', unit_amount: '100000000' }),
    ).toMatchObject({ currency: 'FAIR', unitAmount: '100000000', billingScheme: 'per_unit' });
    expect(
      firstParam(
        defaultPriceDataSchema.safeParse({ currency: 'EUR', unit_amount: '1', product: 'prod_1' }),
      ),
    ).toBe('product');
  });
});

describe('percent_off', () => {
  test('is basis points with at most two decimals', () => {
    expect(percentOffSchema.parse(12.5)).toBe(1250);
    expect(percentOffSchema.parse(33.33)).toBe(3333);
    expect(percentOffSchema.parse(100)).toBe(10_000);
    expect(percentOffSchema.parse(0.01)).toBe(1);
    for (const bad of [0, -1, 100.01, 33.333]) {
      expect(percentOffSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('generatePromotionCode', () => {
  test('is eight readable characters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generatePromotionCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });
});
