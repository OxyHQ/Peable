import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { TaxRegistration, TaxSettings } from '@peable.to/shared-types';
import { stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';
import type { ApplicationAnswer } from '../../__tests__/helpers/oxyAccessStub';
import {
  gatewayDb,
  seedMerchant,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { createTaxService } from '../../services/tax/taxService';
import type { TaxProvider } from '../../services/tax/provider';
import { createDashboardTaxRouter } from '../tax';

const APP_ID = 'app_tax_dashboard';
/** Members by user id: what oxy-api would report for each. */
const MEMBERS: Record<string, ApplicationAnswer> = {
  owner: { permissions: ['app:read', 'billing:read', 'billing:manage'], official: true },
  viewer: { permissions: ['app:read', 'billing:read'], official: true },
};
const requireOxyUser: RequestHandler = (req, _res, next) => {
  const userId = req.header('X-Test-User-Id') ?? 'owner';
  (req as OxyAuthRequest).userId = userId;
  (req as OxyAuthRequest).accessToken = `token-${userId}`;
  next();
};
const synced: string[] = [];
const provider: TaxProvider = {
  id: 'fake_tax',
  livemode: true,
  async status() {
    return { active: true, headOffice: null, missing: [] };
  },
  async ensureHeadOffice() {},
  async syncRegistration(registration) {
    synced.push(`${registration.country}-${registration.state}`);
    return { providerRef: 'taxreg_provider' };
  },
  async calculate() {
    throw new Error('not used');
  },
};

useGatewayDatabase();
let server: Server;
let base: string;
beforeAll(async () => {
  await seedMerchant({ oxyAppId: APP_ID, environment: 'production', network: 'mainnet' });
  const app = express();
  app.use(express.json());
  app.use(
    createDashboardTaxRouter({
      tax: createTaxService({ db: gatewayDb(), providers: [provider] }),
      requireOxyUser,
      access: stubOxyAccess({ application: (userId) => MEMBERS[userId] }),
    }),
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dashboard/applications/${APP_ID}/tax`;
});
afterAll(() => server.close());

const call = (path: string, init: RequestInit & { user?: string } = {}) =>
  fetch(`${base}${path}?environment=production`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Test-User-Id': init.user ?? 'owner' },
  });

describe('dashboard tax', () => {
  test('the owner enters settings and a registration, then approves', async () => {
    expect(
      (
        await call('/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            legal_name: 'Example Seller, Inc.',
            head_office: { country: 'US', state: 'DE', postal_code: '19801' },
          }),
        })
      ).status,
    ).toBe(200);
    const created = await call('/registrations', {
      method: 'POST',
      body: JSON.stringify({ country: 'US', state: 'NY', scheme: 'us_state_sales_tax' }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as TaxRegistration).status).toBe('pending_approval');
    const approved = await call('/approve', { method: 'POST' });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      settings: TaxSettings;
      registrations: TaxRegistration[];
    };
    expect(body.settings).toMatchObject({
      status: 'active',
      approved_by: 'owner',
      head_office: { country: 'US', state: 'DE', postal_code: '19801' },
    });
    expect(typeof body.settings.approved_at).toBe('number');
    expect(body.registrations[0]).toMatchObject({ status: 'active' });
    expect(synced).toEqual(['US-NY']);
  });

  test('billing:read may look but not change or approve', async () => {
    expect((await call('/settings', { user: 'viewer' })).status).toBe(200);
    const refused = await call('/approve', { method: 'POST', user: 'viewer' });
    expect(refused.status).toBe(403);
    // Orbit names the permission and who grants it from `code` + `param`.
    expect(((await refused.json()) as { error: unknown }).error).toMatchObject({
      type: 'permission_error',
      code: 'permission_required',
      param: 'billing:manage',
    });
    expect((await call('/settings', { user: 'stranger' })).status).toBe(403);
  });

  test('an invalid registration is refused with its reason', async () => {
    const response = await call('/registrations', {
      method: 'POST',
      body: JSON.stringify({ country: 'US', scheme: 'standard' }),
    });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as {
      error: { type: string; code: string; message: string; request_id: string | null };
    };
    expect(error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_registration' });
    expect(error.message).not.toContain('invalid_registration');
    expect(error).toHaveProperty('request_id');
  });

  test('a malformed request names the offending field', async () => {
    const response = await call('/registrations', {
      method: 'POST',
      body: JSON.stringify({
        country: 'US',
        state: 'NY',
        scheme: 'us_state_sales_tax',
        active_from: 'soon',
      }),
    });
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string; param?: string } }).error,
    ).toMatchObject({ code: 'invalid_tax_request', param: 'active_from' });
  });
});
