import type {
  CreateReportRunParams,
  List,
  ListParams,
  ListReportRunsParams,
  ReportRun,
  ReportType,
  ReportTypeId,
} from '@peable.to/shared-types';
import type { PeableRequestOptions, RestClient } from '../core/client';
import { requestOptionsOf } from '../core/client';
import { type ApiListPromise, listPromise, listQuery } from '../core/list';

export type ReportTypeList = List<ReportType>;
export type ReportRunList = List<ReportRun>;

export interface ReportRunListParams extends ListParams, ListReportRunsParams {}

/**
 * What can be run (`payments.itemized.1`, `balance.summary.1`,
 * `payouts.itemized.1`) and over which interval data exists. A complete set:
 * one page, `has_more: false`.
 */
export class ReportTypesResource {
  constructor(private readonly client: RestClient) {}

  list(): Promise<ReportTypeList> {
    return this.client.request<ReportTypeList>('GET', '/v1/reporting/report_types');
  }

  retrieve(id: ReportTypeId): Promise<ReportType> {
    return this.client.request<ReportType>(
      'GET',
      `/v1/reporting/report_types/${encodeURIComponent(id)}`,
    );
  }
}

/**
 * Report runs (`frr_…`): ask for a report over `[interval_start,
 * interval_end)`, and Peable produces its CSV in the background. The run
 * answers `pending`; it becomes `succeeded` with `result` — a
 * `finance_report_run` file, read with `files.contents(result.id)` — or
 * `failed` with `error`, announced by `reporting.report_run.succeeded` /
 * `.failed`.
 *
 *   const run = await peable.reporting.reportRuns.create({
 *     report_type: 'payments.itemized.1',
 *     parameters: { interval_start, interval_end },
 *   });
 */
export class ReportRunsResource {
  constructor(private readonly client: RestClient) {}

  create(params: CreateReportRunParams, options: PeableRequestOptions = {}): Promise<ReportRun> {
    return this.client.request<ReportRun>('POST', '/v1/reporting/report_runs', {
      body: params,
      ...requestOptionsOf(options),
    });
  }

  retrieve(id: string): Promise<ReportRun> {
    return this.client.request<ReportRun>(
      'GET',
      `/v1/reporting/report_runs/${encodeURIComponent(id)}`,
    );
  }

  /** Your runs, newest first — or one report type's. */
  list(params: ReportRunListParams = {}): ApiListPromise<ReportRun> {
    return listPromise(
      (page: ReportRunListParams) =>
        this.client.request<ReportRunList>('GET', '/v1/reporting/report_runs', {
          query: listQuery(page, { report_type: page.report_type }),
        }),
      params,
    );
  }
}

/** Stripe's `reporting` namespace. */
export class ReportingResource {
  readonly reportTypes: ReportTypesResource;
  readonly reportRuns: ReportRunsResource;

  constructor(client: RestClient) {
    this.reportTypes = new ReportTypesResource(client);
    this.reportRuns = new ReportRunsResource(client);
  }
}
