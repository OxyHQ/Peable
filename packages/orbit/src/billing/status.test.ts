import { describe, expect, it } from 'bun:test';
import { INVOICE_STATUSES, SUBSCRIPTION_STATUSES } from '@peable.to/shared-types';
import { t } from '../i18n';
import {
  invoiceActions,
  invoiceStatusLabel,
  invoiceStatusTone,
  ORBIT_INVOICE_STATUSES,
  ORBIT_SUBSCRIPTION_STATUSES,
  subscriptionActions,
  subscriptionEnded,
  subscriptionStatusLabel,
  subscriptionStatusTone,
} from './status';

describe('the restated status lists', () => {
  it('are the gateway’s, each status exactly once', () => {
    expect([...ORBIT_SUBSCRIPTION_STATUSES].sort()).toEqual([...SUBSCRIPTION_STATUSES].sort());
    expect([...ORBIT_INVOICE_STATUSES].sort()).toEqual([...INVOICE_STATUSES].sort());
  });

  it('label and paint every status', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(subscriptionStatusLabel(status)).not.toBe(status);
      expect(subscriptionStatusTone(status)).toBeDefined();
    }
    for (const status of INVOICE_STATUSES) {
      expect(invoiceStatusLabel(status)).not.toBe(status);
      expect(invoiceStatusTone(status)).toBeDefined();
    }
    expect(subscriptionStatusTone('active')).toBe('success');
    expect(subscriptionStatusTone('past_due')).toBe('warning');
    expect(invoiceStatusTone('paid')).toBe('success');
    expect(invoiceStatusTone('uncollectible')).toBe('danger');
  });
});

describe('invoiceActions', () => {
  const invoice = (status: (typeof INVOICE_STATUSES)[number], overrides = {}) => ({
    status,
    collection_method: 'charge_automatically' as const,
    amount_paid: '0',
    ...overrides,
  });

  it('offers only what the gateway accepts from each status', () => {
    expect(invoiceActions(invoice('draft'))).toEqual(['finalize']);
    expect(invoiceActions(invoice('open'))).toEqual(['void', 'mark_uncollectible']);
    expect(invoiceActions(invoice('open', { collection_method: 'send_invoice' }))).toEqual([
      'send',
      'void',
      'mark_uncollectible',
    ]);
    expect(invoiceActions(invoice('uncollectible'))).toEqual(['void']);
    expect(invoiceActions(invoice('paid'))).toEqual([]);
    expect(invoiceActions(invoice('void'))).toEqual([]);
  });

  it('never offers to void an invoice part of which was paid', () => {
    expect(invoiceActions(invoice('open', { amount_paid: '100' }))).toEqual(['mark_uncollectible']);
    expect(invoiceActions(invoice('uncollectible', { amount_paid: '100' }))).toEqual([]);
  });

  it('has a label and a toast for every action', () => {
    for (const action of ['finalize', 'send', 'void', 'mark_uncollectible']) {
      expect(t(`invoice.action.${action}`)).not.toBe(`invoice.action.${action}`);
      expect(t(`invoice.done.${action}`)).not.toBe(`invoice.done.${action}`);
    }
  });
});

describe('subscriptionActions', () => {
  const base = { cancel_at_period_end: false, pause_collection: null };

  it('offers nothing once a subscription has ended', () => {
    expect(subscriptionEnded('canceled')).toBe(true);
    expect(subscriptionEnded('incomplete_expired')).toBe(true);
    expect(subscriptionActions({ ...base, status: 'canceled' })).toEqual([]);
  });

  it('toggles cancel-at-period-end and collection pausing', () => {
    expect(subscriptionActions({ ...base, status: 'active' })).toEqual([
      'cancel_at_period_end',
      'pause_collection',
      'cancel_now',
    ]);
    expect(
      subscriptionActions({
        status: 'active',
        cancel_at_period_end: true,
        pause_collection: { behavior: 'keep_as_draft', resumes_at: null },
      }),
    ).toEqual(['keep', 'resume_collection', 'cancel_now']);
  });

  it('resumes a paused subscription', () => {
    expect(subscriptionActions({ ...base, status: 'paused' })).toEqual(['resume', 'cancel_now']);
  });

  it('labels every action', () => {
    for (const action of [
      'cancel_at_period_end',
      'keep',
      'cancel_now',
      'pause_collection',
      'resume_collection',
      'resume',
    ]) {
      expect(t(`subscription.action.${action}`)).not.toBe(`subscription.action.${action}`);
    }
  });
});
