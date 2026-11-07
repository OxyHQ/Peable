import { afterEach, describe, expect, it } from 'bun:test';
import type { ReportSchedule } from '@peable.to/shared-types';
import { FALLBACK_LOCALE, setLocale } from '../i18n';
import {
  buildReportScheduleBody,
  cadenceLabel,
  emptyScheduleForm,
  isTimeZone,
  parseRecipients,
  type ReportScheduleForm,
  recipientsProblem,
  scheduleActions,
  scheduleForm,
  scheduleStatusTone,
} from './schedules';

afterEach(() => {
  setLocale(FALLBACK_LOCALE);
});

function form(overrides: Partial<ReportScheduleForm> = {}): ReportScheduleForm {
  return {
    ...emptyScheduleForm('balance.summary.1', 'en'),
    timezone: 'Europe/Madrid',
    ...overrides,
  };
}

function schedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
  return {
    id: 'frs_1',
    object: 'reporting.report_schedule',
    livemode: false,
    created: 1_793_750_400,
    report_type: 'payments.itemized.1',
    parameters: { currency: 'EUR', columns: ['payment_intent_id', 'amount'] },
    schedule: { interval: 'weekly', weekly_anchor: 'friday', monthly_anchor: null },
    timezone: 'America/New_York',
    recipients: ['a@example.com', 'b@example.com'],
    locale: 'es',
    status: 'active',
    next_run_at: 1_794_000_000,
    last_run: null,
    canceled_at: null,
    ...overrides,
  };
}

describe('the schedule form', () => {
  it('builds the request a create and an edit both send', () => {
    const built = buildReportScheduleBody(
      form({ recipients: 'a@example.com, b@example.com\nc@example.com', currency: 'EUR' }),
    );
    expect(built).toEqual({
      ok: true,
      body: {
        report_type: 'balance.summary.1',
        parameters: { currency: 'EUR' },
        schedule: { interval: 'monthly', monthly_anchor: 1 },
        timezone: 'Europe/Madrid',
        recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
        locale: 'en',
      },
    });
  });

  it('names only the anchor the cadence needs', () => {
    const weekly = buildReportScheduleBody(form({ interval: 'weekly', weeklyAnchor: 'sunday' }));
    expect(weekly.ok && weekly.body.schedule).toEqual({
      interval: 'weekly',
      weekly_anchor: 'sunday',
    });
    const daily = buildReportScheduleBody(form({ interval: 'daily' }));
    expect(daily.ok && daily.body.schedule).toEqual({ interval: 'daily' });
  });

  it('refuses what the gateway would, before asking it', () => {
    const error = (overrides: Partial<ReportScheduleForm>) => {
      const built = buildReportScheduleBody(form(overrides));
      return built.ok ? null : built.error;
    };
    expect(error({ reportType: '' })).toBe('type');
    expect(error({ monthlyAnchor: '0' })).toBe('monthlyAnchor');
    expect(error({ monthlyAnchor: '32' })).toBe('monthlyAnchor');
    expect(error({ monthlyAnchor: 'x' })).toBe('monthlyAnchor');
    // A daily schedule ignores the day of the month entirely.
    expect(error({ interval: 'daily', monthlyAnchor: 'x' })).toBeNull();
    expect(error({ timezone: 'Mars/Olympus' })).toBe('timezone');
    expect(error({ recipients: 'not-an-address' })).toBe('recipient');
    expect(error({ recipients: 'A@example.com, a@example.com' })).toBe('duplicateRecipient');
    expect(
      error({
        recipients: Array.from({ length: 11 }, (_, i) => `p${String(i)}@example.com`).join(','),
      }),
    ).toBe('tooManyRecipients');
  });

  it('reads recipients however they were separated', () => {
    expect(parseRecipients(' a@x.io ,b@x.io;\n\nc@x.io ')).toEqual(['a@x.io', 'b@x.io', 'c@x.io']);
    expect(parseRecipients('')).toEqual([]);
    expect(recipientsProblem([])).toBeNull();
  });

  it('opens a stored schedule as the form that edits it, round trip', () => {
    const edited = scheduleForm(schedule());
    expect(edited).toMatchObject({
      reportType: 'payments.itemized.1',
      currency: 'EUR',
      columns: ['payment_intent_id', 'amount'],
      interval: 'weekly',
      weeklyAnchor: 'friday',
      timezone: 'America/New_York',
      recipients: 'a@example.com, b@example.com',
      locale: 'es',
    });
    const built = buildReportScheduleBody(edited);
    expect(built.ok && built.body).toEqual({
      report_type: 'payments.itemized.1',
      parameters: { currency: 'EUR', columns: ['payment_intent_id', 'amount'] },
      schedule: { interval: 'weekly', weekly_anchor: 'friday' },
      timezone: 'America/New_York',
      recipients: ['a@example.com', 'b@example.com'],
      locale: 'es',
    });
  });

  it("starts in the person's language", () => {
    expect(emptyScheduleForm('', 'es').locale).toBe('es');
    expect(emptyScheduleForm('', 'fr').locale).toBe('en');
    expect(isTimeZone(emptyScheduleForm('', 'en').timezone)).toBe(true);
  });
});

describe('a schedule as it reads', () => {
  it('words its cadence in both languages', () => {
    expect(cadenceLabel({ interval: 'daily', weekly_anchor: null, monthly_anchor: null })).toBe(
      'Daily',
    );
    expect(cadenceLabel(schedule().schedule)).toBe('Weekly on Friday');
    expect(cadenceLabel({ interval: 'monthly', weekly_anchor: null, monthly_anchor: 31 })).toBe(
      'Monthly on day 31',
    );
    setLocale('es');
    expect(cadenceLabel(schedule().schedule)).toBe('Cada semana, el viernes');
  });

  it('offers only what its status allows', () => {
    expect(scheduleActions('active')).toEqual(['edit', 'pause', 'cancel']);
    expect(scheduleActions('paused')).toEqual(['edit', 'resume', 'cancel']);
    expect(scheduleActions('canceled')).toEqual([]);
    expect(scheduleStatusTone('active')).toBe('success');
  });
});
