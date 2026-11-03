import { expect, test } from 'bun:test';
import { createPreparationReader, assertLocalPreparationPrice } from './stripeTestPreparation';
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
