import { describe, expect, it } from 'bun:test';
import { OrbitApiError } from '../api/transport';
import {
  amountDecimals,
  buildCreateAccountBody,
  buildPayoutBody,
  buildScheduleBody,
  formFromSchedule,
  onboardingLinkBody,
  originOf,
  parsePendingPayout,
  payoutOutcomeUnknown,
  pendingPayoutStorageKey,
} from './forms';

const available = [{ currency: 'EUR', amount: '12500' }];

describe('buildPayoutBody', () => {
  it('turns the typed amount into exact base units', () => {
    expect(buildPayoutBody({ amount: '100.5', currency: 'eur' }, available)).toEqual({
      ok: true,
      body: { amount: '10050', currency: 'EUR' },
    });
    expect(buildPayoutBody({ amount: '125', currency: 'EUR' }, available)).toEqual({
      ok: true,
      body: { amount: '12500', currency: 'EUR' },
    });
  });

  it('refuses a zero, a negative, too many decimals or text', () => {
    for (const amount of ['0', '0.00', '-1', '1.005', 'ten', '']) {
      expect(buildPayoutBody({ amount, currency: 'EUR' }, available)).toEqual({
        ok: false,
        error: 'amount',
      });
    }
  });

  it('refuses more than is available, before the provider is asked', () => {
    expect(buildPayoutBody({ amount: '125.01', currency: 'EUR' }, available)).toEqual({
      ok: false,
      error: 'exceeds',
    });
  });

  it('refuses a currency with no available balance, and FairCoin always', () => {
    expect(buildPayoutBody({ amount: '1', currency: 'USD' }, available)).toEqual({
      ok: false,
      error: 'currency',
    });
    expect(
      buildPayoutBody({ amount: '1', currency: 'FAIR' }, [{ currency: 'FAIR', amount: '1' }]),
    ).toEqual({ ok: false, error: 'currency' });
  });

  it('knows how many decimals the field takes', () => {
    expect(amountDecimals('eur')).toBe(2);
  });
});

describe('pending payout', () => {
  it('is kept per scope and read back defensively', () => {
    expect(pendingPayoutStorageKey({ applicationId: 'app_1', environment: 'production' })).toBe(
      'peable-orbit:pending-payout:app_1:production',
    );
    const stored = JSON.stringify({ key: 'k1', body: { amount: '100', currency: 'EUR' } });
    expect(parsePendingPayout(stored)).toEqual({
      key: 'k1',
      body: { amount: '100', currency: 'EUR' },
    });
    for (const raw of [
      null,
      '',
      'not json',
      '{}',
      JSON.stringify({ key: 'k', body: { amount: '0', currency: 'EUR' } }),
      JSON.stringify({ key: 'k', body: { amount: '1', currency: 'FAIR' } }),
    ]) {
      expect(parsePendingPayout(raw)).toBeNull();
    }
  });

  it('retries the same key only when the outcome is unknown', () => {
    expect(payoutOutcomeUnknown(new Error('network down'))).toBe(true);
    expect(
      payoutOutcomeUnknown(new OrbitApiError({ status: 502, type: 'api_error', message: '' })),
    ).toBe(true);
    expect(
      payoutOutcomeUnknown(new OrbitApiError({ status: 0, type: 'api_error', message: '' })),
    ).toBe(true);
    expect(
      payoutOutcomeUnknown(
        new OrbitApiError({ status: 400, type: 'invalid_request_error', message: '' }),
      ),
    ).toBe(false);
  });
});

describe('payout schedule form', () => {
  it('starts from what the provider reported', () => {
    expect(
      formFromSchedule({
        interval: 'weekly',
        delay_days: 7,
        weekly_anchor: 'friday',
        monthly_anchor: null,
      }),
    ).toEqual({ interval: 'weekly', delayDays: '7', weeklyAnchor: 'friday', monthlyAnchor: '' });
    expect(formFromSchedule(null).interval).toBe('manual');
  });

  it('sends only the anchor its interval uses', () => {
    expect(
      buildScheduleBody({
        interval: 'weekly',
        delayDays: '',
        weeklyAnchor: 'monday',
        monthlyAnchor: '15',
      }),
    ).toEqual({
      ok: true,
      body: {
        settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'monday' } } },
      },
    });
    expect(
      buildScheduleBody({
        interval: 'monthly',
        delayDays: '3',
        weeklyAnchor: 'monday',
        monthlyAnchor: '31',
      }),
    ).toEqual({
      ok: true,
      body: {
        settings: {
          payouts: { schedule: { interval: 'monthly', delay_days: 3, monthly_anchor: 31 } },
        },
      },
    });
    expect(
      buildScheduleBody({ interval: 'manual', delayDays: '', weeklyAnchor: '', monthlyAnchor: '' }),
    ).toEqual({ ok: true, body: { settings: { payouts: { schedule: { interval: 'manual' } } } } });
  });

  it('refuses a bad delay or a missing anchor', () => {
    const base = { interval: 'daily' as const, weeklyAnchor: '' as const, monthlyAnchor: '' };
    expect(buildScheduleBody({ ...base, delayDays: '0' })).toEqual({ ok: false, error: 'delay' });
    expect(buildScheduleBody({ ...base, delayDays: '400' })).toEqual({
      ok: false,
      error: 'delay',
    });
    expect(buildScheduleBody({ ...base, delayDays: '1.5' })).toEqual({
      ok: false,
      error: 'delay',
    });
    expect(buildScheduleBody({ ...base, interval: 'weekly', delayDays: '' })).toEqual({
      ok: false,
      error: 'weekly',
    });
    expect(
      buildScheduleBody({ ...base, interval: 'monthly', delayDays: '', monthlyAnchor: '32' }),
    ).toEqual({ ok: false, error: 'monthly' });
  });
});

describe('buildCreateAccountBody', () => {
  it('upper-cases a two-letter country and sends the business type', () => {
    expect(buildCreateAccountBody({ country: ' es ', businessType: 'individual' })).toEqual({
      ok: true,
      body: { country: 'ES', business_type: 'individual' },
    });
  });

  it('refuses anything that is not two letters', () => {
    for (const country of ['', 'ESP', 'E1', 'España']) {
      expect(buildCreateAccountBody({ country, businessType: 'company' })).toEqual({
        ok: false,
        error: 'country',
      });
    }
  });
});

describe('onboarding link', () => {
  it('sends the merchant back to the Account page, and marks a refresh', () => {
    expect(onboardingLinkBody('https://orbit.peable.to/')).toEqual({
      return_url: 'https://orbit.peable.to/account',
      refresh_url: 'https://orbit.peable.to/account?refresh=1',
      type: 'account_onboarding',
    });
  });

  it('takes the origin of a configured URL', () => {
    expect(originOf('https://orbit.peable.to/callback?x=1')).toBe('https://orbit.peable.to');
    expect(originOf('http://localhost:8082')).toBe('http://localhost:8082');
  });
});
