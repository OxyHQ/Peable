import { expect, test } from 'bun:test';
import { localSubscriptionPaymentMethods } from './stripeTestPaymentMethods';
test('offer retains every Peable choice without pretending unconfigured rails work', () => {
  const methods = localSubscriptionPaymentMethods(true);
  expect(methods.map((method) => method.id)).toEqual(['card', 'bank', 'installments', 'faircoin']);
  expect(methods.filter((method) => method.available).map((method) => method.id)).toEqual(['card']);
  expect(methods.find((method) => method.id === 'faircoin')?.reason).toBe(
    'merchant_receive_key_missing',
  );
  expect(methods.filter((method) => !method.available).every((method) => !!method.reason)).toBe(
    true,
  );
});
test('provider no longer offering card does not manufacture availability', () => {
  expect(localSubscriptionPaymentMethods(false).some((method) => method.available)).toBe(false);
});
