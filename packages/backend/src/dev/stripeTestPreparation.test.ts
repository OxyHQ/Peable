import { expect, test } from 'bun:test';
import {
  createPreparationReader,
  assertLocalPreparationPrice,
  localCheckoutConfiguration,
} from './stripeTestPreparation';
test('public configuration speaks the Orbit wire: snake_case, base-unit strings, Unix seconds', () => {
  const configuration = localCheckoutConfiguration({
    publishableKey: 'pk_test_public',
    merchant: 'merch_local',
    month: 599,
    year: 5750,
    expiresAt: new Date(1_800_000_060_900),
  });
  expect(configuration).toEqual({
    object: 'local_checkout_configuration',
    livemode: false,
    publishable_key: 'pk_test_public',
    merchant: 'merch_local',
    product: 'peable_local_mention_plus',
    currency: 'USD',
    prices: {
      month: { unit_amount: '599', interval: 'month' },
      year: { unit_amount: '5750', interval: 'year' },
    },
    payment_methods: configuration.payment_methods,
    expires_at: 1_800_000_060,
  });
  expect(configuration.payment_methods.map((method) => method.type)).toEqual([
    'card',
    'bank',
    'installments',
    'faircoin',
  ]);
  expect(() =>
    localCheckoutConfiguration({
      publishableKey: 'pk_test_public',
      merchant: 'merch_local',
      month: null,
      year: 5750,
      expiresAt: new Date(),
    }),
  ).toThrow('Unapproved');
});
test('public configuration coalesces warmup reads, expires and revalidates before cached reads', async () => {
  let time = 0;
  let calls = 0;
  let valid = true;
  const read = createPreparationReader(
    async () => ({ version: ++calls }),
    () => time,
    () => {
      if (!valid) throw new Error('changed');
    },
  );
  expect(await Promise.all([read(), read()])).toEqual([{ version: 1 }, { version: 1 }]);
  time = 60_000;
  expect(await read()).toEqual({ version: 2 });
  valid = false;
  expect(() => read()).toThrow('changed');
  expect(calls).toBe(2);
});
test('failed public preparation is never cached as successful availability', async () => {
  let calls = 0;
  const read = createPreparationReader(async () => {
    if (++calls === 1) throw new Error('offline');
    return 'public-config';
  });
  await expect(read()).rejects.toThrow('offline');
  expect(await read()).toBe('public-config');
});

test('public catalogue refuses changed price, currency, product, mode or recurring/tax scope', () => {
  const price = {
    product: 'peable_local_mention_plus',
    livemode: false,
    active: true,
    currency: 'usd',
    unit_amount: 599,
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
  };
  expect(() => assertLocalPreparationPrice('month', price)).not.toThrow();
  for (const patch of [
    { product: 'foreign-product' },
    { livemode: true },
    { active: false },
    { currency: 'eur' },
    { unit_amount: 1 },
    { unit_amount: null },
    { recurring: null },
    { recurring: { interval: 'year', interval_count: 1 } },
    { recurring: { interval: 'month', interval_count: 2 } },
    { tax_behavior: 'exclusive' },
  ])
    expect(() => assertLocalPreparationPrice('month', { ...price, ...patch })).toThrow(
      'Unapproved',
    );
  expect(() => assertLocalPreparationPrice('year', price)).toThrow('Unapproved');
});
