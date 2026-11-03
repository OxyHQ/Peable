/**
 * The Reports screen's decisions, pure (`runs.test.ts`): turning the form into
 * the ONE request both ways of getting a report take — a run
 * (`POST …/reporting/report_runs`) and a download
 * (`GET …/reporting/report_types/:id/csv`) — the period presets, wording a run,
 * and whether the list must keep refreshing.
 */
import type {
  CreateReportRunParams,
  CurrencyCode,
  ReportRun,
  ReportRunStatus,
  ReportType,
  ReportTypeId,
} from '@peable.to/shared-types';
import { t } from '../i18n';
import type { StatusTone } from '../payments/status';

export interface ReportRunForm {
  reportType: ReportTypeId | '';
  /** `YYYY-MM-DD`, UTC. */
  start: string;
  /** `YYYY-MM-DD`, UTC, INCLUSIVE. */
  end: string;
  /** `''` for every currency. */
  currency: CurrencyCode | '';
  /** The columns to write, in the layout's order; absent for the report's default columns. */
  columns?: readonly string[];
}

export type ReportRunFormError = 'type' | 'start' | 'end' | 'order' | 'future';

const DAY = 86_400;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → Unix seconds of its UTC midnight, or `null` for anything else. */
export function utcMidnight(day: string): number | null {
  if (!ISO_DAY.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  // `Date.parse` rolls 2026-02-31 over to March; a day that does not round-trip is not a day.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
  return ms / 1000;
}

/**
 * The request for what the form says. The last day is inclusive on screen, so
 * `interval_end` is the midnight AFTER it — capped at `now`, because the
 * gateway refuses an interval that ends in the future (a report of today
 * covers today so far).
 */
export function buildReportRunBody(
  form: ReportRunForm,
  now: number,
): { ok: true; body: CreateReportRunParams } | { ok: false; error: ReportRunFormError } {
  if (form.reportType === '') return { ok: false, error: 'type' };
  const start = utcMidnight(form.start.trim());
  if (start === null) return { ok: false, error: 'start' };
  const lastDay = utcMidnight(form.end.trim());
  if (lastDay === null) return { ok: false, error: 'end' };
  if (lastDay < start) return { ok: false, error: 'order' };
  if (start >= now) return { ok: false, error: 'future' };
  const end = Math.min(lastDay + DAY, now);
  return {
    ok: true,
    body: {
      report_type: form.reportType,
      parameters: {
        interval_start: start,
        interval_end: end,
        ...(form.currency ? { currency: form.currency } : {}),
        ...(form.columns ? { columns: [...form.columns] } : {}),
      },
    },
  };
}

export const REPORT_FORM_ERRORS: Record<ReportRunFormError, string> = {
  type: 'reports.invalid.type',
  start: 'reports.invalid.start',
  end: 'reports.invalid.end',
  order: 'reports.invalid.order',
  future: 'reports.invalid.future',
};

const TONES: Record<ReportRunStatus, StatusTone> = {
  pending: 'info',
  succeeded: 'success',
  failed: 'danger',
};

export function reportRunStatusTone(status: ReportRunStatus): StatusTone {
  return TONES[status];
}

export function reportRunStatusLabel(status: ReportRunStatus): string {
  return t(`reports.status.${status}`);
}

/** A run's report, by the name its type carries; the id when the type is unknown here. */
export function reportTypeName(types: readonly ReportType[], id: ReportTypeId): string {
  return types.find((type) => type.id === id)?.name ?? id;
}

/** Whether any run is still being produced — the list refreshes until none is. */
export function hasPendingRuns(runs: readonly ReportRun[]): boolean {
  return runs.some((run) => run.status === 'pending');
}

/** How often the list refreshes while a run is pending. */
export const REPORT_POLL_MS = 3_000;

/** The run's CSV, when it can be downloaded: succeeded, with an available file. */
export function downloadableFile(run: ReportRun): { id: string; filename: string } | null {
  if (run.status !== 'succeeded' || run.result === null) return null;
  if (run.result.status !== 'available') return null;
  return { id: run.result.id, filename: run.result.filename ?? `${run.id}.csv` };
}

/** `2026-10-01 – 2026-10-31` for an interval in Unix seconds, the last day shown inclusive. */
export function intervalLabel(run: Pick<ReportRun, 'parameters'>): string {
  const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
  const { interval_start: start, interval_end: end } = run.parameters;
  // An end at midnight closes the day before it; one inside a day closes that day.
  const last = end % DAY === 0 ? end - DAY : end;
  return `${day(start)} – ${day(Math.max(start, last))}`;
}

export const REPORT_PRESETS = ['last7', 'last30', 'thisMonth', 'lastMonth'] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

const dayOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** A preset's first and last day (both inclusive, UTC), relative to `now` — today included. */
export function presetDays(preset: ReportPreset, now: number): { start: string; end: string } {
  const today = new Date(now * 1000);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  switch (preset) {
    case 'last7':
      return { start: dayOf(now - 6 * DAY), end: dayOf(now) };
    case 'last30':
      return { start: dayOf(now - 29 * DAY), end: dayOf(now) };
    case 'thisMonth':
      return { start: dayOf(Date.UTC(year, month, 1) / 1000), end: dayOf(now) };
    case 'lastMonth':
      return {
        start: dayOf(Date.UTC(year, month - 1, 1) / 1000),
        end: dayOf(Date.UTC(year, month, 1) / 1000 - DAY),
      };
  }
}

/** What a downloaded report is saved as: `payments.itemized.1_2026-10-01_2026-10-31.csv`. */
export function downloadFilename(
  form: Pick<ReportRunForm, 'reportType' | 'start' | 'end'>,
): string {
  return `${form.reportType}_${form.start.trim()}_${form.end.trim()}.csv`;
}
