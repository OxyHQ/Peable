import { describe, expect, it } from 'bun:test';
import { QUOTE_LIMITS, QUOTE_STATUSES, type Quote } from '@peable.to/shared-types';
import {
  buildCreateQuoteBody,
  buildUpdateQuoteBody,
  EMPTY_QUOTE_FORM,
  intervalOf,
  lineForQuote,
  ORBIT_QUOTE_LIMITS,
  ORBIT_QUOTE_STATUSES,
  type QuoteForm,
  type QuotePriceChoice,
  quoteActions,
  quoteFormOf,
  quotePdfFilename,
  quotePriceRefusal,
  quoteStatusTone,
  serverQuoteErrors,
} from './quoteForm';

const setup: QuotePriceChoice = {
  id: 'price_setup',
  currency: 'EUR',
  type: 'one_time',
  active: true,
  label: '500.00 EUR',
  productName: 'Setup',
  interval: null,
};
const monthly: QuotePriceChoice = {
  ...setup,
  id: 'price_monthly',
  type: 'recurring',
  productName: 'Plan',
  interval: 'month:1',
};
const yearly: QuotePriceChoice = { ...monthly, id: 'price_yearly', interval: 'year:1' };
const usd: QuotePriceChoice = { ...setup, id: 'price_usd', currency: 'USD' };
const NOW = 1_800_000_000;

function form(patch: Partial<QuoteForm> = {}): QuoteForm {
  return { ...EMPTY_QUOTE_FORM, customer: 'cus_1', lines: [lineForQuote(setup)], ...patch };
}

describe('the restated vocabulary', () => {
  it('matches shared-types', () => {
    expect([...ORBIT_QUOTE_STATUSES]).toEqual([...QUOTE_STATUSES]);
    expect(ORBIT_QUOTE_LIMITS).toEqual({ ...QUOTE_LIMITS });
  });
});

describe('adding a price', () => {
  it('refuses what one quote cannot hold', () => {
    const lines = [lineForQuote(setup), lineForQuote(monthly)];
    expect(quotePriceRefusal(lines, setup)).toBe('duplicate');
    expect(quotePriceRefusal(lines, usd)).toBe('currency_mismatch');
    expect(quotePriceRefusal(lines, yearly)).toBe('interval_mismatch');
    expect(quotePriceRefusal(lines, { ...setup, id: 'p', active: false })).toBe('inactive');
    expect(quotePriceRefusal([lineForQuote(setup)], monthly)).toBeNull();
    const full = Array.from({ length: 20 }, (_, i) => lineForQuote({ ...setup, id: `p${i}` }));
    expect(quotePriceRefusal(full, { ...setup, id: 'p_more' })).toBe('too_many');
  });

  it('reads a recurrence', () => {
    expect(intervalOf({ recurring: null })).toBeNull();
    expect(
      intervalOf({
        recurring: { interval: 'month', interval_count: 3, usage_type: 'licensed', meter: null },
      } as Parameters<typeof intervalOf>[0]),
    ).toBe('month:3');
  });
});

describe('the create body', () => {
  it('is exactly what the contract takes', () => {
    const result = buildCreateQuoteBody(
      form({
        lines: [{ ...lineForQuote(monthly), quantity: '3' }, lineForQuote(setup)],
        collectionMethod: 'send_invoice',
        daysUntilDue: '14',
        discountKind: 'coupon',
        discountId: ' SPRING ',
        automaticTax: true,
        trialDays: '7',
        expiresInDays: '10',
        header: ' Proposal ',
        footer: 'Thanks',
      }),
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      body: {
        customer: 'cus_1',
        line_items: [
          { price: 'price_monthly', quantity: 3 },
          { price: 'price_setup', quantity: 1 },
        ],
        collection_method: 'send_invoice',
        invoice_settings: { days_until_due: 14 },
        subscription_data: { trial_period_days: 7 },
        discounts: [{ coupon: 'SPRING' }],
        automatic_tax: { enabled: true },
        expires_at: NOW + 10 * 86_400,
        header: 'Proposal',
        footer: 'Thanks',
      },
    });
  });

  it('marks every refusal on the field the gateway names', () => {
    const result = buildCreateQuoteBody(
      form({
        customer: ' ',
        lines: [{ ...lineForQuote(setup), quantity: '0' }, lineForQuote(usd)],
        trialDays: '5',
        expiresInDays: '400',
        discountKind: 'promotion_code',
        daysUntilDue: '9',
      }),
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        customer: 'required',
        'line_items[0][quantity]': 'quantity',
        'line_items[1][price]': 'currency_mismatch',
        'subscription_data[trial_period_days]': 'trial_needs_recurring',
        expires_at: 'expiry',
        discounts: 'required',
      },
    });
    expect(buildCreateQuoteBody(form({ lines: [] }), NOW)).toEqual({
      ok: false,
      errors: { line_items: 'required' },
    });
  });

  it('never debits FairCoin', () => {
    const fair = { ...setup, id: 'price_fair', currency: 'FAIR' as const };
    expect(buildCreateQuoteBody(form({ lines: [lineForQuote(fair)] }), NOW)).toEqual({
      ok: false,
      errors: { collection_method: 'faircoin_send' },
    });
    const sent = buildCreateQuoteBody(
      form({ lines: [lineForQuote(fair)], collectionMethod: 'send_invoice' }),
      NOW,
    );
    expect(sent.ok).toBe(true);
  });
});

const stored = {
  id: 'qt_1',
  object: 'quote',
  status: 'draft',
  number: null,
  customer: 'cus_1',
  collection_method: 'charge_automatically',
  invoice_settings: { days_until_due: null },
  subscription_data: { description: null, trial_period_days: null, metadata: {} },
  discount: {
    object: 'discount',
    coupon: 'SPRING',
    promotion_code: 'promo_1',
    start: 1,
    end: null,
  },
  automatic_tax: { enabled: false, status: null, tax_calculation: null },
  header: 'Proposal',
  description: null,
  footer: null,
} as unknown as Quote;

describe('editing a draft', () => {
  it('starts from the stored quote and clears what was emptied', () => {
    const editing = quoteFormOf(stored, [lineForQuote(setup)]);
    expect(editing).toMatchObject({
      customer: 'cus_1',
      discountKind: 'promotion_code',
      discountId: 'promo_1',
      expiresInDays: '',
      header: 'Proposal',
    });
    const result = buildUpdateQuoteBody({ ...editing, discountKind: 'none', header: '' }, NOW);
    expect(result).toEqual({
      ok: true,
      body: {
        line_items: [{ price: 'price_setup', quantity: 1 }],
        collection_method: 'charge_automatically',
        discounts: '',
        automatic_tax: { enabled: false },
        header: '',
        description: '',
        footer: '',
      },
    });
  });

  it('maps a server refusal onto its field', () => {
    expect(serverQuoteErrors('line_items[1][price]')).toEqual({ 'line_items[1][price]': 'server' });
    expect(serverQuoteErrors('discounts[0][coupon]')).toEqual({ discounts: 'server' });
    expect(serverQuoteErrors('items')).toEqual({});
    expect(serverQuoteErrors(undefined)).toEqual({});
  });
});

describe('what a status allows', () => {
  it('offers only what the gateway accepts', () => {
    expect(quoteActions({ status: 'draft' })).toEqual(['edit', 'finalize', 'cancel']);
    expect(quoteActions({ status: 'open' })).toEqual(['accept', 'cancel']);
    expect(quoteActions({ status: 'accepted' })).toEqual([]);
    expect(quoteActions({ status: 'canceled' })).toEqual([]);
    expect(quoteStatusTone('accepted')).toBe('success');
    expect(quotePdfFilename({ id: 'qt_1', number: null })).toBe('qt_1.pdf');
    expect(quotePdfFilename({ id: 'qt_1', number: 'QT-AB-0001' })).toBe('QT-AB-0001.pdf');
  });
});
