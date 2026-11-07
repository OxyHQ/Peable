import { useQuery } from '@tanstack/react-query';
import type { CreateReportRunParams, ReportRun } from '@peable.to/shared-types';
import { Platform } from 'react-native';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';
import { hasPendingRuns, REPORT_POLL_MS } from './runs';

/** Every reporting key starts with the scope, so a mode switch never shows the other mode's runs. */
export const reportKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'reporting'],
  types: (scope: DashboardScope) => [...reportKeys.all(scope), 'report_types'],
  runs: (scope: DashboardScope) => [...reportKeys.all(scope), 'report_runs'],
  schedules: (scope: DashboardScope) => [...reportKeys.all(scope), 'report_schedules'],
};

/** How many runs the screen shows: the newest page, which is what a merchant is waiting on. */
export const REPORT_RUNS_PAGE = 50;

export function useReportTypes(scope: DashboardScope) {
  return useQuery({
    queryKey: reportKeys.types(scope),
    queryFn: () => dashboardApi.reporting.reportTypes(scope),
  });
}

/**
 * The newest runs — every run, or one schedule's (`frs_…`) — refreshed every
 * few seconds while one is still being produced.
 */
export function useReportRuns(scope: DashboardScope, reportSchedule: string | null = null) {
  return useQuery({
    queryKey: [...reportKeys.runs(scope), reportSchedule ?? 'all'],
    queryFn: () =>
      dashboardApi.reporting.list(scope, {
        limit: REPORT_RUNS_PAGE,
        ...(reportSchedule ? { report_schedule: reportSchedule } : {}),
      }),
    refetchInterval: (query) => {
      const page = query.state.data as ListPage<ReportRun> | undefined;
      return page && hasPendingRuns(page.data) ? REPORT_POLL_MS : false;
    },
  });
}

/** How many schedules the screen shows: a merchant keeps a handful. */
export const REPORT_SCHEDULES_PAGE = 100;

/** The merchant's report schedules, canceled ones included (their runs stay). */
export function useReportSchedules(scope: DashboardScope) {
  return useQuery({
    queryKey: reportKeys.schedules(scope),
    queryFn: () => dashboardApi.reporting.schedules.list(scope, { limit: REPORT_SCHEDULES_PAGE }),
  });
}

/** Whether this runtime can hand a file to the person: a browser can; a native build cannot here. */
export function canSaveFiles(): boolean {
  return Platform.OS === 'web' && typeof document !== 'undefined';
}

/**
 * Hand bytes to the browser as a download named `filename`.
 *
 * @returns `false` when this platform cannot save a file.
 */
export function saveBlob(blob: Blob, filename: string): boolean {
  if (!canSaveFiles()) return false;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // After the click has been handled: revoking at once can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return true;
}

/**
 * Save a run's stored CSV: the bytes, fetched with the signed-in user's
 * bearer, handed to the browser. Elsewhere there is no file system Orbit
 * writes to; the caller says so.
 *
 * @returns `false` when this platform cannot save a file.
 */
export async function downloadReportFile(
  scope: DashboardScope,
  file: { id: string; filename: string },
): Promise<boolean> {
  if (!canSaveFiles()) return false;
  return saveBlob(await dashboardApi.files.contents(scope, file.id), file.filename);
}

/**
 * Download a report NOW — the same request a run takes, streamed by the
 * gateway instead of stored.
 *
 * @returns `false` when this platform cannot save a file.
 */
export async function downloadReportNow(
  scope: DashboardScope,
  body: CreateReportRunParams,
  filename: string,
): Promise<boolean> {
  if (!canSaveFiles()) return false;
  return saveBlob(await dashboardApi.reporting.download(scope, body), filename);
}
