/**
 * Report schedules end to end against a real Postgres and a fake Oxy Files:
 * the API's refusals and lifecycle, the scheduler's leased claim (one run per
 * occurrence even when two claimers race, the latest missed occurrence only,
 * never a paused or canceled schedule), the run it fires through the report
 * run worker, and the recipients' emails — owed exactly once per run, linking
 * Orbit and never carrying the file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { createDashboardRouter } from '../dashboard';
import { requestIdMiddleware } from '../../lib/requestId';
import { stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  claimDueReportSchedule,
  findReportScheduleForMerchant,
} from '../../db/reporting/reportScheduleRepository';
import { customerEmails, reportRuns, reportSchedules } from '../../db/schema';
import { MAX_ATTEMPTS, runReportRunPass } from '../../services/reporting/reportRunWorker';
import {
  fireReportSchedule,
  runReportSchedulePass,
} from '../../services/reporting/reportScheduler';
import { enqueueReportRunEmails } from '../../services/email/outbox';
import { dispatchCustomerEmails } from '../../services/email/dispatcher';
import { MemoryMailer } from '../../services/email/mailer';
import { config } from '../../config';
import { must } from '../../__tests__/helpers/must';
import { createFakeOxyFiles, type FakeOxyFiles } from '../../__tests__/helpers/fakeOxyFiles';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  storedEvents,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_orbit_schedules';
const MEMBER = 'user_member';
const READER = 'user_reader';
let gateway: Gateway | undefined;
let baseUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchant: MerchantRow;
let files: FakeOxyFiles;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 'orbit',
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'development',
    tier: 'external',
    scopes: (req.header('X-Test-Scopes') ?? 'payments:read payments:write').split(' '),
  };
  next();
};

async function call(method: string, path: string, body?: unknown, headers: Json = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers as Record<string, string>) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

const MONTHLY = { interval: 'monthly', monthly_anchor: 1 };

async function createSchedule(body: Json = {}) {
  const answer = await call('POST', '/v1/reporting/report_schedules', {
    report_type: 'payments.itemized.1',
    schedule: MONTHLY,
    timezone: 'Europe/Madrid',
    recipients: ['finance@example.com', 'books@example.org'],
    ...body,
  });
  expect(answer.status).toBe(200);
  return answer.json;
}

async function refused(body: Json, param: string, code = 'parameter_invalid') {
  const answer = await call('POST', '/v1/reporting/report_schedules', {
    report_type: 'payments.itemized.1',
    schedule: MONTHLY,
    ...body,
  });
  const error = answer.json.error as Json;
  expect([answer.status, error.param, error.code]).toEqual([400, param, code]);
}

/** Make a schedule due: its next occurrence moved into the past. */
async function makeDue(publicId: string, nextRunAt: Date): Promise<void> {
  await gatewayDb()
    .update(reportSchedules)
    .set({ nextRunAt })
    .where(eq(reportSchedules.publicId, publicId));
}

async function runsOf(publicId: string) {
  const schedule = must(await findReportScheduleForMerchant(gatewayDb(), merchant.id, publicId));
  return gatewayDb().select().from(reportRuns).where(eq(reportRuns.reportScheduleId, schedule.id));
}

async function emailsOf(runId: string) {
  return gatewayDb().select().from(customerEmails).where(eq(customerEmails.reportRunId, runId));
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
        application: (userId) =>
          userId === MEMBER
            ? { ownerAccountId: 'owner' }
            : userId === READER
              ? { ownerAccountId: 'owner', permissions: ['app:read'] }
              : undefined,
      }),
      files: { ...files, linkedDownloadUrls: (ids) => files.linkedDownloadUrls(ids) },
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

describe.skipIf(!POSTGRES_TESTS_ENABLED)('report schedules', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    files.options.failStore = false;
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment: 'development' });
  });

  test('create answers the first occurrence after now, in the schedule zone', async () => {
    const schedule = await createSchedule({ parameters: { currency: 'EUR' } });
    expect(schedule).toMatchObject({
      object: 'reporting.report_schedule',
      livemode: false,
      report_type: 'payments.itemized.1',
      parameters: { currency: 'EUR' },
      schedule: { interval: 'monthly', weekly_anchor: null, monthly_anchor: 1 },
      timezone: 'Europe/Madrid',
      recipients: ['finance@example.com', 'books@example.org'],
      locale: 'en',
      status: 'active',
      last_run: null,
      canceled_at: null,
    });
    expect(String(schedule.id)).toMatch(/^frs_/);
    const next = new Date(Number(schedule.next_run_at) * 1000);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // Midnight on the 1st in Madrid is 23:00 or 22:00 UTC on the last day before.
    expect([22, 23]).toContain(next.getUTCHours());
    const daily = await createSchedule({ schedule: { interval: 'daily' }, timezone: undefined });
    expect(daily.timezone).toBe('UTC');
    expect(Number(daily.next_run_at) % 86_400).toBe(0);
  });

  test('refusals', async () => {
    await refused(
      { schedule: { interval: 'weekly' } },
      'schedule[weekly_anchor]',
      'parameter_missing',
    );
    await refused(
      { schedule: { interval: 'monthly' } },
      'schedule[monthly_anchor]',
      'parameter_missing',
    );
    await refused(
      { schedule: { interval: 'daily', weekly_anchor: 'monday' } },
      'schedule[weekly_anchor]',
    );
    await refused(
      { schedule: { interval: 'monthly', monthly_anchor: 32 } },
      'schedule[monthly_anchor]',
    );
    await refused({ timezone: 'Mars/Olympus_Mons' }, 'timezone');
    await refused({ parameters: { columns: ['colour'] } }, 'parameters[columns]');
    await refused({ recipients: ['a@example.com', 'A@example.com'] }, 'recipients');
    await refused({ recipients: ['not an address'] }, 'recipients[0]');
    await refused(
      { recipients: Array.from({ length: 11 }, (_, i) => `p${String(i)}@example.com`) },
      'recipients',
    );
    // A ledger report needs an account to read, as a run does.
    const ledger = await call('POST', '/v1/reporting/report_schedules', {
      report_type: 'balance.summary.1',
      schedule: MONTHLY,
    });
    expect([ledger.status, (ledger.json.error as Json).code]).toEqual([404, 'account_missing']);
    // A read-only credential cannot write a schedule.
    const scoped = await call(
      'POST',
      '/v1/reporting/report_schedules',
      { report_type: 'payments.itemized.1', schedule: MONTHLY },
      { 'X-Test-Scopes': 'payments:read' },
    );
    expect(scoped.status).toBe(403);
  });

  test('update, pause, resume, cancel; a canceled schedule never changes', async () => {
    const created = await createSchedule();
    const id = String(created.id);
    const renamed = await call('POST', `/v1/reporting/report_schedules/${id}`, {
      recipients: ['ops@example.com'],
      locale: 'es',
    });
    expect(renamed.json).toMatchObject({ recipients: ['ops@example.com'], locale: 'es' });
    // Recipients alone keep the occurrence; a new cadence moves it.
    expect(renamed.json.next_run_at).toBe(created.next_run_at);
    const weekly = await call('POST', `/v1/reporting/report_schedules/${id}`, {
      schedule: { interval: 'weekly', weekly_anchor: 'monday' },
      timezone: 'UTC',
    });
    const monday = new Date(Number(weekly.json.next_run_at) * 1000);
    expect([monday.getUTCDay(), monday.getUTCHours()]).toEqual([1, 0]);

    const paused = await call('POST', `/v1/reporting/report_schedules/${id}/pause`, {});
    expect(paused.json).toMatchObject({ status: 'paused', next_run_at: null });
    // Asking twice answers it as it is.
    expect((await call('POST', `/v1/reporting/report_schedules/${id}/pause`, {})).status).toBe(200);
    const resumed = await call('POST', `/v1/reporting/report_schedules/${id}/resume`, {});
    expect(resumed.json.status).toBe('active');
    expect(Number(resumed.json.next_run_at) * 1000).toBeGreaterThan(Date.now());

    const canceled = await call('POST', `/v1/reporting/report_schedules/${id}/cancel`, {});
    expect(canceled.json).toMatchObject({ status: 'canceled', next_run_at: null });
    expect(canceled.json.canceled_at).toBeNumber();
    for (const [path, body] of [
      [`/v1/reporting/report_schedules/${id}`, { locale: 'en' }],
      [`/v1/reporting/report_schedules/${id}/resume`, {}],
      [`/v1/reporting/report_schedules/${id}/pause`, {}],
    ] as const) {
      const answer = await call('POST', path, body);
      expect([answer.status, (answer.json.error as Json).code]).toEqual([
        409,
        'report_schedule_unexpected_state',
      ]);
    }

    const list = await call('GET', '/v1/reporting/report_schedules?status=canceled');
    expect((list.json.data as Json[]).map((s) => s.id)).toEqual([id]);
    expect(
      ((await call('GET', '/v1/reporting/report_schedules?status=active')).json.data as Json[])
        .length,
    ).toBe(0);
    expect((await call('GET', '/v1/reporting/report_schedules/frs_nope')).status).toBe(404);
  });

  test('a due schedule fires ONE run for the latest occurrence and moves on', async () => {
    const created = await createSchedule({ schedule: { interval: 'daily' }, timezone: 'UTC' });
    const id = String(created.id);
    // The scheduler slept for ten days.
    await makeDue(id, new Date(Date.now() - 10 * 86_400_000));
    expect(await runReportSchedulePass()).toBe('fired');
    expect(await runReportSchedulePass()).toBe('idle');

    const runs = await runsOf(id);
    expect(runs.length).toBe(1);
    const run = must(runs[0]);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    expect(must(run.scheduledFor).toISOString()).toBe(today.toISOString());
    expect(run.intervalEnd.toISOString()).toBe(today.toISOString());
    expect(today.getTime() - run.intervalStart.getTime()).toBe(86_400_000);
    expect(run.status).toBe('pending');

    const after = must(await findReportScheduleForMerchant(gatewayDb(), merchant.id, id));
    expect(must(after.nextRunAt).getTime()).toBe(today.getTime() + 86_400_000);
    expect(after.lastRunPublicId).toBe(run.publicId);

    // The run is an ordinary run: listed, filtered by its schedule, expandable.
    const listed = await call('GET', `/v1/reporting/report_runs?report_schedule=${id}`);
    expect((listed.json.data as Json[]).map((r) => [r.id, r.report_schedule])).toEqual([
      [run.publicId, id],
    ]);
    expect(
      (
        (await call('GET', '/v1/reporting/report_runs?report_schedule=frs_other')).json
          .data as Json[]
      ).length,
    ).toBe(0);
    const expanded = await call(
      'GET',
      `/v1/reporting/report_schedules/${id}?expand[]=last_run.report_schedule`,
    );
    const lastRun = expanded.json.last_run as Json;
    expect([lastRun.id, (lastRun.report_schedule as Json).id]).toEqual([run.publicId, id]);
  });

  test('two concurrent claimers fire one occurrence once', async () => {
    const created = await createSchedule({ schedule: { interval: 'daily' }, timezone: 'UTC' });
    const id = String(created.id);
    await makeDue(id, new Date(Date.now() - 3_600_000));
    const outcomes = await Promise.all([runReportSchedulePass(), runReportSchedulePass()]);
    expect(outcomes.sort()).toEqual(['fired', 'idle']);
    expect((await runsOf(id)).length).toBe(1);

    // A claimer whose lease lapsed and was taken over fires nothing, and even
    // if both reach the insert, the occurrence key holds one run.
    await makeDue(id, new Date(Date.now() - 3_600_000));
    await gatewayDb()
      .delete(reportRuns)
      .where(eq(reportRuns.publicId, must((await runsOf(id))[0]).publicId));
    const first = must(await claimDueReportSchedule(gatewayDb(), 60));
    await gatewayDb()
      .update(reportSchedules)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(reportSchedules.publicId, id));
    const second = must(await claimDueReportSchedule(gatewayDb(), 60));
    expect(await fireReportSchedule(second)).toBe('fired');
    expect(await fireReportSchedule(first)).toBe('lost');
    expect((await runsOf(id)).length).toBe(1);
  });

  test('a paused or canceled schedule never fires, even mid-claim', async () => {
    const paused = String((await createSchedule()).id);
    const canceled = String((await createSchedule()).id);
    const racing = String((await createSchedule()).id);
    await call('POST', `/v1/reporting/report_schedules/${paused}/pause`, {});
    await call('POST', `/v1/reporting/report_schedules/${canceled}/cancel`, {});
    await makeDue(racing, new Date(Date.now() - 3_600_000));
    const claimed = must(await claimDueReportSchedule(gatewayDb(), 60));
    expect(claimed.publicId).toBe(racing);
    // Paused between the claim and the fire.
    expect((await call('POST', `/v1/reporting/report_schedules/${racing}/pause`, {})).status).toBe(
      200,
    );
    expect(await fireReportSchedule(claimed)).toBe('lost');
    expect(await runReportSchedulePass()).toBe('idle');
    for (const id of [paused, canceled, racing]) expect((await runsOf(id)).length).toBe(0);
    // A stopped schedule cannot even be made due: the CHECK refuses a next run.
    await expect(
      (async () => {
        await gatewayDb()
          .update(reportSchedules)
          .set({ nextRunAt: new Date() })
          .where(eq(reportSchedules.publicId, paused));
      })(),
    ).rejects.toThrow();
  });

  test('a succeeded run owes each recipient one email; a failed one a notice', async () => {
    const id = String((await createSchedule({ locale: 'es' })).id);
    await makeDue(id, new Date(Date.now() - 3_600_000));
    expect(await runReportSchedulePass()).toBe('fired');
    expect(await runReportRunPass({ files })).toBe('succeeded');
    const run = must((await runsOf(id))[0]);
    expect(run.status).toBe('succeeded');

    const owed = await emailsOf(run.id);
    expect(owed.map((e) => [e.kind, e.recipient]).sort()).toEqual([
      ['report_run_succeeded', 'books@example.org'],
      ['report_run_succeeded', 'finance@example.com'],
    ]);
    // Owed again (a replayed completion): nothing more.
    expect(
      await enqueueReportRunEmails(gatewayDb(), { ...run, status: 'succeeded' as const }),
    ).toBe(0);
    expect((await emailsOf(run.id)).length).toBe(2);

    // The event carries the schedule.
    const [event] = await storedEvents({
      merchantId: merchant.id,
      type: 'reporting.report_run.succeeded',
    });
    expect((must(event).event.data.object as Json).report_schedule).toBe(id);

    // Rendered at send time: a link to Orbit, never the file.
    const mailer = new MemoryMailer();
    expect(await dispatchCustomerEmails(mailer)).toBe(2);
    const email = must(mailer.sent[0]);
    expect(email.subject).toStartWith('Tu informe programado está listo: Itemized payments');
    expect(email.text).toContain(`${config.orbitBaseUrl}/reports`);
    expect(email.html).toContain(`${config.orbitBaseUrl}/reports`);
    for (const body of [email.text, email.html]) {
      expect(body).not.toContain('file_');
      expect(body).not.toContain('/contents');
    }
    expect(email.replyTo).toBeNull();

    // A run that fails: its notice, once.
    await makeDue(id, new Date(Date.now() - 60_000));
    await gatewayDb().delete(customerEmails);
    // The same occurrence again (a schedule moved back by hand): it advances, no second run.
    expect(await runReportSchedulePass()).toBe('fired');
    expect((await runsOf(id)).length).toBe(1);
    const failing = String((await createSchedule({ schedule: { interval: 'daily' } })).id);
    await makeDue(failing, new Date(Date.now() - 60_000));
    expect(await runReportSchedulePass()).toBe('fired');
    const pending = must((await runsOf(failing))[0]);
    await gatewayDb()
      .update(reportRuns)
      .set({ attempts: MAX_ATTEMPTS })
      .where(eq(reportRuns.id, pending.id));
    expect(await runReportRunPass({ files })).toBe('failed');
    expect((await emailsOf(pending.id)).map((e) => e.kind)).toEqual([
      'report_run_failed',
      'report_run_failed',
    ]);
    const notices = new MemoryMailer();
    await dispatchCustomerEmails(notices);
    expect(must(notices.sent[0]).subject).toBe(
      'Your scheduled report could not be produced: Itemized payments',
    );
  });

  test('a direct run and a canceled schedule email nobody', async () => {
    const end = Math.floor(Date.now() / 1000) - 60;
    const direct = await call('POST', '/v1/reporting/report_runs', {
      report_type: 'payments.itemized.1',
      parameters: { interval_start: end - 3600, interval_end: end },
    });
    expect(direct.json.report_schedule).toBeNull();
    expect(await runReportRunPass({ files })).toBe('succeeded');

    const id = String((await createSchedule()).id);
    await makeDue(id, new Date(Date.now() - 3_600_000));
    expect(await runReportSchedulePass()).toBe('fired');
    await call('POST', `/v1/reporting/report_schedules/${id}/cancel`, {});
    expect(await runReportRunPass({ files })).toBe('succeeded');
    expect(await gatewayDb().select().from(customerEmails)).toEqual([]);
  });

  test("Orbit's dashboard: reading is `read`, writing a schedule is `configure`", async () => {
    const dashboard = (path: string, init: RequestInit = {}, user = MEMBER) =>
      fetch(
        `${dashboardUrl}/v1/dashboard/applications/${APP_ID}${path}${path.includes('?') ? '&' : '?'}environment=development`,
        {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
            'X-Test-User-Id': user,
          },
        },
      );
    const body = JSON.stringify({
      report_type: 'payments.itemized.1',
      schedule: { interval: 'weekly', weekly_anchor: 'friday' },
      recipients: ['finance@example.com'],
    });
    const created = await dashboard('/reporting/report_schedules', { method: 'POST', body });
    expect(created.status).toBe(200);
    const id = String(((await created.json()) as Json).id);
    expect((await dashboard('/reporting/report_schedules', {}, READER)).status).toBe(200);
    expect((await dashboard(`/reporting/report_schedules/${id}`, {}, READER)).status).toBe(200);
    for (const [path, payload] of [
      ['/reporting/report_schedules', body],
      [`/reporting/report_schedules/${id}`, '{}'],
      [`/reporting/report_schedules/${id}/pause`, '{}'],
      [`/reporting/report_schedules/${id}/cancel`, '{}'],
    ] as const) {
      const refusedAnswer = await dashboard(path, { method: 'POST', body: payload }, READER);
      expect([path, refusedAnswer.status]).toEqual([path, 403]);
    }
    const paused = await dashboard(`/reporting/report_schedules/${id}/pause`, {
      method: 'POST',
      body: '{}',
    });
    expect(((await paused.json()) as Json).status).toBe('paused');
  });
});
