import { useQuery } from '@tanstack/react-query';
import type { ReportRun } from '@peable.to/shared-types';
import { Platform } from 'react-native';
import { dashboardApi } from '../api/client';
import type { DashboardScope, ListPage } from '../api/dashboard';
import { hasPendingRuns, REPORT_POLL_MS } from './runs';

/** Every reporting key starts with the scope, so a mode switch never shows the other mode's runs. */
export const reportKeys = {
  all: (scope: DashboardScope) => ['orbit', scope.applicationId, scope.environment, 'reporting'],
  types: (scope: DashboardScope) => [...reportKeys.all(scope), 'report_types'],
  runs: (scope: DashboardScope) => [...reportKeys.all(scope), 'report_runs'],
};

/** How many runs the screen shows: the newest page, which is what a merchant is waiting on. */
export const REPORT_RUNS_PAGE = 50;

export function useReportTypes(scope: DashboardScope) {
  return useQuery({
    queryKey: reportKeys.types(scope),
    queryFn: () => dashboardApi.reporting.reportTypes(scope),
  });
}

/** The newest runs, refreshed every few seconds while one is still being produced. */
export function useReportRuns(scope: DashboardScope) {
  return useQuery({
    queryKey: reportKeys.runs(scope),
    queryFn: () => dashboardApi.reporting.list(scope, { limit: REPORT_RUNS_PAGE }),
    refetchInterval: (query) => {
      const page = query.state.data as ListPage<ReportRun> | undefined;
      return page && hasPendingRuns(page.data) ? REPORT_POLL_MS : false;
    },
  });
}

/**
 * Save a report's CSV. On the web: the bytes, fetched with the signed-in
 * user's bearer, handed to the browser as a download. Elsewhere there is no
 * file system Orbit writes to; the caller says so.
 *
 * @returns `false` when this platform cannot save a file.
 */
export async function downloadReportFile(
  scope: DashboardScope,
  file: { id: string; filename: string },
): Promise<boolean> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
  const blob = await dashboardApi.files.contents(scope, file.id);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
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
