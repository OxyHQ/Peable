/**
 * Reporting (Stripe's `reporting.*`) and reading a report back: the routes,
 * the create body, list pagination by `report_type`, and the CSV bytes from
 * `files.contents`.
 */
import { describe, expect, test } from 'bun:test';
import type { ReportRun, ReportType } from '@peable.to/shared-types';
import { Peable } from '../../src';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { FilesResource } from '../../src/resources/files';
import {
  ReportingResource,
  ReportRunsResource,
  ReportTypesResource,
} from '../../src/resources/reporting';
import { createMockFetch, type CapturedRequest } from '../support/mockFetch';
import { buildTestClient, serviceTokenMintResponse } from '../support/testGateway';

const RUN: ReportRun = {
  id: 'frr_1',
  object: 'reporting.report_run',
  livemode: false,
  created: 1_780_000_000,
  report_type: 'payments.itemized.1',
  parameters: { interval_start: 1_779_900_000, interval_end: 1_780_000_000 },
  status: 'pending',
  error: null,
  result: null,
  succeeded_at: null,
};

const TYPE: ReportType = {
  id: 'balance.summary.1',
  object: 'reporting.report_type',
  livemode: false,
  name: 'Balance summary',
  version: 1,
  columns: ['category', 'description', 'currency', 'net_amount', 'transaction_count'],
  default_columns: ['category', 'description', 'currency', 'net_amount'],
  data_available_start: 1_700_000_000,
  data_available_end: 1_780_000_000,
  updated: 1_793_664_000,
};

function gateway(body: unknown, status = 200) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return { status, json: body };
  });
}

function callOf(requests: CapturedRequest[]): CapturedRequest {
  const call = requests.find((r) => !r.url.includes('/auth/service-token'));
  if (!call) throw new Error('no gateway call was made');
  return call;
}

describe('reporting.reportTypes', () => {
  test('list and retrieve', async () => {
    const many = gateway({ object: 'list', data: [TYPE], has_more: false, url: '/x' });
    const page = await new ReportTypesResource(buildTestClient(many.fetch)).list();
    expect(page.data[0]?.id).toBe('balance.summary.1');
    expect(new URL(callOf(many.requests).url).pathname).toBe('/v1/reporting/report_types');

    const one = gateway(TYPE);
    await new ReportTypesResource(buildTestClient(one.fetch)).retrieve('balance.summary.1');
    expect(new URL(callOf(one.requests).url).pathname).toBe(
      '/v1/reporting/report_types/balance.summary.1',
    );
  });
});

describe('reporting.reportRuns', () => {
  test('create posts the report type and parameters, with an idempotency key', async () => {
    const mock = gateway(RUN);
    const run = await new ReportRunsResource(buildTestClient(mock.fetch)).create({
      report_type: 'payments.itemized.1',
      parameters: {
        interval_start: 1_779_900_000,
        interval_end: 1_780_000_000,
        columns: ['payment_intent_id', 'amount'],
        currency: 'EUR',
      },
    });
    expect(run.status).toBe('pending');
    const call = callOf(mock.requests);
    expect([call.method, new URL(call.url).pathname]).toEqual([
      'POST',
      '/v1/reporting/report_runs',
    ]);
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      report_type: 'payments.itemized.1',
      parameters: {
        interval_start: 1_779_900_000,
        interval_end: 1_780_000_000,
        columns: ['payment_intent_id', 'amount'],
        currency: 'EUR',
      },
    });
    expect(call.headers.get('Idempotency-Key')).toBeTruthy();
  });

  test('retrieve, and a list filtered by report_type that pages on', async () => {
    const one = gateway(RUN);
    await new ReportRunsResource(buildTestClient(one.fetch)).retrieve('frr_1');
    expect(new URL(callOf(one.requests).url).pathname).toBe('/v1/reporting/report_runs/frr_1');

    const pages = [
      { object: 'list', data: [RUN], has_more: true, url: '/v1/reporting/report_runs' },
      {
        object: 'list',
        data: [{ ...RUN, id: 'frr_0' }],
        has_more: false,
        url: '/v1/reporting/report_runs',
      },
    ];
    let served = 0;
    const many = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      const page = pages[served];
      served += 1;
      return { status: 200, json: page };
    });
    const ids = await new ReportRunsResource(buildTestClient(many.fetch))
      .list({ report_type: 'payments.itemized.1' })
      .autoPagingToArray({ limit: 10 });
    expect(ids.map((run) => run.id)).toEqual(['frr_1', 'frr_0']);
    const urls = many.requests
      .filter((r) => !r.url.includes('/auth/service-token'))
      .map((r) => new URL(r.url).searchParams);
    expect(urls.map((q) => q.get('report_type'))).toEqual([
      'payments.itemized.1',
      'payments.itemized.1',
    ]);
    expect(urls[1]?.get('starting_after')).toBe('frr_1');
  });

  test('is wired on the client as peable.reporting', () => {
    const peable = new Peable({ publicKey: 'oxy_dk_test', secret: 'sk_test' });
    expect(peable.reporting).toBeInstanceOf(ReportingResource);
    expect(peable.reporting.reportRuns).toBeInstanceOf(ReportRunsResource);
    expect(peable.reporting.reportTypes).toBeInstanceOf(ReportTypesResource);
  });
});

describe('files.contents', () => {
  test('answers the CSV bytes, its type and its name', async () => {
    const csv = 'payment_intent_id,amount\r\npi_1,2500\r\n';
    const mock = createMockFetch((req) => {
      if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
      return {
        status: 200,
        text: csv,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="payments.itemized.1-frr_1.csv"',
        },
      };
    });
    const downloaded = await new FilesResource(buildTestClient(mock.fetch)).contents('file_1');
    expect(new TextDecoder().decode(downloaded.bytes)).toBe(csv);
    expect(downloaded.contentType).toBe('text/csv; charset=utf-8');
    expect(downloaded.filename).toBe('payments.itemized.1-frr_1.csv');
    const call = callOf(mock.requests);
    expect([call.method, new URL(call.url).pathname]).toEqual(['GET', '/v1/files/file_1/contents']);
    expect(call.headers.get('Authorization')).toMatch(/^Bearer /);
  });

  test('a refusal is the typed error', async () => {
    const mock = gateway(
      {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          param: 'id',
          message: 'file not found',
          request_id: 'req_1',
        },
      },
      404,
    );
    await expect(
      new FilesResource(buildTestClient(mock.fetch)).contents('file_evidence'),
    ).rejects.toBeInstanceOf(PeableInvalidRequestError);
  });
});
