/**
 * Report runs end to end against a real Postgres and a fake Oxy Files: the
 * report types, every refusal at creation, the leased worker's lifecycle
 * (produced, refused, deferred, lost), the CSV each report writes, the File it
 * is stored as and its `contents`, the events, and the dashboard's routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { REPORT_TYPE_IDS, REPORT_TYPE_LAYOUTS } from '@peable.to/shared-types';
import { createGateway, type Gateway } from '../../server';
import { createDashboardRouter } from '../dashboard';
import { requestIdMiddleware } from '../../lib/requestId';
import { stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';
import { type MerchantRow, syncMerchantAuthority } from '../../db/merchants/merchantRepository';
import { insertBalanceTransaction } from '../../db/money/ledgerRepository';
import { insertRefund } from '../../db/refunds/refundRepository';
import { upsertDispute } from '../../db/disputes/disputeRepository';
import {
  claimReportRun,
  completeReportRun,
  failReportRun,
} from '../../db/reporting/reportRunRepository';
import { reportRuns } from '../../db/schema';
import { MAX_ATTEMPTS, runReportRunPass } from '../../services/reporting/reportRunWorker';
import { REPORT_COLUMN_NAMES } from '../../services/reporting/reports';
import { config } from '../../config';
import { must } from '../../__tests__/helpers/must';
import { createFakeOxyFiles, type FakeOxyFiles } from '../../__tests__/helpers/fakeOxyFiles';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_orbit_reports';
const MEMBER = 'user_member';
let environment: OxyServiceEnvironment = 'development';
let appId = APP_ID;
/** Whether the stubbed credential is an Oxy first-party workload (Oxy ADR 0049). */
let firstParty = false;
let gateway: Gateway | undefined;
let baseUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchant: MerchantRow;
let files: FakeOxyFiles;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  const identity = {
    appId,
    appName: 'orbit',
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment,
  };
  (req as OxyAuthRequest).serviceApp = firstParty
    ? // An own workload carries live authority, not scopes (Oxy ADR 0049).
      { ...identity, tier: 'internal', authority: 'first_party' }
    : { ...identity, tier: 'external', scopes: ['payments:read', 'payments:write'] };
  next();
};

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = response.headers.get('content-type') ?? '';
  return {
    status: response.status,
    headers: response.headers,
    json: type.includes('json') ? ((await response.json()) as Json) : {},
    text: type.includes('json') ? '' : await response.text(),
  };
}

const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

async function createRun(body: Json) {
  return call('POST', '/v1/reporting/report_runs', body);
}

async function refusedRun(body: Json, param: string | undefined, code = 'parameter_invalid') {
  const answer = await createRun(body);
  const error = answer.json.error as Json;
  expect([answer.status, error.param, error.code]).toEqual([
    param === undefined ? 404 : 400,
    param,
    code,
  ]);
  return error;
}

/** Run worker passes until the queue is empty; the outcomes. */
async function drain(): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const outcome = await runReportRunPass({ files });
    if (outcome === 'idle') return outcomes;
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Let a deferred run's backoff lapse — the database's clock is the lease's. */
async function lapseLeases(): Promise<void> {
  await gatewayDb()
    .update(reportRuns)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(sql`${reportRuns.leaseToken} is not null`);
}

function parseCsv(text: string): string[][] {
  return text
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(','));
}

useGatewayDatabase();

beforeAll(() => {
  files = createFakeOxyFiles();
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
    oxyFiles: {
      ...files,
      storeAppFile: (request) => files.storeAppFile(request),
      linkedDownloadUrls: (ids) => files.linkedDownloadUrls(ids),
    },
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    createDashboardRouter({
      requireOxyUser: (req, _res, next) => {
        const userId = req.header('X-Test-User-Id') ?? MEMBER;
        (req as OxyAuthRequest).userId = userId;
        (req as OxyAuthRequest).accessToken = `token-for-${userId}`;
        next();
      },
      access: stubOxyAccess({
        application: (userId) => (userId === MEMBER ? { ownerAccountId: 'owner' } : undefined),
      }),
      files: {
        ...files,
        linkedDownloadUrls: (ids) => files.linkedDownloadUrls(ids),
      },
    }),
  );
  dashboardServer = app.listen(0);
  dashboardUrl = `http://127.0.0.1:${(dashboardServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
  dashboardServer?.close();
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('report runs', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    environment = 'development';
    appId = APP_ID;
    firstParty = false;
    files.options.failStore = false;
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  test('the report types, their layouts and the data interval', async () => {
    const list = await call('GET', '/v1/reporting/report_types');
    expect(list.status).toBe(200);
    const types = list.json.data as Json[];
    expect(types.map((t) => t.id)).toEqual([...REPORT_TYPE_IDS]);
    const payments = must(types[0]);
    expect(payments).toMatchObject({
      object: 'reporting.report_type',
      livemode: false,
      name: 'Itemized payments',
      version: 1,
      default_columns: REPORT_TYPE_LAYOUTS['payments.itemized.1'].default_columns,
    });
    expect(Number(payments.data_available_end)).toBeGreaterThanOrEqual(now() - 5);
    const one = await call('GET', '/v1/reporting/report_types/balance.summary.1');
    expect(one.json.id).toBe('balance.summary.1');
    expect((await call('GET', '/v1/reporting/report_types/nope.1')).status).toBe(404);
  });

  test('every layout column has exactly one computation', () => {
    for (const id of REPORT_TYPE_IDS) {
      expect([id, [...REPORT_COLUMN_NAMES[id]].sort()]).toEqual([
        id,
        [...REPORT_TYPE_LAYOUTS[id].columns].sort(),
      ]);
    }
  });

  test('refusals at creation', async () => {
    const interval = { interval_start: now() - HOUR, interval_end: now() - 10 };
    await refusedRun(
      { report_type: 'payments.itemized.1', parameters: { interval_start: 10, interval_end: 10 } },
      'parameters[interval_end]',
    );
    await refusedRun(
      {
        report_type: 'payments.itemized.1',
        parameters: { interval_start: 10, interval_end: now() + HOUR },
      },
      'parameters[interval_end]',
    );
    await refusedRun(
      { report_type: 'payments.itemized.1', parameters: { ...interval, columns: ['colour'] } },
      'parameters[columns]',
    );
    await refusedRun(
      {
        report_type: 'payments.itemized.1',
        parameters: { ...interval, columns: ['amount', 'amount'] },
      },
      'parameters[columns]',
    );
    await refusedRun({ report_type: 'tax.summary.1', parameters: interval }, 'report_type');
    await refusedRun(
      { report_type: 'payments.itemized.1', parameters: { ...interval, timezone: 'UTC' } },
      'parameters[timezone]',
    );
    // A ledger report for a merchant with no account: told so, never shown zeros.
    await refusedRun(
      { report_type: 'balance.summary.1', parameters: interval },
      undefined,
      'account_missing',
    );
    expect(await gatewayDb().select().from(reportRuns)).toEqual([]);
  });

  test('payments.itemized.1: pending → succeeded, the CSV, its File and the event', async () => {
    const inside = await seedIntent(merchant, {
      amount: '250000000',
      metadata: {},
    });
    const other = await seedMerchant();
    await seedIntent(other, { amount: '1' });
    await Bun.sleep(1100);
    const end = now();
    await seedIntent(merchant, { amount: '9' }); // after the interval

    const created = await createRun({
      report_type: 'payments.itemized.1',
      parameters: { interval_start: end - HOUR, interval_end: end },
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      object: 'reporting.report_run',
      livemode: false,
      status: 'pending',
      result: null,
      error: null,
      succeeded_at: null,
      parameters: { interval_start: end - HOUR, interval_end: end },
    });
    const id = String(created.json.id);
    expect(id).toStartWith('frr_');

    expect(await drain()).toEqual(['succeeded']);
    const run = await call('GET', `/v1/reporting/report_runs/${id}`);
    expect(run.json.status).toBe('succeeded');
    const result = run.json.result as Json;
    expect(result).toMatchObject({
      object: 'file',
      purpose: 'finance_report_run',
      type: 'csv',
      status: 'available',
      filename: `payments.itemized.1-${id}.csv`,
      url: `${config.apiBaseUrl}/v1/files/${String(result.id)}/contents`,
    });
    const stored = [...files.stored.values()].at(-1);
    expect([stored?.mime, stored?.visibility]).toEqual(['text/csv', 'private']);

    const contents = await call('GET', `/v1/files/${String(result.id)}/contents`);
    expect(contents.status).toBe(200);
    expect(contents.headers.get('content-type')).toStartWith('text/csv');
    expect(contents.headers.get('cache-control')).toBe('no-store');
    const rows = parseCsv(contents.text);
    expect(rows[0]).toEqual([...REPORT_TYPE_LAYOUTS['payments.itemized.1'].default_columns]);
    expect(rows.slice(1).map((row) => [row[0], row[4]])).toEqual([[inside.publicId, '250000000']]);

    const events = await storedEvents({ merchantId: merchant.id });
    const succeeded = events.filter(({ row }) => row.type === 'reporting.report_run.succeeded');
    expect(succeeded).toHaveLength(1);
    const event = must(succeeded[0]).event;
    expect(event.request).toEqual({ id: null, idempotency_key: null });
    expect((event.data.object as unknown as Json).id).toBe(id);

    const list = await call('GET', '/v1/reporting/report_runs?report_type=payments.itemized.1');
    expect((list.json.data as Json[]).map((r) => [r.id, (r.result as Json).id])).toEqual([
      [id, result.id],
    ]);
  });

  test('columns are written in the layout order; currency filters; text cannot become a formula', async () => {
    const intent = await seedIntent(merchant, { rail: 'card', amount: '500', currency: 'EUR' });
    await gatewayDb().execute(
      sql`update payment_intents set description = '=HYPERLINK("https://evil")', receipt_email = '+1@x.y' where id = ${intent.id}`,
    );
    await seedIntent(merchant, { amount: '7' });
    await Bun.sleep(1100);
    const end = now();
    const created = await createRun({
      report_type: 'payments.itemized.1',
      parameters: {
        interval_start: end - HOUR,
        interval_end: end,
        currency: 'EUR',
        columns: ['description', 'amount', 'payment_intent_id', 'receipt_email'],
      },
    });
    expect(created.json.parameters).toMatchObject({ currency: 'EUR' });
    await drain();
    const run = await call('GET', `/v1/reporting/report_runs/${String(created.json.id)}`);
    const contents = await call(
      'GET',
      `/v1/files/${String((run.json.result as Json).id)}/contents`,
    );
    expect(contents.text).toBe(
      `payment_intent_id,amount,description,receipt_email\r\n${intent.publicId},500,"'=HYPERLINK(""https://evil"")",'+1@x.y\r\n`,
    );
  });

  test('balance.summary.1 for a first-party ledger; an unknown fee is empty, never zero', async () => {
    firstParty = true;
    merchant = await syncMerchantAuthority(gatewayDb(), merchant, { firstParty: true });
    const at = (seconds: number) => new Date(seconds * 1000);
    const end = now() - 5;
    const transaction = async (values: {
      amount: string;
      fee: string | null;
      type?: 'charge' | 'payout';
      when: number;
    }) =>
      insertBalanceTransaction(gatewayDb(), {
        publicId: `txn_${uuidv7()}`,
        merchantId: merchant.id,
        connectedAccountId: null,
        ingestionKey: `test:${uuidv7()}`,
        provider: 'stripe',
        providerObjectId: `txn_p_${uuidv7()}`,
        amount: values.amount,
        fee: values.fee,
        net: values.fee === null ? null : (BigInt(values.amount) - BigInt(values.fee)).toString(),
        currency: 'EUR',
        type: values.type ?? 'charge',
        reportingCategory: values.type ?? 'charge',
        status: 'available',
        availableOn: null,
        occurredAt: at(values.when),
        description: null,
        exchangeRate: null,
        feeDetails: [],
        sourceType: null,
        sourceId: null,
        paymentIntentId: null,
        payoutId: null,
      });
    await transaction({ amount: '1000', fee: '30', when: end - 2 * HOUR }); // before
    await transaction({ amount: '500', fee: '15', when: end - 30 * 60 });
    await transaction({ amount: '-400', fee: '0', type: 'payout', when: end - 20 * 60 });

    const run = async () => {
      const created = await createRun({
        report_type: 'balance.summary.1',
        parameters: { interval_start: end - HOUR, interval_end: end },
      });
      expect(created.status).toBe(200);
      expect(await drain()).toEqual(['succeeded']);
      const done = await call('GET', `/v1/reporting/report_runs/${String(created.json.id)}`);
      return parseCsv(
        (await call('GET', `/v1/files/${String((done.json.result as Json).id)}/contents`)).text,
      );
    };
    expect(await run()).toEqual([
      ['category', 'description', 'currency', 'net_amount'],
      ['starting_balance', 'Balance at the start of the interval', 'EUR', '970'],
      ['activity_gross', 'Activity before fees', 'EUR', '500'],
      ['activity_fee', 'Fees', 'EUR', '-15'],
      ['activity', 'Net activity', 'EUR', '485'],
      ['payouts', 'Payouts', 'EUR', '-400'],
      ['ending_balance', 'Balance at the end of the interval', 'EUR', '1055'],
    ]);

    await transaction({ amount: '200', fee: null, when: end - 10 * 60 });
    const unknown = await run();
    expect(unknown.find((row) => row[0] === 'activity')?.[3]).toBe('');
    expect(unknown.find((row) => row[0] === 'activity_gross')?.[3]).toBe('700');
    expect(unknown.find((row) => row[0] === 'ending_balance')?.[3]).toBe('');
    expect(unknown.find((row) => row[0] === 'starting_balance')?.[3]).toBe('970');
  });

  test('storage outages defer the run; it fails after the last attempt, with its event', async () => {
    const end = now();
    const created = await createRun({
      report_type: 'payments.itemized.1',
      parameters: { interval_start: end - HOUR, interval_end: end },
    });
    files.options.failStore = true;
    expect(await drain()).toEqual(['deferred']);
    // Deferred: the lease is moved, so nothing retries before it lapses.
    expect(await runReportRunPass({ files })).toBe('idle');
    for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt += 1) {
      await lapseLeases();
      expect(await drain()).toEqual(['deferred']);
    }
    await lapseLeases();
    expect(await drain()).toEqual(['failed']);
    const run = await call('GET', `/v1/reporting/report_runs/${String(created.json.id)}`);
    expect(run.json).toMatchObject({ status: 'failed', result: null });
    expect(String(run.json.error)).toContain('could not be produced');
    const failed = await storedEvents({
      merchantId: merchant.id,
      type: 'reporting.report_run.failed',
    });
    expect(failed).toHaveLength(1);
  });

  test('a lost lease completes nothing, and two workers take different runs', async () => {
    const end = now();
    for (let i = 0; i < 2; i += 1) {
      await createRun({
        report_type: 'payments.itemized.1',
        parameters: { interval_start: end - HOUR, interval_end: end },
      });
    }
    const [a, b] = await Promise.all([
      claimReportRun(gatewayDb(), 60),
      claimReportRun(gatewayDb(), 60),
    ]);
    expect(must(a).id).not.toBe(must(b).id);
    await lapseLeases();
    const again = must(await claimReportRun(gatewayDb(), 60));
    const stale = must([a, b].find((claim) => claim?.id === again.id));
    expect(await failReportRun(gatewayDb(), stale, 'too late')).toBeNull();
    expect(await completeReportRun(gatewayDb(), stale, uuidv7())).toBeNull();
    const [row] = await gatewayDb().select().from(reportRuns).where(eq(reportRuns.id, again.id));
    expect([row?.status, row?.attempts]).toEqual(['pending', 2]);
  });

  test('a report file cannot be uploaded, and only a report file has contents', async () => {
    const form = new FormData();
    form.append('purpose', 'finance_report_run');
    form.append('file', new Blob(['a,b\r\n'], { type: 'text/csv' }), 'r.csv');
    const upload = await fetch(`${baseUrl}/v1/files`, { method: 'POST', body: form });
    const error = ((await upload.json()) as Json).error as Json;
    expect([upload.status, error.param]).toEqual([400, 'purpose']);

    const png = new FormData();
    png.append('purpose', 'dispute_evidence');
    png.append(
      'file',
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])]),
      'e.png',
    );
    const evidence = (await (
      await fetch(`${baseUrl}/v1/files`, { method: 'POST', body: png })
    ).json()) as Json;
    expect(evidence.url).toBeNull();
    expect((await call('GET', `/v1/files/${String(evidence.id)}/contents`)).status).toBe(404);
  });

  test("Orbit's dashboard runs and reads reports behind the membership gate", async () => {
    const end = now();
    const dashboard = (path: string, init: RequestInit = {}, user = MEMBER) =>
      fetch(
        `${dashboardUrl}/v1/dashboard/applications/${APP_ID}${path}${path.includes('?') ? '&' : '?'}environment=development`,
        {
          ...init,
          headers: { 'Content-Type': 'application/json', 'X-Test-User-Id': user },
        },
      );
    const created = await dashboard('/reporting/report_runs', {
      method: 'POST',
      body: JSON.stringify({
        report_type: 'payments.itemized.1',
        parameters: { interval_start: end - HOUR, interval_end: end },
      }),
    });
    expect(created.status).toBe(200);
    const id = String(((await created.json()) as Json).id);
    await drain();
    const run = (await (await dashboard(`/reporting/report_runs/${id}`)).json()) as Json;
    expect(run.status).toBe('succeeded');
    const contents = await dashboard(`/files/${String((run.result as Json).id)}/contents`);
    expect([contents.status, (await contents.text()).split('\r\n')[0]]).toEqual([
      200,
      REPORT_TYPE_LAYOUTS['payments.itemized.1'].default_columns.join(','),
    ]);
    expect((await dashboard('/reporting/report_types')).status).toBe(200);
    expect((await dashboard('/reporting/report_runs', {}, 'user_stranger')).status).toBe(403);
  });
});

/**
 * The download (`GET /v1/reporting/report_types/:id/csv`): the SAME report as
 * a run, streamed — one parameter check, one computation, one renderer.
 */
describe.skipIf(!POSTGRES_TESTS_ENABLED)('report downloads', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    environment = 'development';
    appId = APP_ID;
    firstParty = false;
    files.options.failStore = false;
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  const query = (params: Record<string, string | number | readonly string[]>) =>
    Object.entries(params)
      .flatMap(([key, value]) =>
        Array.isArray(value)
          ? value.map((item) => `${key}[]=${encodeURIComponent(item)}`)
          : [`${key}=${encodeURIComponent(String(value))}`],
      )
      .join('&');

  test('a download is byte for byte the run of the same parameters, every column included', async () => {
    const intent = await seedIntent(merchant, { rail: 'card', amount: '1999', currency: 'EUR' });
    await gatewayDb().execute(
      sql`update payment_intents set description = '=evil', metadata = '{"order":"A,1"}'::jsonb where id = ${intent.id}`,
    );
    await seedIntent(merchant, { amount: '100000001' }); // FAIR
    await Bun.sleep(1100);
    const end = now();
    const columns = [...REPORT_TYPE_LAYOUTS['payments.itemized.1'].columns];
    const parameters = { interval_start: end - HOUR, interval_end: end, columns };

    const download = await call(
      'GET',
      `/v1/reporting/report_types/payments.itemized.1/csv?${query(parameters)}`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment; filename="payments\.itemized\.1_test_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const created = await createRun({ report_type: 'payments.itemized.1', parameters });
    expect(await drain()).toEqual(['succeeded']);
    const run = await call('GET', `/v1/reporting/report_runs/${String(created.json.id)}`);
    const stored = await call('GET', `/v1/files/${String((run.json.result as Json).id)}/contents`);
    expect(download.text).toBe(stored.text);

    const rows = parseCsv(download.text);
    expect(rows[0]).toEqual(columns);
    const at = (name: string) => columns.indexOf(name);
    const card = must(rows.find((row) => row[0] === intent.publicId));
    expect([card[at('amount_decimal')], card[at('description')]]).toEqual(['19.99', "'=evil"]);
    // A JSON cell holds commas and quotes: quoted whole, its quotes doubled (RFC 4180).
    expect(download.text).toContain('"{""order"":""A,1""}"');
    expect(
      rows.find((row) => row[0] !== intent.publicId && row[0] !== 'payment_intent_id')?.[
        at('amount_decimal')
      ],
    ).toBe('1.00000001');
  });

  test('itemized balance transactions, refunds and disputes; an unreported fee is empty', async () => {
    firstParty = true;
    merchant = await syncMerchantAuthority(gatewayDb(), merchant, { firstParty: true });
    const end = now() - 5;
    const base = {
      merchantId: merchant.id,
      connectedAccountId: null,
      provider: 'stripe',
      currency: 'EUR',
      reportingCategory: 'charge',
      status: 'available',
      availableOn: null,
      description: null,
      exchangeRate: null,
      feeDetails: [],
      sourceType: null,
      sourceId: null,
      paymentIntentId: null,
      payoutId: null,
    } as const;
    const charge = must(
      await insertBalanceTransaction(gatewayDb(), {
        ...base,
        publicId: `txn_${uuidv7()}`,
        ingestionKey: `test:${uuidv7()}`,
        providerObjectId: `txn_p_${uuidv7()}`,
        amount: '10000',
        fee: null,
        net: null,
        type: 'charge',
        occurredAt: new Date((end - 600) * 1000),
      }),
    );
    const csv = await call(
      'GET',
      `/v1/reporting/report_types/balance_transactions.itemized.1/csv?${query({ interval_start: end - HOUR, interval_end: end })}`,
    );
    const rows = parseCsv(csv.text);
    const header = must(rows[0]);
    expect(header).toEqual([
      ...REPORT_TYPE_LAYOUTS['balance_transactions.itemized.1'].default_columns,
    ]);
    const line = must(rows[1]);
    expect([
      line[header.indexOf('balance_transaction_id')],
      line[header.indexOf('amount_decimal')],
      line[header.indexOf('fee')],
      line[header.indexOf('fee_decimal')],
    ]).toEqual([charge.publicId, '100.00', '', '']);

    const intent = await seedIntent(merchant, { rail: 'card', amount: '1999', currency: 'EUR' });
    const refund = must(
      await insertRefund(gatewayDb(), {
        publicId: `re_${uuidv7()}`,
        merchantId: merchant.id,
        paymentIntentId: intent.id,
        externalRef: '-ref',
        amount: '999',
        currency: 'EUR',
        provider: 'stripe',
      }),
    );
    const { dispute } = await upsertDispute(gatewayDb(), {
      merchantId: merchant.id,
      paymentIntentId: intent.id,
      provider: 'stripe',
      providerObjectId: `du_${uuidv7()}`,
      amount: '1999',
      currency: 'EUR',
      status: 'needs_response',
      reason: 'fraudulent',
      evidenceDueAt: new Date((end + 7 * 24 * HOUR) * 1000),
    });
    await Bun.sleep(1100);
    const later = now();
    const range = { interval_start: later - HOUR, interval_end: later };
    const refunds = parseCsv(
      (
        await call(
          'GET',
          `/v1/reporting/report_types/refunds.itemized.1/csv?${query({ ...range, columns: ['refund_id', 'payment_intent_id', 'external_ref', 'amount_decimal'] })}`,
        )
      ).text,
    );
    expect(refunds).toEqual([
      ['refund_id', 'payment_intent_id', 'external_ref', 'amount_decimal'],
      [refund.publicId, intent.publicId, "'-ref", '9.99'],
    ]);
    const disputes = parseCsv(
      (await call('GET', `/v1/reporting/report_types/disputes.itemized.1/csv?${query(range)}`))
        .text,
    );
    expect(disputes[0]).toEqual([...REPORT_TYPE_LAYOUTS['disputes.itemized.1'].default_columns]);
    const disputeLine = must(disputes[1]);
    expect([disputeLine[0], disputeLine[2], disputeLine[3], disputeLine[4]]).toEqual([
      dispute.publicId,
      intent.publicId,
      'needs_response',
      'fraudulent',
    ]);
  });

  test('every refusal is the JSON error before any CSV byte', async () => {
    const end = now();
    const path = (id: string, params: Record<string, string | number | readonly string[]>) =>
      `/v1/reporting/report_types/${id}/csv?${query(params)}`;
    for (const [url, status, param] of [
      [
        path('payments.itemized.1', { interval_start: end, interval_end: end }),
        400,
        'interval_end',
      ],
      [
        path('payments.itemized.1', { interval_start: 1, interval_end: end + HOUR }),
        400,
        'interval_end',
      ],
      [
        path('payments.itemized.1', { interval_start: 1, interval_end: end, columns: ['colour'] }),
        400,
        'columns',
      ],
      [
        path('payments.itemized.1', { interval_start: 1, interval_end: end, limit: 10 }),
        400,
        'limit',
      ],
      [path('nope.1', { interval_start: 1, interval_end: end }), 404, 'id'],
    ] as const) {
      const answer = await call('GET', url);
      expect([url, answer.status, (answer.json.error as Json | undefined)?.param]).toEqual([
        url,
        status,
        param,
      ]);
    }
    const ledger = await call(
      'GET',
      path('payouts.itemized.1', { interval_start: 1, interval_end: end }),
    );
    expect([ledger.status, (ledger.json.error as Json).code]).toEqual([404, 'account_missing']);
  });

  test("Orbit's dashboard downloads behind the membership gate", async () => {
    await seedIntent(merchant, { rail: 'card', amount: '500', currency: 'EUR' });
    await Bun.sleep(1100);
    const end = now();
    const url = (user: string) =>
      fetch(
        `${dashboardUrl}/v1/dashboard/applications/${APP_ID}/reporting/report_types/payments.itemized.1/csv?environment=development&interval_start=${end - HOUR}&interval_end=${end}`,
        { headers: { 'X-Test-User-Id': user } },
      );
    const member = await url(MEMBER);
    expect(member.status).toBe(200);
    expect(parseCsv(await member.text())).toHaveLength(2);
    expect((await url('user_stranger')).status).toBe(403);
  });
});
