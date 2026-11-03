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
const { createCheckoutSessionsRouter } = await import('../checkoutSessions');
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
    createCheckoutSessionsRouter({
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
/**
 * A donor contributing (Orbit Phase 3): the visit starts a Checkout Session
 * under the operation key, and confirming it creates the payment. Answers the
 * start's refusal as it is, or the confirmed payment (201) — the shape the
 * pre-Phase-3 mint answered, so the assertions read the same facts.
 */
async function contribute(linkId: string, body: unknown, key: string | undefined) {
  const start = await request(
    `/v1/payment_links/${linkId}/checkout_sessions`,
    'POST',
    body,
    key,
    false,
  );
  if (start.status !== 201) return start;
  const session = (await start.json()) as { id: string; client_secret: string };
  const headers = {
    'Content-Type': 'application/json',
    'X-Peable-Client-Secret': session.client_secret,
  };
  await fetch(`${base}/v1/checkout_sessions/${session.id}/public`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ customer_details: { email: 'donor@example.com' } }),
  });
  const confirmed = await fetch(`${base}/v1/checkout_sessions/${session.id}/public/confirm`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const json = (await confirmed.json()) as { payment_intent?: unknown };
  return new Response(JSON.stringify(json.payment_intent ?? json), {
    status: confirmed.status === 200 ? 201 : confirmed.status,
  });
}

async function make(amountMode: 'fixed' | 'free' = 'fixed') {
  const r = await request(
    `${root}?environment=development`,
    'POST',
    {
      purpose: 'Community kitchen',
      currency: 'FAIR',
      amount_mode: amountMode,
      ...(amountMode === 'fixed' ? { amount: '500' } : {}),
    },
    crypto.randomUUID(),
  );
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; contribution: { purpose: string } };
}
test('concurrent creation and lost-response replay return one immutable link', async () => {
  const key = crypto.randomUUID(),
    body = { purpose: 'Garden', currency: 'FAIR', amount_mode: 'fixed', amount: '1000' };
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
  expect((await contribute(link.id, { amount: '800' }, crypto.randomUUID())).status).toBe(400);
});
test('free amount canonical bounds and missing operation keys fail before money is created', async () => {
  const link = await make('free');
  for (const amount of ['0', '050', '1.5', '-1', '9007199254740992', '1e3'])
    expect((await contribute(link.id, { amount }, crypto.randomUUID())).status).toBe(400);
  expect((await contribute(link.id, { amount: '500' }, undefined)).status).toBe(400);
});
test('lost HTTP reply and concurrent retries converge on one FairCoin intent/address', async () => {
  const link = await make('free'),
    key = crypto.randomUUID(),
    path = link.id;
  // The first result is deliberately discarded, as on a lost transport reply.
  expect((await contribute(path, { amount: '700' }, key)).status).toBe(201);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => contribute(path, { amount: '700' }, key)),
  );
  expect(responses.every((r) => r.status === 201)).toBe(true);
  const values = await Promise.all(
    responses.map((r) => r.json() as Promise<{ id: string; address: string; rail: string }>),
  );
  expect(new Set(values.map((r) => r.id)).size).toBe(1);
  expect(new Set(values.map((r) => r.address)).size).toBe(1);
  expect(values[0]?.rail).toBe('faircoin');
  expect((await contribute(path, { amount: '800' }, key)).status).toBe(409);
  const first = values[0];
  if (!first) throw new Error('No successful response');
  const stored = await findIntentByPublicId(gatewayDb(), first.id);
  expect(stored?.paymentLinkId).toBeTruthy();
  expect(stored?.provider).toBeNull();
  const body = contributionCollectionListSchema.parse(
    await (await request(`${root}/${link.id}/collections?environment=development`)).json(),
  );
  expect(body.object).toBe('list');
  expect(body.data).toHaveLength(1);
  expect(body.data[0]?.id).toBe(values[0]?.id);
  expect(body.data[0]?.object).toBe('payment_intent');
  expect(body.data[0]?.refund_capability).toBe('unsupported_non_custodial');
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
    (await request(`${root}/${link.id}?environment=development`, 'POST', { active: false })).status,
  ).toBe(200);
  expect((await contribute(link.id, {}, crypto.randomUUID())).status).toBe(400);
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
  expect((await contribute(link.id, {}, crypto.randomUUID())).status).toBe(400);
  expect(
    (
      (await (
        await request(`/v1/payment_links/${link.id}/public`, 'GET', undefined, undefined, false)
      ).json()) as PublicPaymentLink
    ).active,
  ).toBe(false);
});
test('starting_after is resolved inside the organization, application and list', async () => {
  await make();
  await make();
  const page = contributionListSchema.parse(
    await (await request(`${root}?environment=development&limit=1`)).json(),
  );
  expect(page.object).toBe('list');
  expect(page.has_more).toBe(true);
  const last = page.data.at(-1)?.id;
  if (!last) throw new Error('expected one link on the first page');
  // Another application's list cannot page from this application's link.
  const foreign = await request(
    `${root.replace('contrib-app', 'other-app')}?environment=development&starting_after=${last}`,
  );
  expect(foreign.status).toBe(400);
  expect(((await foreign.json()) as { error: { param?: string } }).error.param).toBe(
    'starting_after',
  );
  const next = contributionListSchema.parse(
    await (await request(`${root}?environment=development&limit=1&starting_after=${last}`)).json(),
  );
  expect(next.data[0]?.id).not.toBe(last);
  // A collection id is not a link id: the lists do not share cursors.
  expect((await request(`${root}?environment=development&starting_after=pi_unknown`)).status).toBe(
    400,
  );
});
test('contribution confirmations use the existing non-custodial watcher and CAS outbox path', async () => {
  const { SettlementWatcher } = await import('../../services/settlementWatcher');
  const { transitionIntent } = await import('../../services/intentTransition');
  const link = await make();
  const minted = (await (await contribute(link.id, {}, crypto.randomUUID())).json()) as {
    id: string;
  };
  const intent = await findIntentByPublicId(gatewayDb(), minted.id);
  if (!intent?.address) throw new Error('Expected watch-only address');
  await transitionIntent(intent.id, {
    from: 'requires_action',
    status: 'processing',
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
  expect((await findIntentByPublicId(gatewayDb(), minted.id))?.status).toBe('processing');
  confirmations = 10;
  await watcher.check();
  await watcher.check();
  // 0 confirmations writes nothing new; 10 succeeds in one write.
  expect(changes).toEqual(['succeeded']);
  const report = contributionCollectionListSchema.parse(
    await (await request(`${root}/${link.id}/collections?environment=development`)).json(),
  );
  expect(report.data[0]?.status).toBe('succeeded');
  expect(report.data[0]?.refunds).toEqual([]);
});
test('disabled links recover a previously minted attempt but refuse a new operation', async () => {
  const link = await make(),
    key = crypto.randomUUID(),
    path = link.id;
  const first = (await (await contribute(path, {}, key)).json()) as { id: string };
  expect(
    (await request(`${root}/${link.id}?environment=development`, 'POST', { active: false })).status,
  ).toBe(200);
  const replay = await contribute(path, {}, key);
  expect(replay.status).toBe(201);
  expect(((await replay.json()) as { id: string }).id).toBe(first.id);
  expect((await contribute(path, {}, crypto.randomUUID())).status).toBe(400);
});
