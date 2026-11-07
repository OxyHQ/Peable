/**
 * Every user-authorised route that acts on an application — Orbit's
 * dashboard, Peable Tax, the tax workspace and the contribution routes —
 * needs the permission its action names in `DASHBOARD_PERMISSIONS`, and
 * nothing less.
 *
 * This walks the REAL gateway and sends each route twice: once holding every
 * permission EXCEPT the one its action needs (refused, `permission_required`,
 * before any handler runs), and once holding only that one (let through — the
 * application has no merchant, so it ends in the 404 behind the gate, or the
 * handler's own answer). The policy is restated below as RULES, so a route
 * whose gate drifts from it fails here, and a route the rules do not cover
 * fails too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  allowsDashboardAction,
  DASHBOARD_PERMISSIONS,
  type DashboardAction,
} from '@peable.to/contracts/vocabulary';
import { createGateway, type Gateway } from '../../server';
import {
  POSTGRES_TESTS_ENABLED,
  useGatewayDatabase,
} from '../../__tests__/helpers/gatewayTestDatabase';
import { EVERY_DASHBOARD_PERMISSION, stubOxyAccess } from '../../__tests__/helpers/oxyAccessStub';

/** The policy, by path under the application: the first rule that matches decides. */
const WRITE_RULES: readonly (readonly [RegExp, DashboardAction])[] = [
  // Peable Tax previews read the current state; every other tax write is the owner's.
  [/^\/tax\/(location_evidence|calculations)$/, 'taxRead'],
  [/^\/tax\//, 'money'],
  // Who receives money, and the money itself.
  [
    /^\/(merchant|account|account_links|payouts|connected_accounts|transfers|disputes)(\/|$)/,
    'money',
  ],
  // The billing engine, including the features a product grants.
  [/^\/products\/[^/]+\/features/, 'money'],
  [
    /^\/(subscriptions|subscription_items|invoices|invoiceitems|credit_notes|quotes|customers|test_helpers|billing_settings|billing|entitlements|billing_portal)(\/|$)/,
    'money',
  ],
  [/^\/(webhook_endpoints|webhook_deliveries)(\/|$)/, 'webhooks'],
  [
    /^\/(products|prices|coupons|promotion_codes|checkout_sessions|payment_links|branding|email_settings|payment_method_configurations|payment_method_domains)(\/|$)/,
    'configure',
  ],
  // An upload needs what its purpose is used for; with none named, the strictest.
  [/^\/files$/, 'money'],
  // A report run keeps the rows a download streams.
  [/^\/reporting\/report_runs$/, 'read'],
  // A schedule is standing configuration that mails people in the merchant's name.
  [/^\/reporting\/report_schedules(\/|$)/, 'configure'],
  // A contribution link is a payment link.
  [/^\/contributions(\/|$)/, 'configure'],
];

function expectedAction(method: string, path: string): DashboardAction | undefined {
  if (method === 'GET') return path.startsWith('/tax/') ? 'taxRead' : 'read';
  return WRITE_RULES.find(([pattern]) => pattern.test(path))?.[1];
}

const DASHBOARD = '/v1/dashboard/applications/:applicationId';
const CONTRIBUTIONS = '/v1/organizations/:organizationId/applications/:applicationId';

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
}

function routes(stack: readonly RouteLayer[]): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        found.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    } else if (layer.handle?.stack) {
      found.push(...routes(layer.handle.stack));
    }
  }
  return found;
}

/** The person a request is made as, and what Oxy says they hold. */
const requireOxyUser: RequestHandler = (req, _res, next) => {
  (req as OxyAuthRequest).userId = 'user_member';
  (req as OxyAuthRequest).accessToken = 'token';
  next();
};
/** Per application id, so each request names what it holds. */
const held = new Map<string, readonly string[]>();
const access = stubOxyAccess({
  application: (_userId, applicationId) => ({
    permissions: held.get(applicationId) ?? [],
    ownerAccountId: 'acct_owner',
  }),
  account: () => ({ kind: 'organization' }),
});

useGatewayDatabase();
let gateway: Gateway | undefined;
let baseUrl = '';
let surface: { method: string; path: string; action: DashboardAction | undefined }[] = [];

beforeAll(() => {
  gateway = createGateway({
    requireOxyUser,
    access,
    requireMerchant: (_req, _res, next) => next(),
    optionalServiceAuth: (_req, _res, next) => next(),
  });
  gateway.httpServer.listen(0);
  baseUrl = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
  const stack = (gateway.app as unknown as { _router: { stack: RouteLayer[] } })._router.stack;
  surface = routes(stack).flatMap(({ method, path }) => {
    const under = path.startsWith(DASHBOARD)
      ? path.slice(DASHBOARD.length)
      : path.startsWith(CONTRIBUTIONS)
        ? path.slice(CONTRIBUTIONS.length)
        : null;
    return under === null ? [] : [{ method, path, action: expectedAction(method, under) }];
  });
});
afterAll(() => {
  gateway?.io.close();
  gateway?.httpServer.close();
});

let n = 0;
async function send(
  method: string,
  path: string,
  permissions: readonly string[],
  body: unknown = {},
): Promise<{ status: number; code: string | undefined }> {
  n += 1;
  const applicationId = `app_perm_${n}`;
  held.set(applicationId, permissions);
  const url = path
    .replace(':applicationId', applicationId)
    .replace(':organizationId', 'acct_owner')
    .replace(/:[A-Za-z]+/g, 'x_1');
  const res = await fetch(`${baseUrl}${url}?environment=development`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    code = undefined;
  }
  return { status: res.status, code };
}

describe.skipIf(!POSTGRES_TESTS_ENABLED)('every application-scoped user route', () => {
  test('is covered by the policy', () => {
    // Vacuity floor: a walk that found nothing would pass every assertion.
    expect(surface.length).toBeGreaterThanOrEqual(210);
    expect(surface.filter((route) => route.action === undefined)).toEqual([]);
  });

  test('refuses a member without the action’s permission, and admits one with it', async () => {
    const wrong: string[] = [];
    for (const { method, path, action } of surface) {
      if (!action) continue;
      const lacking = EVERY_DASHBOARD_PERMISSION.filter((p) => !allowsDashboardAction([p], action));
      const refused = await send(method, path, lacking);
      if (refused.status !== 403 || refused.code !== 'permission_required') {
        wrong.push(`${method} ${path} without ${action}: ${refused.status} ${refused.code}`);
      }
      const holding = ['app:read', DASHBOARD_PERMISSIONS[action]];
      const admitted = await send(method, path, holding);
      if (admitted.status === 403 || admitted.status === 401 || admitted.status === 503) {
        wrong.push(`${method} ${path} with ${action}: ${admitted.status} ${admitted.code}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('a read needs nothing beyond membership; a write asks Oxy afresh', async () => {
    access.asked.length = 0;
    expect((await send('GET', `${DASHBOARD}/payment_intents`, ['app:read'])).status).toBe(404);
    expect((await send('POST', `${DASHBOARD}/payouts`, ['app:read'])).code).toBe(
      'permission_required',
    );
    expect(access.asked.map((q) => q.fresh)).toEqual([false, true]);
  });

  test('an upload needs what its purpose is used for', async () => {
    const logo = { purpose: 'business_logo', oxy_file: 'file_1' };
    const evidence = { purpose: 'dispute_evidence', oxy_file: 'file_1' };
    const files = `${DASHBOARD}/files`;
    expect((await send('POST', files, ['app:read', 'app:update'], logo)).status).toBe(404);
    expect((await send('POST', files, ['app:read', 'app:update'], evidence)).code).toBe(
      'permission_required',
    );
    expect((await send('POST', files, ['app:read', 'billing:manage'], evidence)).status).toBe(404);
    expect((await send('POST', files, ['app:read', 'billing:manage'], logo)).code).toBe(
      'permission_required',
    );
  });
});
