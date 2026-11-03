import { afterAll, beforeAll, expect, test } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createDashboardRouter } from '../dashboard';
import {
  gatewayDb,
  seedMerchant,
  seedIntent,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { bindBillingObject } from '../../db/billing/billingRepository';
import { bindRecurringObject } from '../../db/recurring/recurringMirrorRepository';
import { insertConnectedAccount } from '../../db/accounts/connectedAccountRepository';

useGatewayDatabase();
let server: Server;
let base: string;
const auth: RequestHandler = (req, res, next) => {
  const user = req.header('X-Test-User');
  if (!user) {
    res.status(401).end();
    return;
  }
  (req as OxyAuthRequest).userId = user;
  (req as OxyAuthRequest).accessToken = 'test-user-bearer';
  next();
};
beforeAll(async () => {
  for (const [name, app, environment] of [
    ['own', 'orbit-app', 'development'],
    ['foreign', 'other-app', 'development'],
    ['live', 'orbit-app', 'production'],
  ] as const) {
    const merchant = await seedMerchant({ publicId: `merch_${name}`, oxyAppId: app, environment });
    await seedIntent(merchant, {
      publicId: `pi_${name}`,
      rail: 'card',
      amount: '599',
      currency: 'USD',
    });
    const deployment = {
      provider: 'stripe' as const,
      platformAccountId: 'acct_test',
      livemode: environment === 'production',
    };
    const owner = { merchantId: merchant.id, oxyAppId: app, environment };
    for (let index = 0; index < (name === 'own' ? 2 : 1); index++) {
      await bindBillingObject(gatewayDb(), deployment, owner, {
        kind: 'customer',
        providerRef: `cus_${name}${index}`,
        externalSubjectRef: `subject-${name}${index}`,
        bindingEvidenceRef: 'test-evidence',
      });
      for (const kind of ['subscription', 'invoice'] as const)
        await bindRecurringObject(
          gatewayDb(),
          { ...deployment, environment, apiVersion: '2026-07-29.dahlia' },
          {
            merchantId: merchant.id,
            providerAccountId: null,
            kind,
            objectRef: `${kind === 'subscription' ? 'sub' : 'in'}_${name}${index}`,
            bindingEvidenceRef: 'test-evidence',
          },
        );
    }
    await insertConnectedAccount(gatewayDb(), {
      publicId: `ca_${name}`,
      merchantId: merchant.id,
      externalRef: `seller-${name}`,
      provider: 'stripe',
      providerAccountId: `acct_${name}`,
      country: 'US',
    });
  }
  const app = express();
  app.use(
    createDashboardRouter({
      requireOxyUser: auth,
      assertAppMembership: async (user, application) => ({
        allowed: user === 'member' && application === 'orbit-app',
      }),
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
const read = (path: string, user = 'member', environment = 'development') =>
  fetch(
    `${base}/v1/dashboard/applications/orbit-app/${path}${path.includes('?') ? '&' : '?'}environment=${environment}`,
    { headers: user ? { 'X-Test-User': user } : {} },
  );

test('all finance reads enforce user and live application membership', async () => {
  for (const path of [
    'payment_intents/pi_own/refunds',
    'payment_intents/pi_own/disputes',
    'payment_intents/pi_own/settlement',
    'payment_intents/pi_own/transfers',
    'connected_accounts',
    'billing/customers',
    'billing/subscriptions',
    'billing/invoices',
  ]) {
    expect((await read(path, '')).status).toBe(401);
    expect((await read(path, 'outsider')).status).toBe(403);
  }
});
test('payment finance reads never reveal another merchant or environment', async () => {
  for (const kind of ['refunds', 'disputes', 'settlement', 'transfers']) {
    expect((await read(`payment_intents/pi_foreign/${kind}`)).status).toBe(404);
    expect((await read(`payment_intents/pi_live/${kind}`)).status).toBe(404);
    expect((await read(`payment_intents/pi_own/${kind}`)).status).toBe(200);
  }
  const settlement = await (await read('payment_intents/pi_own/settlement')).json();
  expect(settlement.status).toBe('unknown');
  expect(settlement.fee).toBeNull();
});
test('verified lists paginate owned rows and reject foreign cursors', async () => {
  for (const [path, prefix] of [
    ['customers', 'cus'],
    ['subscriptions', 'sub'],
    ['invoices', 'in'],
  ] as const) {
    const first = await (await read(`billing/${path}?limit=1`)).json();
    expect(first.source).toBe('verified_provider_bindings');
    expect(first.has_more).toBe(true);
    expect(first.data).toHaveLength(1);
    expect(first.data[0].id).toStartWith(`${prefix}_own`);
    const second = await (
      await read(`billing/${path}?limit=1&starting_after=${first.data[0].id}`)
    ).json();
    expect(second.has_more).toBe(false);
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect((await read(`billing/${path}?starting_after=${prefix}_foreign0`)).status).toBe(422);
    expect((await read(`billing/${path}?starting_after=${prefix}_live0`)).status).toBe(422);
    const live = await (await read(`billing/${path}`, 'member', 'production')).json();
    expect(live.data).toHaveLength(1);
    expect(live.data[0].id).toBe(`${prefix}_live0`);
    if (path !== 'customers') {
      expect(first.data[0].status).toBe('unknown');
      expect(first.data[0].observedAt).toBeNull();
    }
    if (path === 'invoices') {
      expect(first.data[0].amountPaid).toBeNull();
      expect(first.data[0].amountDue).toBeNull();
    }
  }
});
test('connected accounts use public ids and owner-scoped cursors', async () => {
  const body = await (await read('connected_accounts')).json();
  expect(body.data.map((row: { id: string }) => row.id)).toEqual(['ca_own']);
  expect((await read('connected_accounts?starting_after=ca_foreign')).status).toBe(422);
  expect((await read('connected_accounts?limit=101')).status).toBe(422);
});
