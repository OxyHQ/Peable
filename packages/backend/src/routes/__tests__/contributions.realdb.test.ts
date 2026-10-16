import { contributionCollectionListSchema, contributionListSchema } from '@peable.to/contracts';
import type { PublicPaymentLink } from '@peable.to/shared-types';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { eq } from 'drizzle-orm';
import {
  gatewayDb,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { paymentLinks } from '../../db/schema';
import { findIntentByPublicId } from '../../db/payments/paymentIntentRepository';
const { createContributionsRouter } = await import('../contributions');
const { createPaymentLinksRouter } = await import('../paymentLinks');
useGatewayDatabase();
let server: Server, base: string;
let allowed = true;
let authorityCalls = 0;
const auth: RequestHandler = (req, res, next) => {
  if (req.header('Authorization') !== 'Bearer human') {
    res.sendStatus(401);
    return;
  }
  (req as OxyAuthRequest).accessToken = 'human';
  next();
};
beforeAll(async () => {
  await seedMerchant({ oxyAppId: 'contrib-app', environment: 'development' });
  await seedMerchant({ oxyAppId: 'other-app', environment: 'development' });
  const app = express();
  app.use(express.json());
  app.use(
    createContributionsRouter({
      requireOxyUser: auth,
      authorize: async (_token, org, application) => {
        authorityCalls++;
        return (
          allowed && org === 'organization' && ['contrib-app', 'other-app'].includes(application)
        );
      },
    }),
  );
  app.use(
    createPaymentLinksRouter({
      requireMerchant: auth,
      publicRateLimit: (_req, _res, next) => next(),
    }),
  );
  app.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(500).json({ error: { type: 'api_error', message: 'Unexpected failure' } }),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
const root = '/v1/organizations/organization/applications/contrib-app/contributions';
async function request(path: string, method = 'GET', body?: unknown, key?: string, human = true) {
  return fetch(base + path, {
    method,
    headers: {
      ...(human ? { Authorization: 'Bearer human' } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function make(amountMode: 'fixed' | 'free' = 'fixed') {
  const r = await request(
    `${root}?environment=development`,
    'POST',
    {
      purpose: 'Community kitchen',
      currency: 'FAIR',
      amountMode,
      ...(amountMode === 'fixed' ? { amount: '500' } : {}),
    },
    crypto.randomUUID(),
  );
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; contribution: { purpose: string } };
}
test('concurrent creation and lost-response replay return one immutable link', async () => {
  const key = crypto.randomUUID(),
    body = { purpose: 'Garden', currency: 'FAIR', amountMode: 'fixed', amount: '1000' };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => request(`${root}?environment=development`, 'POST', body, key)),
  );
  expect(results.every((r) => r.status === 201)).toBe(true);
  const ids = await Promise.all(results.map(async (r) => ((await r.json()) as { id: string }).id));
  expect(new Set(ids).size).toBe(1);
  expect(
    (await request(`${root}?environment=development`, 'POST', { ...body, amount: '2000' }, key))
      .status,
  ).toBe(409);
});
test('authority checked afresh and foreign organizations/applications cannot see records', async () => {
  await make();
  const before = authorityCalls;
  expect((await request(`${root}?environment=development`)).status).toBe(200);
  allowed = false;
  expect((await request(`${root}?environment=development`)).status).toBe(403);
  allowed = true;
  expect(authorityCalls).toBeGreaterThan(before);
  expect(
    (
      await request(
        root.replace('organization/applications', 'outsider/applications') +
          '?environment=development',
      )
    ).status,
  ).toBe(403);
  expect(
    (await request(`${root}?environment=development`, 'GET', undefined, undefined, false)).status,
  ).toBe(401);
});
test('anonymous fixed amount cannot be overridden and purpose is public without management data', async () => {
  const link = await make();
  const response = await request(
    `/v1/payment_links/${link.id}/public`,
    'GET',
    undefined,
    undefined,
    false,
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as PublicPaymentLink & {
    contributionKey?: string;
    metadata?: unknown;
  };
  expect(data.contribution?.purpose).toBe('Community kitchen');
  expect(data.contributionKey).toBeUndefined();
  expect(data.metadata).toBeUndefined();
  expect(
    (
      await request(
        `/v1/payment_links/${link.id}/payment_intent`,
        'POST',
        { amount: '800' },
        crypto.randomUUID(),
        false,
      )
    ).status,
  ).toBe(422);
});
test('free amount canonical bounds and missing operation keys fail before money is created', async () => {
  const link = await make('free');
  for (const amount of ['0', '050', '1.5', '-1', '9007199254740992', '1e3'])
    expect(
      (
        await request(
          `/v1/payment_links/${link.id}/payment_intent`,
          'POST',
          { amount },
          crypto.randomUUID(),
          false,
        )
      ).status,
    ).toBe(422);
  expect(
    (
      await request(
        `/v1/payment_links/${link.id}/payment_intent`,
        'POST',
        { amount: '500' },
        undefined,
        false,
      )
    ).status,
  ).toBe(422);
});
test('lost HTTP reply and concurrent retries converge on one FairCoin intent/address', async () => {
  const link = await make('free'),
    key = crypto.randomUUID(),
    path = `/v1/payment_links/${link.id}/payment_intent`;
  // The first result is deliberately discarded, as on a lost transport reply.
  expect((await request(path, 'POST', { amount: '700' }, key, false)).status).toBe(201);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => request(path, 'POST', { amount: '700' }, key, false)),
  );
  expect(responses.every((r) => r.status === 201)).toBe(true);
  const values = await Promise.all(
    responses.map((r) => r.json() as Promise<{ id: string; address: string; rail: string }>),
  );
  expect(new Set(values.map((r) => r.id)).size).toBe(1);
  expect(new Set(values.map((r) => r.address)).size).toBe(1);
  expect(values[0]?.rail).toBe('faircoin');
  expect((await request(path, 'POST', { amount: '800' }, key, false)).status).toBe(409);
  const first = values[0];
  if (!first) throw new Error('No successful response');
  const stored = await findIntentByPublicId(gatewayDb(), first.id);
  expect(stored?.paymentLinkId).toBeTruthy();
  expect(stored?.provider).toBeNull();
  const body = contributionCollectionListSchema.parse(
    await (await request(`${root}/${link.id}/collections?environment=development`)).json(),
  );
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.id).toBe(values[0]?.id);
  expect(body.items[0]?.refundCapability).toBe('unsupported_non_custodial');
  expect(
    (
      await request(
        `${root.replace('contrib-app', 'other-app')}/${link.id}/collections?environment=development`,
      )
    ).status,
  ).toBe(404);
});
test('expired or disabled links refuse new contributions', async () => {
  const link = await make();
  expect(
    (await request(`${root}/${link.id}?environment=development`, 'PATCH', { active: false }))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/payment_links/${link.id}/payment_intent`,
        'POST',
        {},
        crypto.randomUUID(),
        false,
      )
    ).status,
  ).toBe(422);
  await gatewayDb()
    .update(paymentLinks)
    .set({
      active: true,
      contribution: {
        organizationId: 'organization',
        purpose: 'Community kitchen',
        amountMode: 'fixed',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    })
    .where(eq(paymentLinks.publicId, link.id));
  expect(
    (
      await request(
        `/v1/payment_links/${link.id}/payment_intent`,
        'POST',
        {},
        crypto.randomUUID(),
        false,
      )
    ).status,
  ).toBe(422);
  expect(
    (
      (await (
        await request(`/v1/payment_links/${link.id}/public`, 'GET', undefined, undefined, false)
      ).json()) as PublicPaymentLink
    ).active,
  ).toBe(false);
});
test('pagination cursor is bound to organization, environment and list', async () => {
  await make();
  const page = contributionListSchema.parse(
    await (await request(`${root}?environment=development&limit=1`)).json(),
  );
  expect(page.nextCursor).toBeString();
  expect(
    (
      await request(
        root.replace('contrib-app', 'other-app') +
          `?environment=development&cursor=${page.nextCursor}`,
      )
    ).status,
  ).toBe(400);
  expect((await request(`${root}?environment=development&cursor=${page.nextCursor}`)).status).toBe(
    200,
  );
});
test('contribution confirmations use the existing non-custodial watcher and CAS outbox path', async () => {
  const { SettlementWatcher } = await import('../../services/settlementWatcher');
  const { transitionIntent } = await import('../../services/intentTransition');
  const link = await make();
  const minted = (await (
    await request(
      `/v1/payment_links/${link.id}/payment_intent`,
      'POST',
      {},
      crypto.randomUUID(),
      false,
    )
  ).json()) as { id: string };
  const intent = await findIntentByPublicId(gatewayDb(), minted.id);
  if (!intent?.address) throw new Error('Expected watch-only address');
  await transitionIntent(intent.id, {
    from: 'created',
    status: 'broadcast',
    txid: 'contribution_fixture_tx',
  });
  const address = intent.address;
  let confirmations = 0;
  const changes: string[] = [];
  const watcher = new SettlementWatcher({
    getTransaction: async (txid) =>
      txid === 'contribution_fixture_tx'
        ? {
            txid,
            confirmations,
            outputs: [{ address, valueSat: BigInt(intent.amount) }],
          }
        : null,
    onChange: (row) => {
      changes.push(row.status);
    },
  });
  await watcher.check();
  expect((await findIntentByPublicId(gatewayDb(), minted.id))?.status).toBe('confirming');
  confirmations = 10;
  await watcher.check();
  await watcher.check();
  expect(changes).toEqual(['confirming', 'settled']);
  const report = contributionCollectionListSchema.parse(
    await (await request(`${root}/${link.id}/collections?environment=development`)).json(),
  );
  expect(report.items[0]?.status).toBe('settled');
  expect(report.items[0]?.refunds).toEqual([]);
});
test('disabled links recover a previously minted attempt but refuse a new operation', async () => {
  const link = await make(),
    key = crypto.randomUUID(),
    path = `/v1/payment_links/${link.id}/payment_intent`;
  const first = (await (await request(path, 'POST', {}, key, false)).json()) as { id: string };
  expect(
    (await request(`${root}/${link.id}?environment=development`, 'PATCH', { active: false }))
      .status,
  ).toBe(200);
  const replay = await request(path, 'POST', {}, key, false);
  expect(replay.status).toBe(201);
  expect(((await replay.json()) as { id: string }).id).toBe(first.id);
  expect((await request(path, 'POST', {}, crypto.randomUUID(), false)).status).toBe(422);
});
