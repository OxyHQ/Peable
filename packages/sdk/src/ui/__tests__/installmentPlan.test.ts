import { expect, it } from 'bun:test';
import { validInstallmentQuote, type InstallmentQuote } from '../installmentPlan';
const quote: InstallmentQuote = {
  id: 'quote-1',
  currency: 'USD',
  orderMinorUnits: 2800,
  dueTodayMinorUnits: 934,
  totalMinorUnits: 2800,
  interestMinorUnits: 0,
  feesMinorUnits: 0,
  payments: [
    { id: '1', dueOn: '2026-11-03', amountMinorUnits: 934 },
    { id: '2', dueOn: '2026-12-03', amountMinorUnits: 933 },
    { id: '3', dueOn: '2027-01-02', amountMinorUnits: 933 },
  ],
};
it('accepts a provider schedule with unequal first payment', () =>
  expect(validInstallmentQuote(quote)).toBe(true));
it('rejects inconsistent totals and fractional minor units', () => {
  expect(validInstallmentQuote({ ...quote, totalMinorUnits: 2801 })).toBe(false);
  expect(validInstallmentQuote({ ...quote, feesMinorUnits: 1 })).toBe(false);
  expect(validInstallmentQuote({ ...quote, dueTodayMinorUnits: 0.5 })).toBe(false);
  expect(validInstallmentQuote({ ...quote, dueTodayMinorUnits: 2801 })).toBe(false);
});
it('rejects invalid dates and duplicate payment identities', () => {
  expect(
    validInstallmentQuote({
      ...quote,
      payments: [{ id: '1', dueOn: 'wrong', amountMinorUnits: 2800 }],
    }),
  ).toBe(false);
  expect(
    validInstallmentQuote({
      ...quote,
      payments: [...quote.payments, quote.payments[0]].filter(
        (v): v is NonNullable<typeof v> => !!v,
      ),
    }),
  ).toBe(false);
});
it('rejects calendar rollover, oversized schedules and unsafe summed totals', () => {
  expect(
    validInstallmentQuote({
      ...quote,
      payments: [{ id: '1', dueOn: '2026-02-31', amountMinorUnits: 2800 }],
    }),
  ).toBe(false);
  expect(
    validInstallmentQuote({
      ...quote,
      payments: Array.from({ length: 37 }, (_, i) => ({
        id: `${i}`,
        dueOn: '2026-11-03',
        amountMinorUnits: 0,
      })),
    }),
  ).toBe(false);
  expect(
    validInstallmentQuote({
      ...quote,
      orderMinorUnits: Number.MAX_SAFE_INTEGER,
      feesMinorUnits: 1,
      totalMinorUnits: Number.MAX_SAFE_INTEGER,
    }),
  ).toBe(false);
});
