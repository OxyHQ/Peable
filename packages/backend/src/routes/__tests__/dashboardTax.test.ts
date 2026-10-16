import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { TaxRegistration, TaxSettings } from '@peable.to/shared-types';
import type { AppMembershipResult } from '../../services/appMembership';
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
const MEMBERS: Record<string, AppMembershipResult> = {
  owner: {
    allowed: true,
    permissions: ['app:read', 'billing:read', 'billing:manage'],
    official: true,
  },
  viewer: { allowed: true, permissions: ['app:read', 'billing:read'], official: true },
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
      tax: createTaxService({ db: gatewayDb(), provider }),
      requireOxyUser,
      assertAppMembership: async (userId) => MEMBERS[userId] ?? { allowed: false },
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
            legalName: 'Example Seller, Inc.',
            headOffice: { country: 'US', state: 'DE' },
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
    expect(body.settings).toMatchObject({ status: 'active', approvedBy: 'owner' });
    expect(body.registrations[0]).toMatchObject({ status: 'active' });
    expect(synced).toEqual(['US-NY']);
  });

  test('billing:read may look but not change or approve', async () => {
    expect((await call('/settings', { user: 'viewer' })).status).toBe(200);
    expect((await call('/approve', { method: 'POST', user: 'viewer' })).status).toBe(403);
    expect((await call('/settings', { user: 'stranger' })).status).toBe(403);
  });

  test('an invalid registration is refused with its reason', async () => {
    const response = await call('/registrations', {
      method: 'POST',
      body: JSON.stringify({ country: 'US', scheme: 'standard' }),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_registration',
    );
  });
});
