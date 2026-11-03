import { expect, test } from 'bun:test';
import { localInvoiceQuote } from './stripeTestInvoiceQuote';
test('actual inclusive invoice amounts remain one total, as base-unit strings', () => {
  expect(
    localInvoiceQuote(
      {
        total: 599,
        total_excluding_tax: 557,
        total_taxes: [{ amount: 42, tax_behavior: 'inclusive' }],
      },
      'inclusive',
    ),
  ).toEqual({ amount_subtotal: '557', amount_tax: '42', amount_total: '599', inclusive: true });
});
test('recorded zero is distinct from absent provider tax evidence', () => {
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 599, total_taxes: [] }, 'inclusive')
      ?.amount_tax,
  ).toBe('0');
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: null, total_taxes: [] }, 'inclusive'),
  ).toBeNull();
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 599, total_taxes: null }, 'inclusive'),
  ).toBeNull();
});
test('conflicting amounts or exclusive treatment are omitted, never invented', () => {
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 557, total_taxes: [] }, 'inclusive'),
  ).toBeNull();
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 599, total_taxes: [] }, 'exclusive'),
  ).toBeNull();
  expect(
    localInvoiceQuote(
      {
        total: 599,
        total_excluding_tax: 557,
        total_taxes: [{ amount: 42, tax_behavior: 'exclusive' }],
      },
      'inclusive',
    ),
  ).toBeNull();
});
