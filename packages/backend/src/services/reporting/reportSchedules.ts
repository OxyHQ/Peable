/**
 * What a report schedule may be: the one check for a create and an update
 * (`routes/reporting.ts`), and the first occurrence after now.
 *
 * - The anchor its interval needs and no other (`weekly_anchor` for weekly,
 *   `monthly_anchor` for monthly).
 * - An IANA time zone this runtime knows — the database has no zone list, so
 *   this is where an unknown one is refused.
 * - The run template's columns pass the same rule a run's do
 *   (`reportColumnsProblem`).
 * - Recipients are addresses (the contract's), each once, case-insensitively.
 */
import type {
  CurrencyCode,
  ReportScheduleInterval,
  ReportScheduleLocale,
  ReportScheduleWeekday,
  ReportTypeId,
} from '@peable.to/shared-types';
import type {
  ReportScheduleFields,
  ReportScheduleRow,
} from '../../db/reporting/reportScheduleRepository';
import { reportColumnsProblem } from './reports';
import { isKnownTimeZone, occurrenceAfter } from './scheduleCalendar';

export interface ScheduleRefusal {
  readonly code: 'parameter_invalid' | 'parameter_missing';
  readonly message: string;
  readonly param: string;
}

/** A create's (or a merged update's) parsed parameters. */
export interface ScheduleInput {
  readonly report_type: ReportTypeId;
  readonly parameters?:
    | { readonly columns?: readonly string[] | undefined; readonly currency?: CurrencyCode }
    | undefined;
  readonly schedule: {
    readonly interval: ReportScheduleInterval;
    readonly weekly_anchor?: ReportScheduleWeekday | undefined;
    readonly monthly_anchor?: number | undefined;
  };
  readonly timezone?: string | undefined;
  readonly recipients?: readonly string[] | undefined;
  readonly locale?: ReportScheduleLocale | undefined;
}

export function scheduleFields(
  input: ScheduleInput,
): { ok: true; fields: ReportScheduleFields } | { ok: false; refusal: ScheduleRefusal } {
  const refuse = (code: ScheduleRefusal['code'], message: string, param: string) => ({
    ok: false as const,
    refusal: { code, message, param },
  });
  const { interval, weekly_anchor: weekly, monthly_anchor: monthly } = input.schedule;
  if (interval === 'weekly' && weekly === undefined) {
    return refuse(
      'parameter_missing',
      'a weekly schedule names its day',
      'schedule[weekly_anchor]',
    );
  }
  if (interval !== 'weekly' && weekly !== undefined) {
    return refuse(
      'parameter_invalid',
      'weekly_anchor is only for a weekly schedule',
      'schedule[weekly_anchor]',
    );
  }
  if (interval === 'monthly' && monthly === undefined) {
    return refuse(
      'parameter_missing',
      'a monthly schedule names its day of the month',
      'schedule[monthly_anchor]',
    );
  }
  if (interval !== 'monthly' && monthly !== undefined) {
    return refuse(
      'parameter_invalid',
      'monthly_anchor is only for a monthly schedule',
      'schedule[monthly_anchor]',
    );
  }
  const timezone = input.timezone ?? 'UTC';
  if (!isKnownTimeZone(timezone)) {
    return refuse(
      'parameter_invalid',
      `'${timezone}' is not an IANA time zone (Europe/Madrid, America/New_York, UTC)`,
      'timezone',
    );
  }
  const columns = input.parameters?.columns;
  const columnsProblem = reportColumnsProblem(input.report_type, columns);
  if (columnsProblem !== null) {
    return refuse('parameter_invalid', columnsProblem, 'parameters[columns]');
  }
  const recipients = input.recipients ?? [];
  if (new Set(recipients.map((address) => address.toLowerCase())).size !== recipients.length) {
    return refuse('parameter_invalid', 'an address is named twice', 'recipients');
  }
  return {
    ok: true,
    fields: {
      reportType: input.report_type,
      columns: columns === undefined ? null : [...columns],
      currency: input.parameters?.currency ?? null,
      interval,
      weeklyAnchor: weekly ?? null,
      monthlyAnchor: monthly ?? null,
      timezone,
      recipients: [...recipients],
      locale: input.locale ?? 'en',
    },
  };
}

/** A stored schedule as the input it was created from — an update's base. */
export function scheduleInputOf(row: ReportScheduleRow): ScheduleInput {
  return {
    report_type: row.reportType,
    parameters: {
      ...(row.columns !== null ? { columns: row.columns } : {}),
      ...(row.currency !== null ? { currency: row.currency } : {}),
    },
    schedule: {
      interval: row.interval,
      ...(row.weeklyAnchor !== null ? { weekly_anchor: row.weeklyAnchor } : {}),
      ...(row.monthlyAnchor !== null ? { monthly_anchor: row.monthlyAnchor } : {}),
    },
    timezone: row.timezone,
    recipients: row.recipients,
    locale: row.locale,
  };
}

/** The first occurrence strictly after `now` — a new or resumed schedule's `next_run_at`. */
export function firstOccurrenceAfter(fields: ReportScheduleFields, now: Date): Date {
  return new Date(
    occurrenceAfter(
      {
        interval: fields.interval,
        weeklyAnchor: fields.weeklyAnchor,
        monthlyAnchor: fields.monthlyAnchor,
      },
      fields.timezone,
      now.getTime(),
    ),
  );
}
