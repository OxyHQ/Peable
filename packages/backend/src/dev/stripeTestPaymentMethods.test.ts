import { expect, test } from 'bun:test';
import { localSubscriptionPaymentMethods } from './stripeTestPaymentMethods';
test('offer retains every Peable choice without pretending unconfigured rails work', () => {
  const methods = localSubscriptionPaymentMethods(true);
  expect(methods.map((method) => method.type)).toEqual([
    'card',
    'bank',
    'installments',
    'faircoin',
  ]);
  expect(methods.filter((method) => method.available).map((method) => method.type)).toEqual([
    'card',
  ]);
  expect(methods.find((method) => method.type === 'card')?.unavailable_reason).toBeNull();
  expect(methods.find((method) => method.type === 'faircoin')?.unavailable_reason).toBe(
    'merchant_receive_key_missing',
  );
  expect(
    methods.filter((method) => !method.available).every((method) => !!method.unavailable_reason),
  ).toBe(true);
});
test('provider no longer offering card does not manufacture availability', () => {
  const methods = localSubscriptionPaymentMethods(false);
  expect(methods.some((method) => method.available)).toBe(false);
  expect(methods[0]?.unavailable_reason).toBe('subscription_method_not_configured');
});
