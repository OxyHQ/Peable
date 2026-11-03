import { describe, expect, test } from 'bun:test';
import { checkoutMessage } from '../src/ui/messages';
import { formatCheckoutAmount } from '../src/ui/amount';
describe('checkout display adapter', () => {
  test('preserves quoted currency exponents without FX conversion', () => {
    expect(formatCheckoutAmount(599, 'USD', 'en-US')).toBe('$5.99');
    expect(formatCheckoutAmount(599, 'JPY', 'en-US')).toBe('¥599');
    expect(formatCheckoutAmount(599, 'KWD', 'en-US')).toContain('0.599');
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => formatCheckoutAmount(value, 'USD', 'en')).toThrow();
  });
  test('uses host language, interpolation and explicit copy overrides', () => {
    expect(checkoutMessage('es-ES', 'payMerchant', { merchant: 'Mention' })).toBe(
      'Pagar a Mention',
    );
    expect(checkoutMessage('en', 'payAmount', { amount: '$5.99' })).toBe('Pay $5.99');
    expect(
      checkoutMessage('es', 'result.successHint', undefined, {
        'result.successHint': 'Local preview only',
      }),
    ).toBe('Local preview only');
    expect(checkoutMessage('en', 'title')).toBe('');
  });
});
