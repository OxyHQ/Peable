/**
 * The payer routes answer ANY origin without credentials; every other route
 * keeps the Oxy CORS and refuses a foreign origin (`lib/payerCors.ts`).
 *
 * Walked over the real gateway and EVERY contract, so a new merchant route
 * cannot open up by accident and a new payer route cannot stay closed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { routes, type AnyRoute } from '@peable.to/contracts';
import { createGateway } from '../../server';
import { contractFor, isPayerRoute, PAYER_OPERATIONS } from '../../lib/payerCors';

const FOREIGN = 'https://shop.merchant-example.com';
const OXY = 'https://checkout.peable.to';

const gateway = createGateway();
let base = '';

beforeAll(() => {
  gateway.httpServer.listen(0);
  base = `http://127.0.0.1:${(gateway.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway.io.close();
  gateway.httpServer.close();
});

/** A concrete path for a contract template. */
function concrete(route: AnyRoute): string {
  return route.path.replace(/\{([^}]+)\}/g, (_match, name: string) => `x_${name}123`);
}

function preflight(path: string, method: string, origin: string, headers: string) {
  return fetch(`${base}${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': headers,
    },
  });
}

const payerRoutes = routes.filter((route) => isPayerRoute(route.method, concrete(route)));
const otherRoutes = routes.filter((route) => !isPayerRoute(route.method, concrete(route)));

describe('which routes are payer routes', () => {
  test('every public contract and the four dual-auth payer reads, nothing else', () => {
    const expected = new Set<string>([
      ...routes.filter((route) => route.auth === 'public').map((route) => route.operationId),
      ...PAYER_OPERATIONS,
    ]);
    expect(new Set<string>(payerRoutes.map((route) => route.operationId))).toEqual(expected);
  });

  test('a literal route wins over a parameter (search is not a payment intent)', () => {
    expect(contractFor('GET', '/v1/payment_intents/search')?.operationId).toBe(
      'searchPaymentIntents',
    );
    expect(isPayerRoute('GET', '/v1/payment_intents/search')).toBe(false);
    expect(isPayerRoute('GET', '/v1/payment_intents/pi_123')).toBe(true);
    // The same path, merchant-only under another method.
    expect(isPayerRoute('POST', '/v1/payment_intents/pi_123')).toBe(false);
    expect(isPayerRoute('GET', '/v1/dashboard/applications/app/payment_intents')).toBe(false);
  });
});

describe('a foreign origin', () => {
  test.each(payerRoutes.map((route) => [route.operationId, route] as const))(
    'may call payer route %s, with no credentials',
    async (_id, route) => {
      const response = await preflight(
        concrete(route),
        route.method.toUpperCase(),
        FOREIGN,
        'content-type,x-peable-client-secret,idempotency-key',
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
      const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
      expect(allowed).toContain('x-peable-client-secret');
      expect(allowed).toContain('idempotency-key');
      expect(allowed).not.toContain('authorization');
    },
  );

  test.each(otherRoutes.map((route) => [route.operationId, route] as const))(
    'is refused on non-payer route %s',
    async (_id, route) => {
      const response = await preflight(
        concrete(route),
        route.method.toUpperCase(),
        FOREIGN,
        'authorization,content-type',
      );
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    },
  );

  test('is refused on the dashboard and on a payer route when it sends a credential', async () => {
    for (const [path, method] of [
      ['/v1/dashboard/applications/app_1/payment_intents', 'GET'],
      ['/v1/dashboard/applications/app_1/webhook_endpoints', 'POST'],
      ['/v1/payment_intents', 'POST'],
      ['/v1/customers', 'GET'],
    ] as const) {
      const response = await preflight(path, method, FOREIGN, 'authorization');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    // A merchant's service token on a dual-auth route is not a payer's request.
    const dual = await preflight('/v1/payment_intents/pi_1', 'GET', FOREIGN, 'authorization');
    expect(dual.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const actual = await fetch(`${base}/v1/payment_intents/pi_1`, {
      headers: { Origin: FOREIGN, Authorization: 'Bearer not-a-token' },
    });
    expect(actual.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('reads a payer answer, whatever its status', async () => {
    const response = await fetch(`${base}/v1/checkout_sessions/cs_missing/public`, {
      headers: { Origin: FOREIGN },
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect((response.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase()).toContain(
      'request-id',
    );
  });
});

describe('an Oxy origin', () => {
  test('keeps the Oxy CORS on merchant routes', async () => {
    const response = await preflight('/v1/payment_intents', 'POST', OXY, 'authorization');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(OXY);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('pays like any other origin', async () => {
    const response = await preflight(
      '/v1/checkout_sessions/cs_1/public/confirm',
      'POST',
      OXY,
      'content-type,x-peable-client-secret',
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
