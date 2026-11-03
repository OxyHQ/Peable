/**
 * Peable Tax's merchant API (`/v1/tax/*`, ADR 0011) over HTTP, against a real
 * Postgres, through the real gateway with only the Oxy credential stubbed.
 * Every answer is checked against its contract by the test preload
 * (`__tests__/setup/contractCheck.ts`), so this walks each route once.
 *
 * No tax provider is configured: a sale where the merchant is not registered
 * is zero tax recorded as `not_registered`, which needs none.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createGateway, type Gateway } from '../../server';
import { requestIdMiddleware } from '../../lib/requestId';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import { commitTaxTransaction, createTaxService } from '../../services/tax/taxService';
import {
  gatewayDb,
  POSTGRES_TESTS_ENABLED,
  resetGatewayTables,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createDashboardTaxRouter } from '../tax';

type Json = Record<string, unknown>;

const APP = 'app_tax_api';

let gateway: Gateway | undefined;
let apiUrl = '';
let dashboardServer: Server | undefined;
let dashboardUrl = '';
let merchant: MerchantRow;
const tax = () => createTaxService({ db: gatewayDb() });

const stubRequireMerchant: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).serviceApp = {
    appId: APP,
    appName: 'tax',
    scopes: ['payments:read', 'payments:write'],
    credentialId: 'c',
    ownerAccountId: 'owner',
    environment: 'production',
    tier: 'external',
  };
  next();
};

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json; text: string; headers: Headers }> {
  const response = await fetch(`${apiUrl}/v1/tax${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json = (text.startsWith('{') ? JSON.parse(text) : {}) as Json;
  return { status: response.status, json, text, headers: response.headers };
}

const errorOf = (answer: { json: Json }) => answer.json.error as Json;

useGatewayDatabase();

beforeAll(() => {
  gateway = createGateway({
    requireMerchant: stubRequireMerchant,
    optionalServiceAuth: (_req, _res, next) => next(),
    requireOxyUser: (_req, res) => {
      res.status(401).end();
    },
    taxService: createTaxService({ db: gatewayDb() }),
  });
  gateway.httpServer.listen(0);
  apiUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(
    createDashboardTaxRouter({
      tax: createTaxService({ db: gatewayDb() }),
      requireOxyUser: (req, _res, next) => {
        (req as OxyAuthRequest).userId = 'owner';
        (req as OxyAuthRequest).accessToken = 'token-for-owner';
        next();
      },
      assertAppMembership: async () => ({
        allowed: true,
        permissions: ['app:read', 'billing:read', 'billing:manage'],
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

describe.skipIf(!POSTGRES_TESTS_ENABLED)('the Peable Tax merchant API', () => {
  beforeEach(async () => {
    await resetGatewayTables();
    merchant = await seedMerchant({ oxyAppId: APP, environment: 'production', network: 'mainnet' });
  });

  test('catalog, settings, registrations and product codes', async () => {
    const codes = await api('GET', '/codes');
    expect(codes.status).toBe(200);
    expect(codes.json).toMatchObject({ object: 'list', has_more: false, url: '/v1/tax/codes' });

    const settings = await api('GET', '/settings');
    expect(settings.json).toMatchObject({ object: 'tax.settings', status: 'draft' });

    expect((await api('GET', '/registrations')).json.data).toEqual([]);

    const set = await api('PUT', '/products/plan_pro', { tax_code: 'txcd_10103001' });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ object: 'tax.product', product_ref: 'plan_pro' });
    expect((await api('GET', '/products')).json.data).toHaveLength(1);

    const unknown = await api('PUT', '/products/plan_pro', { tax_code: 'txcd_99999999' });
    expect([unknown.status, errorOf(unknown).code]).toEqual([400, 'invalid_tax_code']);
    const badRef = await api('PUT', '/products/plan%20pro', { tax_code: 'txcd_10103001' });
    expect([badRef.status, errorOf(badRef).code]).toEqual([400, 'invalid_tax_request']);
  });

  test('evidence, a calculation, its transaction, a reversal and the report', async () => {
    const evidence = await api('POST', '/location_evidence', {
      customer_ref: 'payer_synthetic',
      evidence: [
        { type: 'billing_address', address: { country: 'DE', postal_code: '10115' } },
        { type: 'ip_address', ip_address: '192.0.2.1', country: 'DE' },
      ],
    });
    expect(evidence.status).toBe(201);
    expect(evidence.json).toMatchObject({ object: 'tax.location_evidence', status: 'sufficient' });
    const evidenceId = String(evidence.json.id);
    expect((await api('GET', `/location_evidence/${evidenceId}`)).status).toBe(200);
    const notIp = await api('POST', '/location_evidence', {
      customer_ref: 'payer_synthetic',
      evidence: [{ type: 'ip_address', ip_address: '999.0.0.1', country: 'DE' }],
    });
    expect([notIp.status, errorOf(notIp).param]).toEqual([400, 'evidence[0][ip_address]']);

    const body = {
      currency: 'eur',
      customer_location_evidence_id: evidenceId,
      line_items: [{ reference: 'plan_pro', amount: 1000 }],
    };
    const unapproved = await api('POST', '/calculations', body);
    expect([unapproved.status, errorOf(unapproved).code]).toEqual([409, 'tax_settings_not_active']);

    await tax().updateSettings(merchant, {
      legal_name: 'Synthetic Software SL',
      head_office: { country: 'ES', postal_code: '08001', city: 'Barcelona' },
    });
    await tax().approve(merchant, { userId: 'owner', officialApplication: false });

    const calculation = await api('POST', '/calculations', body);
    expect(calculation.status).toBe(201);
    expect(calculation.json).toMatchObject({
      object: 'tax.calculation',
      currency: 'EUR',
      collection: 'not_registered',
      amount_total: 1000,
    });
    const calculationId = String(calculation.json.id);
    expect((await api('GET', `/calculations/${calculationId}`)).json.id).toBe(calculationId);

    const invalid = await api('POST', '/calculations', { ...body, line_items: [] });
    expect([invalid.status, errorOf(invalid).code, errorOf(invalid).param]).toEqual([
      400,
      'invalid_tax_request',
      'line_items',
    ]);

    await commitTaxTransaction(gatewayDb(), {
      calculationPublicId: calculationId,
      reference: 'order_synthetic',
      rail: 'faircoin',
      committedAt: new Date(),
    });
    const transactions = await api('GET', '/transactions');
    expect(transactions.json).toMatchObject({ object: 'list', has_more: false });
    const [sale] = transactions.json.data as Json[];
    expect(sale).toMatchObject({ object: 'tax.transaction', type: 'transaction', reversal: null });

    const reversal = await api('POST', `/transactions/${String(sale?.id)}/reversals`, {
      reference: 'refund_synthetic',
      amount: 400,
    });
    expect(reversal.status).toBe(201);
    expect(reversal.json).toMatchObject({
      type: 'reversal',
      reversal_of: sale?.id,
      reversal: { amount_total: -400 },
    });

    const now = Math.floor(Date.now() / 1000);
    const window = `from=${now - 3600}&to=${now + 3600}`;
    const report = await api('GET', `/reports/summary?${window}`);
    expect(report.status).toBe(200);
    expect(report.json).toMatchObject({ object: 'tax.report' });
    expect((report.json.rows as Json[])[0]).toMatchObject({
      country: 'DE',
      collection: 'not_registered',
      transactions: 1,
      reversals: 1,
    });

    const csv = await api('GET', `/reports/summary?${window}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toStartWith('country,state,registration_id');

    const format = await api('GET', `/reports/summary?${window}&format=xml`);
    expect([format.status, errorOf(format).param]).toEqual([400, 'format']);
    const missing = await api('GET', '/reports/summary');
    expect([missing.status, errorOf(missing).code]).toEqual([400, 'invalid_tax_request']);

    // Orbit's copy of the report carries `environment` beside the window.
    const dashboard = await fetch(
      `${dashboardUrl}/v1/dashboard/applications/${APP}/tax/reports/summary?environment=production&${window}`,
    );
    expect(dashboard.status).toBe(200);
    expect(((await dashboard.json()) as Json).object).toBe('tax.report');
  });
});
