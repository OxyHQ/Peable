import { describe, expect, it } from 'bun:test';
import type { FileObject, ReportRun, ReportType } from '@peable.to/shared-types';
import { REPORT_TYPE_IDS, REPORT_TYPE_LAYOUTS } from '@peable.to/shared-types/reporting';
import {
  REPORT_TYPE_IDS as ROOT_REPORT_TYPE_IDS,
  REPORT_TYPE_LAYOUTS as ROOT_REPORT_TYPE_LAYOUTS,
} from '@peable.to/shared-types';
import {
  buildReportRunBody,
  downloadableFile,
  downloadFilename,
  presetDays,
  hasPendingRuns,
  intervalLabel,
  type ReportRunForm,
  reportRunStatusLabel,
  reportTypeName,
  utcMidnight,
} from './runs';

const OCT_1 = Date.UTC(2026, 9, 1) / 1000;
const NOV_1 = Date.UTC(2026, 10, 1) / 1000;
const NOV_3 = Date.UTC(2026, 10, 3) / 1000;
const NOW = NOV_3 + 12 * 3600;

function run(overrides: Partial<ReportRun> = {}): ReportRun {
  return {
    id: 'frr_1',
    object: 'reporting.report_run',
    livemode: false,
    created: NOW,
    report_type: 'payments.itemized.1',
    parameters: { interval_start: OCT_1, interval_end: NOV_1 },
    status: 'pending',
    error: null,
    result: null,
    succeeded_at: null,
    ...overrides,
  };
}

const file: FileObject = {
  id: 'file_1',
  object: 'file',
  livemode: false,
  purpose: 'finance_report_run',
  filename: 'payments.itemized.1-frr_1.csv',
  size: 10,
  type: 'csv',
  status: 'available',
  url: null,
  created: NOW,
};

describe('utcMidnight', () => {
  it('reads a real UTC day and refuses anything else', () => {
    expect(utcMidnight('2026-10-01')).toBe(OCT_1);
    expect(utcMidnight('2026-02-31')).toBeNull();
    expect(utcMidnight('1/10/2026')).toBeNull();
  });
});

describe('buildReportRunBody', () => {
  const form: ReportRunForm = {
    reportType: 'payments.itemized.1',
    start: '2026-10-01',
    end: '2026-10-31',
    currency: '',
  };

  it('ends the interval at the midnight after the last day, inclusive on screen', () => {
    expect(buildReportRunBody(form, NOW)).toEqual({
      ok: true,
      body: {
        report_type: 'payments.itemized.1',
        parameters: { interval_start: OCT_1, interval_end: NOV_1 },
      },
    });
  });

  it('caps a report of today at now, and carries a currency when chosen', () => {
    expect(
      buildReportRunBody({ ...form, start: '2026-11-03', end: '2026-11-03', currency: 'EUR' }, NOW),
    ).toEqual({
      ok: true,
      body: {
        report_type: 'payments.itemized.1',
        parameters: { interval_start: NOV_3, interval_end: NOW, currency: 'EUR' },
      },
    });
  });

  it('names what is wrong', () => {
    const error = (patch: Partial<ReportRunForm>) => {
      const result = buildReportRunBody({ ...form, ...patch }, NOW);
      return result.ok ? null : result.error;
    };
    expect(error({ reportType: '' })).toBe('type');
    expect(error({ start: 'soon' })).toBe('start');
    expect(error({ end: '' })).toBe('end');
    expect(error({ end: '2026-09-30' })).toBe('order');
    expect(error({ start: '2026-12-01', end: '2026-12-02' })).toBe('future');
  });
});

describe('a run on screen', () => {
  it('keeps refreshing while any run is pending', () => {
    expect(hasPendingRuns([run({ status: 'succeeded' }), run()])).toBe(true);
    expect(hasPendingRuns([run({ status: 'failed', error: 'x' })])).toBe(false);
  });

  it('offers the file of a succeeded run only while it is available', () => {
    expect(downloadableFile(run({ status: 'succeeded', result: file }))).toEqual({
      id: 'file_1',
      filename: 'payments.itemized.1-frr_1.csv',
    });
    expect(
      downloadableFile(run({ status: 'succeeded', result: { ...file, status: 'removed' } })),
    ).toBeNull();
    expect(downloadableFile(run())).toBeNull();
  });

  it('shows the interval with its last day inclusive', () => {
    expect(intervalLabel(run())).toBe('2026-10-01 – 2026-10-31');
    expect(intervalLabel(run({ parameters: { interval_start: OCT_1, interval_end: NOW } }))).toBe(
      '2026-10-01 – 2026-11-03',
    );
  });

  it('words the status and names the report by its type', () => {
    expect(reportRunStatusLabel('succeeded')).toBe('Ready');
    const types = [{ id: 'balance.summary.1', name: 'Balance summary' }] as ReportType[];
    expect(reportTypeName(types, 'balance.summary.1')).toBe('Balance summary');
    expect(reportTypeName(types, 'payouts.itemized.1')).toBe('payouts.itemized.1');
  });
});

describe('one request for a run and a download', () => {
  it('carries the chosen columns, or none for the defaults', () => {
    const form: ReportRunForm = {
      reportType: 'refunds.itemized.1',
      start: '2026-10-01',
      end: '2026-10-31',
      currency: '',
    };
    expect(buildReportRunBody(form, NOW)).toEqual({
      ok: true,
      body: {
        report_type: 'refunds.itemized.1',
        parameters: { interval_start: OCT_1, interval_end: NOV_1 },
      },
    });
    const columns = REPORT_TYPE_LAYOUTS['refunds.itemized.1'].columns;
    expect(buildReportRunBody({ ...form, columns }, NOW)).toEqual({
      ok: true,
      body: {
        report_type: 'refunds.itemized.1',
        parameters: { interval_start: OCT_1, interval_end: NOV_1, columns: [...columns] },
      },
    });
    expect(downloadFilename(form)).toBe('refunds.itemized.1_2026-10-01_2026-10-31.csv');
  });

  it('reads the layouts from the browser-safe subpath, the same as the root', () => {
    expect(REPORT_TYPE_IDS).toEqual(ROOT_REPORT_TYPE_IDS);
    expect(REPORT_TYPE_LAYOUTS).toEqual(ROOT_REPORT_TYPE_LAYOUTS);
  });
});

describe('presetDays', () => {
  it('counts today in the last N days', () => {
    expect(presetDays('last7', NOW)).toEqual({ start: '2026-10-28', end: '2026-11-03' });
    expect(presetDays('last30', NOW)).toEqual({ start: '2026-10-05', end: '2026-11-03' });
  });

  it('spans calendar months in UTC, across a year boundary too', () => {
    expect(presetDays('thisMonth', NOW)).toEqual({ start: '2026-11-01', end: '2026-11-03' });
    expect(presetDays('lastMonth', NOW)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(presetDays('lastMonth', Date.UTC(2027, 0, 10) / 1000)).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    });
  });
});
