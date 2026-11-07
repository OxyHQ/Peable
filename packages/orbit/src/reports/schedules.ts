/**
 * Report schedules on the Reports screen, pure (`schedules.test.ts`): the form
 * as the ONE request a create and an edit send, a schedule back as a form,
 * the recipients a person typed, and how a cadence and a status read.
 *
 * A schedule fires at local midnight in its time zone, every day, on a
 * weekday or on a day of the month (a shorter month fires on its last day),
 * and each run covers the time since the previous one. Its recipients receive
 * a link to Orbit, never the file.
 */
import type {
  CreateReportScheduleParams,
  CurrencyCode,
  ReportSchedule,
  ReportScheduleInterval,
  ReportScheduleLocale,
  ReportScheduleStatus,
  ReportScheduleWeekday,
  ReportTypeId,
} from '@peable.to/shared-types';
// The browser-safe subpath: Metro does not tree-shake the root barrel.
import {
  REPORT_SCHEDULE_MAX_RECIPIENTS,
  REPORT_SCHEDULE_WEEKDAYS,
} from '@peable.to/shared-types/reporting';
import { t } from '../i18n';
import type { StatusTone } from '../payments/status';

export interface ReportScheduleForm {
  reportType: ReportTypeId | '';
  /** `''` for every currency. */
  currency: CurrencyCode | '';
  /** The columns to write; absent for the report's default columns. */
  columns?: readonly string[];
  interval: ReportScheduleInterval;
  weeklyAnchor: ReportScheduleWeekday;
  /** The day of the month as typed, `1`–`31`. */
  monthlyAnchor: string;
  /** IANA: `Europe/Madrid`. */
  timezone: string;
  /** Addresses as typed: separated by commas, spaces or new lines. */
  recipients: string;
  locale: ReportScheduleLocale;
}

export type ReportScheduleFormError =
  | 'type'
  | 'monthlyAnchor'
  | 'timezone'
  | 'recipient'
  | 'duplicateRecipient'
  | 'tooManyRecipients';

export const SCHEDULE_FORM_ERRORS: Record<ReportScheduleFormError, string> = {
  type: 'reports.schedules.invalid.type',
  monthlyAnchor: 'reports.schedules.invalid.monthlyAnchor',
  timezone: 'reports.schedules.invalid.timezone',
  recipient: 'reports.schedules.invalid.recipient',
  duplicateRecipient: 'reports.schedules.invalid.duplicateRecipient',
  tooManyRecipients: 'reports.schedules.invalid.tooManyRecipients',
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The person's time zone, else UTC. */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Whether this runtime knows `zone` as an IANA time zone (the gateway checks again). */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The addresses typed, in order, without blanks. */
export function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

/** Why the recipients cannot be sent, or `null`. */
export function recipientsProblem(addresses: readonly string[]): ReportScheduleFormError | null {
  if (addresses.some((address) => address.length > 254 || !EMAIL.test(address))) {
    return 'recipient';
  }
  const lowered = addresses.map((address) => address.toLowerCase());
  if (new Set(lowered).size !== lowered.length) return 'duplicateRecipient';
  if (addresses.length > REPORT_SCHEDULE_MAX_RECIPIENTS) return 'tooManyRecipients';
  return null;
}

/**
 * The request for what the form says — a create's body, and an edit's: an
 * edit sends every field, so what the person sees is what is stored (an
 * absent column list or currency clears it back to the report's defaults).
 */
export function buildReportScheduleBody(
  form: ReportScheduleForm,
):
  | { ok: true; body: CreateReportScheduleParams & { parameters: object } }
  | { ok: false; error: ReportScheduleFormError } {
  if (form.reportType === '') return { ok: false, error: 'type' };
  let monthly: number | undefined;
  if (form.interval === 'monthly') {
    const day = form.monthlyAnchor.trim();
    monthly = /^\d{1,2}$/.test(day) ? Number(day) : Number.NaN;
    if (!Number.isInteger(monthly) || monthly < 1 || monthly > 31) {
      return { ok: false, error: 'monthlyAnchor' };
    }
  }
  const timezone = form.timezone.trim();
  if (!isTimeZone(timezone)) return { ok: false, error: 'timezone' };
  const recipients = parseRecipients(form.recipients);
  const problem = recipientsProblem(recipients);
  if (problem !== null) return { ok: false, error: problem };
  return {
    ok: true,
    body: {
      report_type: form.reportType,
      parameters: {
        ...(form.currency ? { currency: form.currency } : {}),
        ...(form.columns ? { columns: [...form.columns] } : {}),
      },
      schedule: {
        interval: form.interval,
        ...(form.interval === 'weekly' ? { weekly_anchor: form.weeklyAnchor } : {}),
        ...(monthly !== undefined ? { monthly_anchor: monthly } : {}),
      },
      timezone,
      recipients,
      locale: form.locale,
    },
  };
}

/** A new schedule's form: the first of each month, in the person's zone and language. */
export function emptyScheduleForm(
  reportType: ReportTypeId | '',
  locale: string,
): ReportScheduleForm {
  return {
    reportType,
    currency: '',
    interval: 'monthly',
    weeklyAnchor: 'monday',
    monthlyAnchor: '1',
    timezone: defaultTimeZone(),
    recipients: '',
    locale: locale === 'es' ? 'es' : 'en',
  };
}

/** A stored schedule as the form that edits it. */
export function scheduleForm(schedule: ReportSchedule): ReportScheduleForm {
  return {
    reportType: schedule.report_type,
    currency: schedule.parameters.currency ?? '',
    ...(schedule.parameters.columns ? { columns: schedule.parameters.columns } : {}),
    interval: schedule.schedule.interval,
    weeklyAnchor: schedule.schedule.weekly_anchor ?? 'monday',
    monthlyAnchor: String(schedule.schedule.monthly_anchor ?? 1),
    timezone: schedule.timezone,
    recipients: schedule.recipients.join(', '),
    locale: schedule.locale,
  };
}

export function weekdayLabel(day: ReportScheduleWeekday): string {
  return t(`reports.schedules.weekday.${day}`);
}

export const WEEKDAYS: readonly ReportScheduleWeekday[] = REPORT_SCHEDULE_WEEKDAYS;

/** `Daily`, `Weekly on Monday`, `Monthly on day 1`. */
export function cadenceLabel(cadence: ReportSchedule['schedule']): string {
  switch (cadence.interval) {
    case 'daily':
      return t('reports.schedules.cadence.daily');
    case 'weekly':
      return t('reports.schedules.cadence.weekly', {
        day: weekdayLabel(cadence.weekly_anchor ?? 'monday'),
      });
    case 'monthly':
      return t('reports.schedules.cadence.monthly', { day: String(cadence.monthly_anchor ?? 1) });
  }
}

const TONES: Record<ReportScheduleStatus, StatusTone> = {
  active: 'success',
  paused: 'warning',
  canceled: 'neutral',
};

export function scheduleStatusTone(status: ReportScheduleStatus): StatusTone {
  return TONES[status];
}

export function scheduleStatusLabel(status: ReportScheduleStatus): string {
  return t(`reports.schedules.status.${status}`);
}

/** What a person may still do with a schedule: a canceled one only shows its runs. */
export function scheduleActions(
  status: ReportScheduleStatus,
): readonly ('edit' | 'pause' | 'resume' | 'cancel')[] {
  switch (status) {
    case 'active':
      return ['edit', 'pause', 'cancel'];
    case 'paused':
      return ['edit', 'resume', 'cancel'];
    case 'canceled':
      return [];
  }
}
