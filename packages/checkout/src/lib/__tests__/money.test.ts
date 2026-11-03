import { expect, test } from 'bun:test';
import { fieldErrorOf, normalizeParam } from '../apiError';
import { formatAmount } from '../money';

test('base units are formatted in the page locale, exactly', () => {
  expect(formatAmount('1999', 'EUR', 'en')).toBe('€19.99');
  expect(formatAmount('1999', 'EUR', 'de')).toBe('19,99\u00a0€');
  expect(formatAmount('5', 'USD', 'en')).toBe('$0.05');
  expect(formatAmount('100000000', 'FAIR', 'en')).toBe('1 FAIR');
  expect(formatAmount('150000000', 'FAIR', 'es')).toBe('1.5 FAIR');
});

test('a gateway param in bracket notation is the same field as its dotted name', () => {
  expect(normalizeParam('customer_details[address][line1]')).toBe('customer_details.address.line1');
  expect(normalizeParam('line_items[0][quantity]')).toBe('line_items.0.quantity');
  expect(normalizeParam('customer_details.email')).toBe('customer_details.email');
});

test('a refusal keeps its message and names its field', () => {
  const error = Object.assign(new Error('Enter your email.'), { param: 'customer_details[email]' });
  expect(fieldErrorOf(error, 'fallback')).toEqual({
    param: 'customer_details.email',
    message: 'Enter your email.',
  });
  expect(fieldErrorOf('nope', 'fallback')).toEqual({ param: null, message: 'fallback' });
});
