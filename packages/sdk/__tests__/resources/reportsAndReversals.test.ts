/**
 * The report download, a settlement's reversals and the per-payment event
 * filter: each case asserts the ROUTE (method, path, query) and the headers.
 */
import { resources } from '../support/testGateway';
import { describe, expect, test } from 'bun:test';
import { PeableInvalidRequestError } from '../../src/core/errors';
import { createMockFetch, type CapturedRequest, type MockResponseSpec } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

function gateway(reply: MockResponseSpec) {
  return createMockFetch((req) => {
    if (req.url.includes('/auth/service-token')) return serviceTokenMintResponse();
    return reply;
  });
}

function callOf(requests: CapturedRequest[]): CapturedRequest {
  const call = requests.find((r) => !r.url.includes('/auth/service-token'));
  if (!call) throw new Error('no gateway call was made');
  return call;
}

describe('reporting.reportTypes.download', () => {
  test('streams the report over the interval, with its columns, asking for CSV', async () => {
    const csv = 'payment_intent_id,amount\r\n';
    const mock = gateway({ status: 200, text: csv, headers: { 'Content-Type': 'text/csv' } });
    const response = await resources(buildTestClient(mock.fetch)).reporting.reportTypes.download(
      'payments.itemized.1',
      { interval_start: 100, interval_end: 200, columns: ['payment_intent_id', 'amount'] },
    );
    expect(new TextDecoder().decode(response.bytes)).toBe(csv);
    expect(response.contentType).toBe('text/csv');
    const call = callOf(mock.requests);
    expect(call.method).toBe('GET');
    expect(decodeURIComponent(call.url)).toBe(
      `${TEST_GATEWAY_URL}/v1/reporting/report_types/payments.itemized.1/csv?interval_start=100&interval_end=200&columns[]=payment_intent_id&columns[]=amount`,
    );
    expect(call.headers.get('accept')).toBe('text/csv');
  });

  test('throws the typed error for a refusal, before any CSV', async () => {
    const mock = gateway({
      status: 400,
      json: { error: { type: 'invalid_request_error', message: 'bad', request_id: 'req_1' } },
    });
    await expect(
      resources(buildTestClient(mock.fetch)).reporting.reportTypes.download('refunds.itemized.1', {
        interval_start: 2,
        interval_end: 1,
      }),
    ).rejects.toBeInstanceOf(PeableInvalidRequestError);
  });
});

describe('transfers.listReversals', () => {
  test('reads a settlement’s reversals', async () => {
    const page = {
      object: 'list' as const,
      data: [],
      has_more: false,
      url: '/v1/transfers/tr_1/reversals',
    };
    const mock = gateway({ status: 200, json: page });
    expect(await resources(buildTestClient(mock.fetch)).transfers.listReversals('tr_1')).toEqual(
      page,
    );
    const call = callOf(mock.requests);
    expect([call.method, call.url]).toEqual([
      'GET',
      `${TEST_GATEWAY_URL}/v1/transfers/tr_1/reversals`,
    ]);
  });
});

describe('events.list', () => {
  test('narrows to one payment', async () => {
    const mock = gateway({
      status: 200,
      json: { object: 'list', data: [], has_more: false, url: '/v1/events' },
    });
    await resources(buildTestClient(mock.fetch)).events.list({
      payment_intent: 'pi_1',
      limit: 5,
    });
    const url = new URL(callOf(mock.requests).url);
    expect(url.pathname).toBe('/v1/events');
    expect(url.searchParams.get('payment_intent')).toBe('pi_1');
  });
});
