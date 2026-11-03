/**
 * The contracts and the mounted gateway are the SAME set of routes (ADR 0014
 * D5).
 *
 * Every public route Express serves has a `RouteContract` in
 * `@peable.to/contracts` (so it is validated with the contract's schemas, in
 * the OpenAPI document and in the SDK), and every contract names a route that
 * is actually mounted. The dashboard's routes (`/v1/dashboard/…`) are Orbit's
 * private surface and are not contracts; neither are the infrastructure
 * routes below.
 */
import { afterAll, expect, test } from 'bun:test';
import { expressPath, routes } from '@peable.to/contracts';
import { createGateway } from '../server';

/** Mounted, deliberately not public API: probes, the document itself, inbound provider webhooks. */
const INFRASTRUCTURE = new Set([
  'GET /health',
  'GET /ready',
  'GET /openapi.json',
  'POST /v1/webhooks/stripe',
  'POST /v1/webhooks/stripe/connect',
  'POST /v1/webhooks/oxy/files',
]);

const gateway = createGateway();

afterAll(() => {
  gateway.io.close();
});

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
}

function mounted(): Set<string> {
  const found = new Set<string>();
  const walk = (stack: readonly Layer[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods))
          found.add(`${method.toUpperCase()} ${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  const app = gateway.app as unknown as { _router: { stack: Layer[] } };
  walk(app._router.stack);
  return found;
}

const contracted = new Set(
  routes.map((route) => `${route.method.toUpperCase()} ${expressPath(route.path)}`),
);

test('every contract names a mounted route', () => {
  const served = mounted();
  expect([...contracted].filter((key) => !served.has(key))).toEqual([]);
});

test('every mounted public route has a contract', () => {
  const uncontracted = [...mounted()].filter(
    (key) => !INFRASTRUCTURE.has(key) && !key.includes(' /v1/dashboard/') && !contracted.has(key),
  );
  expect(uncontracted).toEqual([]);
});

test('no two contracts declare the same operation', () => {
  const ids = routes.map((route) => route.operationId);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
});
