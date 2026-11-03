/**
 * Every answer a route test receives is checked against its contract
 * (ADR 0014 D5) — the round-trip half of "the contract is the source of truth".
 *
 * Preloaded for every `bun test` in this package (`bunfig.toml`), it wraps
 * Express's `res.json` once: when the request matched a route that has a
 * `RouteContract`, a 2xx body must parse with the contract's `response`
 * schema and a 4xx body with the error envelope. The body is checked as the
 * wire carries it (`JSON.parse(JSON.stringify(body))`), so a field a
 * serializer sets to `undefined` counts as absent, exactly as a client sees it.
 *
 * A violation does not change the answer the test asserts on; it fails the
 * test it happened in, naming the route, the status and the first issues.
 * Routes without a contract (the dashboard, a test's own router) are not
 * checked here: `contractCoverage.test.ts` proves which those are.
 */
import { afterEach } from 'bun:test';
import express from 'express';
import type { Request, Response } from 'express';
import {
  type RouteContract,
  errorEnvelopeSchema,
  expressPath,
  isJsonResponse,
  routes,
} from '@peable.to/contracts';

const byRoute = new Map<string, RouteContract>(
  (routes as readonly RouteContract[]).map((route) => [
    `${route.method.toUpperCase()} ${expressPath(route.path)}`,
    route,
  ]),
);

const violations: string[] = [];

function check(req: Request, status: number, body: unknown): void {
  const matched = (req as Request & { route?: { path?: unknown } }).route?.path;
  if (typeof matched !== 'string') return;
  const route = byRoute.get(`${req.method} ${req.baseUrl}${matched}`);
  if (!route) return;
  // A test's own catch-all 500 handler, or an internal error: not the route's answer.
  if (status >= 500) return;
  const wire: unknown = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
  const schema =
    status >= 200 && status < 300
      ? isJsonResponse(route.response)
        ? route.response
        : null
      : errorEnvelopeSchema;
  if (schema === null) return;
  const parsed = schema.safeParse(wire);
  if (parsed.success) return;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `    ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  violations.push(
    `${req.method} ${req.originalUrl} → ${String(status)} does not match the contract of ${route.operationId}:\n${issues}`,
  );
}

const responsePrototype = express.response as Response & { __peableContractChecked?: true };
if (!responsePrototype.__peableContractChecked) {
  const original = responsePrototype.json;
  responsePrototype.json = function json(this: Response, body?: unknown) {
    check(this.req, this.statusCode, body);
    return original.call(this, body);
  };
  responsePrototype.__peableContractChecked = true;
}

afterEach(() => {
  if (violations.length === 0) return;
  const found = violations.splice(0);
  throw new Error(`Contract violations (ADR 0014 D5):\n${found.join('\n')}`);
});
