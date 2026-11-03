import { describe, expect, it } from 'bun:test';
import {
  BILLING_SETTINGS_LIMITS,
  DUNNING_FINAL_ACTIONS,
  DUNNING_INVOICE_ACTIONS,
  type BillingSettings,
} from '@peable.to/shared-types';
import {
  buildFeatureBody,
  buildSettingsBody,
  DUNNING_FINAL_ACTION_OPTIONS,
  DUNNING_INVOICE_ACTION_OPTIONS,
  ORBIT_BILLING_LIMITS,
  parseRetrySchedule,
  scheduleWindowDays,
  settingsFormOf,
} from './settingsForm';

const SETTINGS: BillingSettings = {
  object: 'billing_settings',
  livemode: false,
  invoice_prefix: 'ABCD1234',
  next_invoice_sequence: 7,
  default_days_until_due: 30,
  dunning: {
    retry_schedule_days: [1, 3, 5, 7],
    final_action: 'cancel',
    invoice_action: 'mark_uncollectible',
  },
  emails: { invoice_finalized: true, payment_failed: true },
  updated: 1,
};

describe('the restated limits and options', () => {
  it('are the gateway’s', () => {
    expect(ORBIT_BILLING_LIMITS).toEqual({ ...BILLING_SETTINGS_LIMITS });
    expect([...DUNNING_FINAL_ACTION_OPTIONS].sort()).toEqual([...DUNNING_FINAL_ACTIONS].sort());
    expect([...DUNNING_INVOICE_ACTION_OPTIONS].sort()).toEqual([...DUNNING_INVOICE_ACTIONS].sort());
  });
});

describe('parseRetrySchedule', () => {
  it('reads days separated by commas or spaces', () => {
    expect(parseRetrySchedule('1, 3, 5, 7')).toEqual([1, 3, 5, 7]);
    expect(parseRetrySchedule(' 2 4 ')).toEqual([2, 4]);
    expect(parseRetrySchedule('')).toEqual([]);
  });

  it('refuses a zero, a fraction, a day out of range or too many retries', () => {
    expect(parseRetrySchedule('0')).toBeNull();
    expect(parseRetrySchedule('1.5')).toBeNull();
    expect(parseRetrySchedule('61')).toBeNull();
    expect(parseRetrySchedule('1 1 1 1 1 1 1 1 1')).toBeNull();
    expect(parseRetrySchedule('three')).toBeNull();
  });

  it('sums the window', () => {
    expect(scheduleWindowDays([1, 3, 5, 7])).toBe(16);
  });
});

describe('buildSettingsBody', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildSettingsBody(settingsFormOf(SETTINGS), SETTINGS)).toEqual({ ok: true, body: {} });
  });

  it('sends only what moved, the prefix upper-cased', () => {
    const form = {
      ...settingsFormOf(SETTINGS),
      invoicePrefix: 'acme',
      retrySchedule: '2, 4',
      finalAction: 'unpaid' as const,
      emailPaymentFailed: false,
    };
    expect(buildSettingsBody(form, SETTINGS)).toEqual({
      ok: true,
      body: {
        invoice_prefix: 'ACME',
        dunning: { retry_schedule_days: [2, 4], final_action: 'unpaid' },
        emails: { payment_failed: false },
      },
    });
  });

  it('names the field at fault', () => {
    const form = settingsFormOf(SETTINGS);
    expect(buildSettingsBody({ ...form, invoicePrefix: 'a-b' }, SETTINGS)).toEqual({
      ok: false,
      error: 'invoicePrefix',
    });
    expect(buildSettingsBody({ ...form, defaultDaysUntilDue: '400' }, SETTINGS)).toEqual({
      ok: false,
      error: 'defaultDaysUntilDue',
    });
    expect(buildSettingsBody({ ...form, retrySchedule: '0' }, SETTINGS)).toEqual({
      ok: false,
      error: 'retrySchedule',
    });
  });
});

describe('buildFeatureBody', () => {
  it('trims and checks the lookup key and name', () => {
    expect(buildFeatureBody({ lookupKey: ' mention_plus ', name: ' Mention Plus ' })).toEqual({
      ok: true,
      body: { lookup_key: 'mention_plus', name: 'Mention Plus' },
    });
    expect(buildFeatureBody({ lookupKey: 'has space', name: 'x' })).toEqual({
      ok: false,
      error: 'lookupKey',
    });
    expect(buildFeatureBody({ lookupKey: 'ok', name: ' ' })).toEqual({ ok: false, error: 'name' });
  });
});
