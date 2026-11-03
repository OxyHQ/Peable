import { describe, expect, it } from 'bun:test';
import {
  BALANCE_TRANSACTION_STATUSES,
  BALANCE_TRANSACTION_TYPES,
  PAYOUT_INTERVALS,
  PAYOUT_STATUSES,
  PAYOUT_WEEKLY_ANCHORS,
  RECONCILIATION_MISMATCH_KINDS,
} from '@peable.to/shared-types';
import {
  balanceTransactionStatusLabel,
  balanceTransactionStatusTone,
  balanceTransactionTypeLabel,
  canCancelPayout,
  capabilityLabel,
  capabilityTone,
  mismatchKindLabel,
  ORBIT_BALANCE_TRANSACTION_STATUSES,
  ORBIT_BALANCE_TRANSACTION_TYPES,
  ORBIT_PAYOUT_INTERVALS,
  ORBIT_PAYOUT_STATUSES,
  ORBIT_RECONCILIATION_MISMATCH_KINDS,
  ORBIT_WEEKLY_ANCHORS,
  payoutIntervalLabel,
  payoutStatusLabel,
  payoutStatusTone,
  scheduleSummary,
  weekdayLabel,
} from './vocabulary';

const sorted = (values: readonly string[]) => [...values].sort();

describe('restated vocabularies', () => {
  it('are the shared-types originals, each value exactly once', () => {
    expect(sorted(ORBIT_BALANCE_TRANSACTION_TYPES)).toEqual(sorted(BALANCE_TRANSACTION_TYPES));
    expect(sorted(ORBIT_BALANCE_TRANSACTION_STATUSES)).toEqual(
      sorted(BALANCE_TRANSACTION_STATUSES),
    );
    expect(sorted(ORBIT_PAYOUT_STATUSES)).toEqual(sorted(PAYOUT_STATUSES));
    expect([...ORBIT_PAYOUT_INTERVALS]).toEqual([...PAYOUT_INTERVALS]);
    expect([...ORBIT_WEEKLY_ANCHORS]).toEqual([...PAYOUT_WEEKLY_ANCHORS]);
    expect(sorted(ORBIT_RECONCILIATION_MISMATCH_KINDS)).toEqual(
      sorted(RECONCILIATION_MISMATCH_KINDS),
    );
  });

  it('words every value rather than showing the code', () => {
    for (const type of BALANCE_TRANSACTION_TYPES) {
      expect(balanceTransactionTypeLabel(type)).not.toBe(type);
    }
    for (const status of BALANCE_TRANSACTION_STATUSES) {
      expect(balanceTransactionStatusLabel(status)).not.toBe(status);
      expect(balanceTransactionStatusTone(status)).toBeDefined();
    }
    for (const status of PAYOUT_STATUSES) {
      expect(payoutStatusLabel(status)).not.toBe(status);
      expect(payoutStatusTone(status)).toBeDefined();
    }
    for (const interval of PAYOUT_INTERVALS) {
      expect(payoutIntervalLabel(interval)).not.toBe(interval);
    }
    for (const day of PAYOUT_WEEKLY_ANCHORS) expect(weekdayLabel(day)).not.toBe(day);
    for (const kind of RECONCILIATION_MISMATCH_KINDS) {
      expect(mismatchKindLabel(kind)).not.toBe(kind);
    }
  });

  it('shows a value the catalog does not know as itself', () => {
    expect(balanceTransactionTypeLabel('brand_new_type')).toBe('brand_new_type');
  });
});

describe('payout statuses', () => {
  it('paints paid, failed and in transit apart, and cancels only a pending payout', () => {
    expect(payoutStatusTone('paid')).toBe('success');
    expect(payoutStatusTone('failed')).toBe('danger');
    expect(payoutStatusTone('in_transit')).toBe('info');
    expect(canCancelPayout('pending')).toBe(true);
    for (const status of ['in_transit', 'paid', 'failed', 'canceled'] as const) {
      expect(canCancelPayout(status)).toBe(false);
    }
  });
});

describe('informational funds', () => {
  it('are labelled as being in the wallet, and painted neutral', () => {
    expect(balanceTransactionStatusLabel('informational')).toBe('In your wallet');
    expect(balanceTransactionStatusTone('informational')).toBe('neutral');
  });
});

describe('capabilities', () => {
  it('tells "never requested" apart from inactive', () => {
    expect(capabilityLabel(null)).toBe('Not requested');
    expect(capabilityLabel('inactive')).toBe('Inactive');
    expect(capabilityTone(null)).toBe('neutral');
    expect(capabilityTone('active')).toBe('success');
  });
});

describe('scheduleSummary', () => {
  it('says each interval with its anchor and delay', () => {
    expect(scheduleSummary(null)).toBe('The provider has not reported a schedule yet.');
    expect(
      scheduleSummary({
        interval: 'manual',
        delay_days: null,
        weekly_anchor: null,
        monthly_anchor: null,
      }),
    ).toBe('Manual — only the payouts you create');
    expect(
      scheduleSummary({
        interval: 'weekly',
        delay_days: 7,
        weekly_anchor: 'friday',
        monthly_anchor: null,
      }),
    ).toBe('Weekly, every Friday · funds payable after 7 day(s)');
    expect(
      scheduleSummary({
        interval: 'monthly',
        delay_days: null,
        weekly_anchor: null,
        monthly_anchor: 15,
      }),
    ).toBe('Monthly, on day 15');
  });
});
