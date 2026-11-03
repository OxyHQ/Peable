/**
 * Orbit's Connect routes over HTTP against a real Postgres: the dashboard
 * mounts the SAME cores as `/v1/connected_accounts` and `/v1/transfers` behind
 * its membership gate, and `GET /v1/events?payment_intent=` narrows the events
 * to one payment.
 *
 * What is pinned:
 *  - sellers: list (the merchant's own account is never one), retrieve, open
 *    a FairCoin-only seller and mint its key link; another merchant's seller is
 *    a 404;
 *  - transfers globally and per seller, their reversals (dashboard and API),
 *    and a reversal refused before any provider call without its reference;
 *  - a non-member is refused 403 on every route;
 *  - the per-payment event filter, scoped to the merchant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { sql } from 'drizzle-orm';
import type { OxyAuthRequest, OxyServiceEnvironment } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { createDashboardRouter } from '../dashboard';
import { requestIdMiddleware } from '../../lib/requestId';
import { newId } from '../../lib/ids';
import { toPaymentIntentDTO } from '../../lib/serialize';
import { stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';
import { recordEvent } from '../../services/events';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  insertConnectedAccount,
  insertMerchantAccount,
  type ConnectedAccountRow,
} from '../../db/accounts/connectedAccountRepository';
import { insertTransfer } from '../../db/transfers/transferRepository';
import { insertTransferReversal } from '../../db/transfers/transferReversalRepository';
import { must } from '../../__tests__/helpers/must';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedIntent,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';

type Json = Record<string, unknown>;

const APP_ID = 'app_orbit_connect';
const MEMBER = 'user_member';
const OUTSIDER = 'user_outsider';
const environment: OxyServiceEnvironment = 'development';

/** A day of October 2026, UTC, at noon. */
const inRange = (day: number) => new Date(Date.UTC(2026, 9, day, 12));

let gateway: Gateway | undefined;
let baseUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchant: MerchantRow;

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP_ID,
    appName: 'orbit',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment,
    tier: 'external',
  };
  next();
};

interface Answer {
  status: number;
  headers: Headers;
  body: string;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(url, { headers });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

const api = (path: string, headers?: Record<string, string>) => get(`${baseUrl}${path}`, headers);

function dashboard(path: string, user = MEMBER, query = ''): Promise<Answer> {
  const separator = path.includes('?') ? '&' : '?';
  return get(
    `${dashboardUrl}/v1/dashboard/applications/${APP_ID}${path}${separator}environment=${environment}${query}`,
    { 'X-Test-User-Id': user },
  );
}

async function dashboardPost(path: string, body: unknown, user = MEMBER): Promise<Answer> {
  const response = await fetch(
    `${dashboardUrl}/v1/dashboard/applications/${APP_ID}${path}?environment=${environment}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User-Id': user },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, headers: response.headers, body: await response.text() };
}

const errorOf = (answer: Answer) => (JSON.parse(answer.body) as { error: Json }).error;

async function setCreated(table: string, id: string, at: Date): Promise<void> {
  await gatewayDb().execute(
    sql`update ${sql.identifier(table)} set created_at = ${at.toISOString()} where id = ${id}`,
  );
}

async function cardIntent(values: { day: number; description?: string; amount?: string }) {
  const row = await seedIntent(merchant, {
    rail: 'card',
    amount: values.amount ?? '1999',
    currency: 'EUR',
    metadata: { order: 'A,1' },
  });
  if (values.description !== undefined) {
    await gatewayDb().execute(
      sql`update payment_intents set description = ${values.description} where id = ${row.id}`,
    );
  }
  await setCreated('payment_intents', row.id, inRange(values.day));
  return row;
}

async function ownAccount(): Promise<ConnectedAccountRow> {
  return must(
    await insertMerchantAccount(gatewayDb(), {
      publicId: newId('ca'),
      merchantId: merchant.id,
      provider: 'stripe',
      providerAccountId: 'acct_own',
      country: 'ES',
    }),
  );
}

async function cardSeller(ref: string, forMerchant = merchant): Promise<ConnectedAccountRow> {
  return must(
    await insertConnectedAccount(gatewayDb(), {
      publicId: newId('ca'),
      merchantId: forMerchant.id,
      externalRef: ref,
      provider: 'stripe',
      providerAccountId: `acct_${ref}`,
      country: 'ES',
    }),
  );
}

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
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

describe.skipIf(!POSTGRES_TESTS_ENABLED)("Orbit's Connect routes", () => {
  beforeEach(async () => {
    await resetGatewayTables();
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment });
  });

  test('sellers: list, retrieve and open — the merchant’s own account is not a seller', async () => {
    await ownAccount();
    const seller = await cardSeller('store-1');
    const elsewhere = await cardSeller('store-x', await seedMerchant({ environment }));

    const list = JSON.parse((await dashboard('/connected_accounts')).body) as Json;
    expect((list.data as Json[]).map((account) => account.id)).toEqual([seller.publicId]);
    expect((await dashboard(`/connected_accounts/${seller.publicId}`)).status).toBe(200);
    expect((await dashboard(`/connected_accounts/${elsewhere.publicId}`)).status).toBe(404);

    const opened = await dashboardPost('/connected_accounts', {
      external_ref: 'seller-fair',
      faircoin: { network: 'testnet', oxy_user_id: 'user_seller' },
    });
    expect(opened.status).toBe(201);
    const account = JSON.parse(opened.body) as Json;
    expect(account).toMatchObject({ object: 'connected_account', rails: ['faircoin'] });

    const link = await dashboardPost(`/connected_accounts/${String(account.id)}/account_links`, {
      refresh_url: 'https://orbit.peable.to/connect',
      return_url: 'https://orbit.peable.to/connect',
      rail: 'faircoin',
    });
    expect(link.status).toBe(201);
    expect(JSON.parse(link.body)).toMatchObject({ object: 'account_link' });

    const refused = await dashboardPost('/connected_accounts', { external_ref: 'x' });
    expect(refused.status).toBe(400);
  });

  test('transfers: global, per seller and their reversals', async () => {
    const seller = await cardSeller('store-1');
    const other = await cardSeller('store-2');
    const intent = await cardIntent({ day: 2 });
    const transfer = must(
      await insertTransfer(gatewayDb(), {
        publicId: newId('tr'),
        merchantId: merchant.id,
        paymentIntentId: intent.id,
        connectedAccountId: seller.id,
        externalRef: 'order-1',
        amount: '1000',
        currency: 'EUR',
        provider: 'stripe',
        sourcePaymentObjectId: null,
      }),
    );
    const reversal = must(
      await insertTransferReversal(gatewayDb(), {
        publicId: newId('trr'),
        merchantId: merchant.id,
        transferId: transfer.id,
        externalRef: 'rev-1',
        amount: '250',
        currency: 'EUR',
        provider: 'stripe',
      }),
    );

    const ids = async (path: string, query = '') =>
      ((JSON.parse((await dashboard(path, MEMBER, query)).body) as Json).data as Json[]).map(
        (object) => object.id,
      );
    expect(await ids('/transfers')).toEqual([transfer.publicId]);
    expect(await ids('/transfers', `&connected_account=${seller.publicId}`)).toEqual([
      transfer.publicId,
    ]);
    expect(await ids('/transfers', `&connected_account=${other.publicId}`)).toEqual([]);
    expect(await ids(`/transfers/${transfer.publicId}/reversals`)).toEqual([reversal.publicId]);

    const viaApi = JSON.parse(
      (await api(`/v1/transfers/${transfer.publicId}/reversals`)).body,
    ) as Json;
    expect(viaApi).toMatchObject({ object: 'list', has_more: false });
    expect((viaApi.data as Json[])[0]).toMatchObject({
      id: reversal.publicId,
      object: 'transfer_reversal',
      amount: '250',
      external_ref: 'rev-1',
    });

    const retrieved = JSON.parse((await dashboard(`/transfers/${transfer.publicId}`)).body) as Json;
    expect(retrieved).toMatchObject({ id: transfer.publicId, connected_account: seller.publicId });
    // A reversal names its own reference; without one it is refused before any provider call.
    expect(
      (await dashboardPost(`/transfers/${transfer.publicId}/reversals`, { amount: '1' })).status,
    ).toBe(400);
  });

  test('an outsider reaches none of it', async () => {
    const seller = await cardSeller('store-1');
    for (const path of [
      '/connected_accounts',
      `/connected_accounts/${seller.publicId}`,
      '/transfers',
    ]) {
      expect([path, (await dashboard(path, OUTSIDER)).status]).toEqual([path, 403]);
    }
    const opened = await dashboardPost(
      '/connected_accounts',
      { external_ref: 'x', faircoin: { network: 'testnet', oxy_user_id: 'u' } },
      OUTSIDER,
    );
    expect(opened.status).toBe(403);
  });
});

describe.skipIf(!POSTGRES_TESTS_ENABLED)('events of one payment', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    merchant = await seedMerchant({ oxyAppId: APP_ID, environment });
  });

  test('`payment_intent=` narrows the events to that payment, scoped to the merchant', async () => {
    const mine = await cardIntent({ day: 4 });
    const another = await cardIntent({ day: 5 });
    for (const intent of [mine, another]) {
      await recordEvent(gatewayDb(), {
        merchantId: merchant.id,
        type: 'payment_intent.created',
        object: toPaymentIntentDTO(intent),
        paymentIntentId: intent.id,
      });
    }
    const page = JSON.parse((await api(`/v1/events?payment_intent=${mine.publicId}`)).body) as Json;
    const objects = (page.data as Json[]).map((event) => (event.data as Json).object as Json);
    expect(objects.map((object) => object.id)).toEqual([mine.publicId]);

    const viaDashboard = JSON.parse(
      (await dashboard('/events', MEMBER, `&payment_intent=${another.publicId}`)).body,
    ) as Json;
    expect((viaDashboard.data as Json[]).length).toBe(1);

    const foreign = await seedIntent(await seedMerchant({ environment }), { rail: 'card' });
    const refused = await api(`/v1/events?payment_intent=${foreign.publicId}`);
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toMatchObject({ code: 'resource_missing', param: 'payment_intent' });
  });
});
