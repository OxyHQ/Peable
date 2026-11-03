import { expect, test } from 'bun:test';
import { localInvoiceQuote } from './stripeTestInvoiceQuote';
test('actual inclusive invoice amounts remain one total', () => {
  expect(
    localInvoiceQuote(
      {
        total: 599,
        total_excluding_tax: 557,
        total_taxes: [{ amount: 42, tax_behavior: 'inclusive' }],
      },
      'inclusive',
    ),
  ).toEqual({ subtotalMinorUnits: 557, taxMinorUnits: 42, totalMinorUnits: 599, inclusive: true });
});
test('recorded zero is distinct from absent provider tax evidence', () => {
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 599, total_taxes: [] }, 'inclusive')
      ?.taxMinorUnits,
  ).toBe(0);
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: null, total_taxes: [] }, 'inclusive'),
  ).toBeUndefined();
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 599, total_taxes: null }, 'inclusive'),
  ).toBeUndefined();
});
test('conflicting amounts or exclusive treatment are omitted, never invented', () => {
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 557, total_taxes: [] }, 'inclusive'),
  ).toBeUndefined();
  expect(
    localInvoiceQuote({ total: 599, total_excluding_tax: 599, total_taxes: [] }, 'exclusive'),
  ).toBeUndefined();
  expect(
    localInvoiceQuote(
      {
        total: 599,
        total_excluding_tax: 557,
        total_taxes: [{ amount: 42, tax_behavior: 'exclusive' }],
      },
      'inclusive',
    ),
  ).toBeUndefined();
});
