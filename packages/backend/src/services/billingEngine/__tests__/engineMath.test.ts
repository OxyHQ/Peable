/**
 * The billing engine's pure arithmetic (ADR 0018): anchored periods, proration
 * by the second, line discounts with the line's sign, totals, balance
 * application, and the PDF's shape.
 */
import { describe, expect, test } from 'bun:test';
import { allocate, applyBalance, invoiceTotals, lineDiscounts } from '../invoiceMath';
import { addIntervals, nextBoundaryAfter, prorate } from '../periods';
import { formatAmount, renderInvoicePdf } from '../pdf';
import { nextActionAt } from '../subscriptionSchedule';
import { invoiceMayMove, subscriptionMayMove } from '../stateMachines';

const at = (iso: string) => new Date(iso);

describe('periods', () => {
  test('months are counted from the anchor, clamped to short months, without drift', () => {
    const anchor = at('2027-01-31T10:00:00Z');
    expect(addIntervals(anchor, 'month', 1).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(addIntervals(anchor, 'month', 2).toISOString()).toBe('2027-03-31T10:00:00.000Z');
    expect(addIntervals(at('2028-01-31T00:00:00Z'), 'month', 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(addIntervals(anchor, 'year', 1).toISOString()).toBe('2028-01-31T10:00:00.000Z');
    expect(addIntervals(anchor, 'month', -1).toISOString()).toBe('2026-12-31T10:00:00.000Z');
  });

  test('the next boundary after an instant, past and future anchors', () => {
    const monthly = { interval: 'month' as const, intervalCount: 1 };
    const anchor = at('2027-01-31T10:00:00Z');
    expect(nextBoundaryAfter(anchor, monthly, at('2027-02-28T10:00:00Z')).toISOString()).toBe(
      '2027-03-31T10:00:00.000Z',
    );
    expect(nextBoundaryAfter(anchor, monthly, at('2027-02-28T09:59:59Z')).toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
    expect(nextBoundaryAfter(anchor, monthly, at('2029-06-15T00:00:00Z')).toISOString()).toBe(
      '2029-06-30T10:00:00.000Z',
    );
    // A future anchor ends the first (stub) period.
    expect(
      nextBoundaryAfter(
        at('2027-02-10T00:00:00Z'),
        monthly,
        at('2027-02-01T00:00:00Z'),
      ).toISOString(),
    ).toBe('2027-02-10T00:00:00.000Z');
    const quarterly = { interval: 'month' as const, intervalCount: 3 };
    expect(nextBoundaryAfter(anchor, quarterly, at('2027-03-01T00:00:00Z')).toISOString()).toBe(
      '2027-04-30T10:00:00.000Z',
    );
    const weekly = { interval: 'week' as const, intervalCount: 2 };
    expect(
      nextBoundaryAfter(
        at('2027-01-01T00:00:00Z'),
        weekly,
        at('2027-01-20T00:00:00Z'),
      ).toISOString(),
    ).toBe('2027-01-29T00:00:00.000Z');
  });

  test('proration rounds half away from zero, clamps to the period, keeps the sign', () => {
    expect(prorate(1000n, 50, 100)).toBe(500n);
    expect(prorate(1001n, 50, 100)).toBe(501n);
    expect(prorate(-1001n, 50, 100)).toBe(-501n);
    expect(prorate(1000n, 150, 100)).toBe(1000n);
    expect(prorate(1000n, -5, 100)).toBe(0n);
    expect(() => prorate(1n, 1, 0)).toThrow();
  });
});

describe('invoice math', () => {
  const coupon = (over: Partial<Parameters<typeof lineDiscounts>[1]>) => ({
    percentOffBps: null,
    amountOff: null,
    currency: null,
    appliesToProducts: null,
    ...over,
  });

  test('a percentage discounts charges and credits alike, by magnitude', () => {
    const lines = [
      { amount: 1500n, discountable: true, productId: 'p' },
      { amount: -500n, discountable: true, productId: 'p' },
      { amount: 333n, discountable: false, productId: 'p' },
    ];
    expect(lineDiscounts(lines, coupon({ percentOffBps: 5000 }), 'EUR')).toEqual([750n, -250n, 0n]);
  });

  test('a fixed amount is spread over charge lines, capped, exactly', () => {
    const lines = [
      { amount: 100n, discountable: true, productId: 'a' },
      { amount: 200n, discountable: true, productId: 'b' },
      { amount: -50n, discountable: true, productId: 'a' },
    ];
    const off = lineDiscounts(lines, coupon({ amountOff: 100n, currency: 'EUR' }), 'EUR');
    expect(off.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(off[2]).toBe(0n);
    expect(lineDiscounts(lines, coupon({ amountOff: 1000n, currency: 'EUR' }), 'EUR')).toEqual([
      100n,
      200n,
      0n,
    ]);
    expect(lineDiscounts(lines, coupon({ amountOff: 100n, currency: 'USD' }), 'EUR')).toEqual([
      0n,
      0n,
      0n,
    ]);
    expect(
      lineDiscounts(lines, coupon({ percentOffBps: 10000, appliesToProducts: ['b'] }), 'EUR'),
    ).toEqual([0n, 200n, 0n]);
  });

  test('allocation by largest remainder adds up and is deterministic', () => {
    expect(allocate(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(allocate(0n, [5n])).toEqual([0n]);
    expect(allocate(7n, [0n, 0n])).toEqual([0n, 0n]);
  });

  test('totals: exclusive tax adds, inclusive tax is inside', () => {
    const totals = invoiceTotals({
      lines: [
        { amount: 1000n, discount: 100n, taxExclusive: 180n, taxInclusive: 0n },
        { amount: 1200n, discount: 0n, taxExclusive: 0n, taxInclusive: 200n },
      ],
      taxed: true,
    });
    expect(totals).toEqual({
      subtotal: 2200n,
      subtotalExcludingTax: 2000n,
      totalDiscount: 100n,
      tax: 380n,
      total: 2280n,
      totalExcludingTax: 1900n,
    });
    expect(invoiceTotals({ lines: [], taxed: false }).tax).toBeNull();
  });

  test('the balance: credit consumed up to the total, debt added, negative totals become credit', () => {
    expect(applyBalance(1000n, -300n)).toEqual({
      amountDue: 700n,
      endingBalance: 0n,
      applied: 300n,
    });
    expect(applyBalance(1000n, -1500n)).toEqual({
      amountDue: 0n,
      endingBalance: -500n,
      applied: 1000n,
    });
    expect(applyBalance(1000n, 200n)).toEqual({
      amountDue: 1200n,
      endingBalance: 0n,
      applied: -200n,
    });
    expect(applyBalance(-400n, 0n)).toEqual({
      amountDue: 0n,
      endingBalance: -400n,
      applied: -400n,
    });
  });
});

describe('state machines and schedule', () => {
  test('terminal statuses go nowhere; a draft only finalizes', () => {
    expect(subscriptionMayMove('canceled', 'active')).toBe(false);
    expect(subscriptionMayMove('incomplete_expired', 'active')).toBe(false);
    expect(subscriptionMayMove('past_due', 'active')).toBe(true);
    expect(invoiceMayMove('draft', 'paid')).toBe(false);
    expect(invoiceMayMove('uncollectible', 'paid')).toBe(true);
    expect(invoiceMayMove('paid', 'void')).toBe(false);
  });

  test('the next obligation of a subscription', () => {
    const base = {
      status: 'active' as const,
      collectionMethod: 'charge_automatically' as const,
      currentPeriodStart: at('2027-01-01T00:00:00Z'),
      currentPeriodEnd: at('2027-02-01T00:00:00Z'),
      trialEnd: null,
      trialWillEndSentAt: null,
      upcomingNoticeSentAt: null,
      cancelAt: null,
      cancelAtPeriodEnd: false,
      pauseResumesAt: null,
      createdAt: at('2027-01-01T00:00:00Z'),
    };
    expect(nextActionAt(base)?.toISOString()).toBe('2027-01-29T00:00:00.000Z');
    expect(
      nextActionAt({ ...base, upcomingNoticeSentAt: at('2027-01-29T00:00:00Z') })?.toISOString(),
    ).toBe('2027-02-01T00:00:00.000Z');
    expect(nextActionAt({ ...base, cancelAt: at('2027-01-10T00:00:00Z') })?.toISOString()).toBe(
      '2027-01-10T00:00:00.000Z',
    );
    expect(nextActionAt({ ...base, status: 'canceled' })).toBeNull();
    expect(
      nextActionAt({
        ...base,
        status: 'trialing',
        trialEnd: at('2027-01-08T00:00:00Z'),
        currentPeriodEnd: at('2027-01-08T00:00:00Z'),
      })?.toISOString(),
    ).toBe('2027-01-05T00:00:00.000Z');
  });
});

describe('the PDF', () => {
  test('amounts are formatted by the currency scale', () => {
    expect(formatAmount('123456', 'EUR')).toBe('1234.56 EUR');
    expect(formatAmount('-5', 'EUR')).toBe('-0.05 EUR');
    expect(formatAmount('100000000', 'FAIR')).toBe('1.00000000 FAIR');
  });

  test('a valid PDF 1.4 with a cross-reference table that points at its objects', () => {
    const bytes = renderInvoicePdf({
      merchantName: 'Señor (Shop) \\ Ltd ✓',
      number: 'ABC-0001',
      status: 'open',
      currency: 'EUR',
      issued: '2027-01-01',
      due: '2027-01-31',
      customerName: 'Payer',
      customerEmail: 'payer@example.test',
      lines: Array.from({ length: 60 }, (_, i) => ({
        description: `Line ${i}`,
        quantity: '1',
        amount: '1.00 EUR',
      })),
      subtotal: '60.00 EUR',
      discount: '0.00 EUR',
      tax: '0.00 EUR',
      total: '60.00 EUR',
      amountPaid: '0.00 EUR',
      amountDue: '60.00 EUR',
      footer: null,
    });
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('Se\xf1or \\(Shop\\) \\\\ Ltd ?');
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    for (const match of text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)) {
      expect(text.slice(Number(match[1])).match(/^\d+ 0 obj/)).not.toBeNull();
    }
  });
});
